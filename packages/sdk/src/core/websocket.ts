import { getLogger } from './logger.js';
import type { TokenProvider } from './http.js';
import type { EventMap, NewioEvent } from './events.js';
import type { ActivityStatus } from './types.js';

/** WebSocket connection state. */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Reason codes for server-initiated connection rejection. */
export type ConnectionRejectedReason = 'CONNECTION_LIMIT_EXCEEDED';

/** Sent by the server immediately before closing a connection that was rejected post-handshake. */
export interface ConnectionRejected {
  readonly action: 'connection.rejected';
  readonly reason: ConnectionRejectedReason;
}

/** Listener for connection state changes. */
export type ConnectionStateListener = (state: ConnectionState) => void;

/** Subscribe/unsubscribe ack from the server. */
export interface SubscribeAck {
  readonly action: 'subscribe_ack';
  readonly subscribed: readonly OnDemandTopic[];
  readonly errors: readonly SubscriptionError[];
}

/** Unsubscribe ack from the server. */
export interface UnsubscribeAck {
  readonly action: 'unsubscribe_ack';
  readonly unsubscribed: readonly OnDemandTopic[];
}

/** On-demand topic prefix. */
export type OnDemandTopicPrefix = 'conv_ondemand';

/** On-demand topic string (e.g. `conv_ondemand:{conversationId}`). */
export type OnDemandTopic = `${OnDemandTopicPrefix}:${string}`;

/** Error returned when a subscription fails. */
export interface SubscriptionError {
  readonly topic: string;
  readonly code: 'FORBIDDEN' | 'INVALID_TOPIC' | 'LIMIT_EXCEEDED';
}

/**
 * Minimal WebSocket interface — allows injecting a mock in tests.
 * Compatible with both browser `WebSocket` and Node.js `ws`.
 */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
  send(data: string): void;
  readonly readyState: number;
}

/** Factory function to create a WebSocket instance. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Keepalive interval: 5 minutes. */
const KEEPALIVE_MS = 5 * 60 * 1000;
/** Default proactive reconnect before API Gateway 2-hour hard limit. */
const DEFAULT_PROACTIVE_RECONNECT_MS = 110 * 60 * 1000;
/** Overlap period after proactive reconnect — keeps old connection alive while backend subscribes the new one. */
const PROACTIVE_OVERLAP_MS = 5000;
/** Backoff config. */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

const log = getLogger('websocket');

/**
 * WebSocket client for Newio real-time events.
 *
 * Features:
 * - JWT auth via `?token=` query param on connect
 * - Auto-reconnect with exponential backoff (1s → 30s cap)
 * - Keepalive ping every 5 minutes
 * - Proactive reconnect at ~1h50m (avoids API Gateway 2-hour hard disconnect)
 * - Typed event handlers via `on()` / `off()`
 * - On-demand topic subscribe/unsubscribe
 *
 * @example
 * ```ts
 * const ws = new NewioWebSocket({
 *   url: 'wss://ws.newio.dev',
 *   tokenProvider: auth.tokenProvider,
 * });
 *
 * ws.on('message.new', (event) => {
 *   console.log('New message:', event.payload);
 * });
 *
 * await ws.connect();
 * ```
 */
export class NewioWebSocket {
  private ws: WebSocketLike | null = null;
  private state: ConnectionState = 'disconnected';
  private backoff = INITIAL_BACKOFF_MS;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private proactiveReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private intentionalClose = false;
  private rejected = false;

  private readonly wsUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly wsFactory: WebSocketFactory;
  private readonly proactiveReconnectMs: number;
  private readonly stateListeners: ConnectionStateListener[] = [];
  private readonly eventHandlers = new Map<string, Set<(event: never) => void>>();
  private onSubscribeAckHandler: ((ack: SubscribeAck) => void) | null = null;
  private onUnsubscribeAckHandler: ((ack: UnsubscribeAck) => void) | null = null;
  private onConnectionRejectedHandler: ((reason: ConnectionRejectedReason) => void) | null = null;

  constructor(opts: {
    url: string;
    tokenProvider: TokenProvider;
    wsFactory?: WebSocketFactory;
    /** Override the proactive reconnect interval (default: 1h50m). Useful for testing. */
    proactiveReconnectMs?: number;
  }) {
    this.wsUrl = opts.url;
    this.tokenProvider = opts.tokenProvider;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.proactiveReconnectMs = opts.proactiveReconnectMs ?? DEFAULT_PROACTIVE_RECONNECT_MS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Open the WebSocket connection. */
  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.rejected = false;
    log.info('WebSocket connecting...');
    await this.doConnect();
  }

  /** Close the WebSocket connection. Does not auto-reconnect. */
  disconnect(): void {
    log.info('WebSocket disconnecting (intentional).');
    this.intentionalClose = true;
    this.cleanup();
    this.setState('disconnected');
  }

  /** Get the current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Register a listener for connection state changes. */
  onStateChange(listener: ConnectionStateListener): void {
    this.stateListeners.push(listener);
  }

  /** Remove a connection state listener. */
  offStateChange(listener: ConnectionStateListener): void {
    const idx = this.stateListeners.indexOf(listener);
    if (idx !== -1) {
      this.stateListeners.splice(idx, 1);
    }
  }

  /** Register a typed event handler. */
  on<T extends keyof EventMap>(type: T, handler: (event: EventMap[T]) => void): void {
    let handlers = this.eventHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(type, handlers);
    }
    handlers.add(handler as (event: never) => void);
  }

  /** Remove a typed event handler. */
  off<T extends keyof EventMap>(type: T, handler: (event: EventMap[T]) => void): void {
    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      handlers.delete(handler as (event: never) => void);
    }
  }

  /** Set handler for subscribe acknowledgments. */
  setOnSubscribeAck(handler: ((ack: SubscribeAck) => void) | null): void {
    this.onSubscribeAckHandler = handler;
  }

  /** Set handler for unsubscribe acknowledgments. */
  setOnUnsubscribeAck(handler: ((ack: UnsubscribeAck) => void) | null): void {
    this.onUnsubscribeAckHandler = handler;
  }

  /**
   * Set handler for server-initiated connection rejection.
   * When fired, auto-reconnect is stopped. Call `connect()` to retry manually.
   */
  setOnConnectionRejected(handler: ((reason: ConnectionRejectedReason) => void) | null): void {
    this.onConnectionRejectedHandler = handler;
  }

  /** Subscribe to on-demand topics. */
  subscribe(topics: readonly OnDemandTopic[]): void {
    if (this.ws && this.state === 'connected') {
      log.debug(`Subscribing to topics: ${topics.join(', ')}`);
      this.ws.send(JSON.stringify({ action: 'subscribe', topics }));
    }
  }

  /** Unsubscribe from on-demand topics. */
  unsubscribe(topics: readonly OnDemandTopic[]): void {
    if (this.ws && this.state === 'connected') {
      log.debug(`Unsubscribing from topics: ${topics.join(', ')}`);
      this.ws.send(JSON.stringify({ action: 'unsubscribe', topics }));
    }
  }

  /** Send an ephemeral activity status (typing, thinking, etc.) to a conversation. */
  sendActivity(conversationId: string, status: ActivityStatus): void {
    if (this.ws && this.state === 'connected') {
      this.ws.send(JSON.stringify({ action: 'activity', conversationId, status }));
    } else {
      log.warn(`sendActivity('${status}') dropped — WebSocket not connected (state=${this.state}).`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    this.cleanup();
    this.setState('connecting');

    const token = await this.tokenProvider();
    const url = `${this.wsUrl}?token=${encodeURIComponent(token)}`;
    const ws = this.wsFactory(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        log.info('WebSocket connected.');
        this.setState('connected');
        this.onWsConnected();
        resolve();
      };

      ws.onclose = () => {
        this.cleanup();
        if (!this.intentionalClose) {
          log.warn('WebSocket closed unexpectedly — will auto-reconnect.');
          this.setState('disconnected');
          if (!this.rejected) {
            this.scheduleReconnect();
          }
        }
        reject(new Error('WebSocket closed before open'));
      };

      ws.onerror = () => {
        log.warn('WebSocket error during connect.');
        // onclose fires after onerror — rejection handled there
      };
    });

    ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };
  }

  /** Create a new WebSocket instance with a fresh token. */
  private async createWs(): Promise<WebSocketLike> {
    const token = await this.tokenProvider();
    const url = `${this.wsUrl}?token=${encodeURIComponent(token)}`;
    return this.wsFactory(url);
  }

  /** Wait for a WebSocket to open, with a 10-second timeout. Rejects on error/close/timeout. */
  private waitForOpen(ws: WebSocketLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.detachWs(ws);
        reject(new Error('timeout'));
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('connection error'));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        reject(new Error('closed before open'));
      };
    });
  }

  /** Wire onmessage, onclose, and onerror handlers onto a WebSocket. */
  private wireWsHandlers(ws: WebSocketLike): void {
    ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };
    ws.onclose = () => {
      log.warn('WebSocket closed unexpectedly — will auto-reconnect.');
      this.cleanup();
      if (!this.intentionalClose) {
        this.setState('disconnected');
        if (!this.rejected) {
          this.scheduleReconnect();
        }
      }
    };
    ws.onerror = () => {
      // onclose will fire after onerror — reconnect handled there
    };
  }

  /** Post-open setup: reset backoff, start keepalive, schedule next proactive reconnect. */
  private onWsConnected(): void {
    this.backoff = INITIAL_BACKOFF_MS;
    this.startKeepalive();
    this.scheduleProactiveReconnect();
  }

  /** Detach all handlers from a WebSocket and close it. */
  private detachWs(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private handleMessage(data: unknown): void {
    try {
      const parsed: Record<string, unknown> =
        typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : (data as Record<string, unknown>);

      // Ack messages use 'action' field
      if (typeof parsed['action'] === 'string') {
        if (parsed['action'] === 'subscribe_ack') {
          log.debug('Received subscribe_ack.');
          this.onSubscribeAckHandler?.(parsed as unknown as SubscribeAck);
        } else if (parsed['action'] === 'unsubscribe_ack') {
          log.debug('Received unsubscribe_ack.');
          this.onUnsubscribeAckHandler?.(parsed as unknown as UnsubscribeAck);
        } else if (parsed['action'] === 'connection.rejected') {
          const reason = parsed['reason'] as ConnectionRejectedReason;
          log.warn(`Connection rejected by server: ${reason}`);
          this.rejected = true;
          this.onConnectionRejectedHandler?.(reason);
        }
        return;
      }

      // Event messages use 'type' field
      const type = parsed['type'];
      if (typeof type !== 'string') {
        return;
      }

      log.debug(`WS event: ${type}`);

      const handlers = this.eventHandlers.get(type);
      if (handlers) {
        const event = parsed as unknown as NewioEvent;
        for (const handler of handlers) {
          handler(event as never);
        }
      }
    } catch {
      log.warn('Failed to parse WebSocket message.');
    }
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.state === 'connected') {
        try {
          this.ws.send(JSON.stringify({ action: 'ping' }));
        } catch {
          log.warn('Keepalive ping failed.');
          // Will trigger onclose → reconnect
        }
      }
    }, KEEPALIVE_MS);
  }

  /**
   * Seamless proactive reconnect: opens a new connection first, then closes the old one.
   * Both connections receive events during the overlap window — consumers already
   * deduplicate via event handlers. If the new connection gets rejected (e.g. connection
   * limit exceeded), we abandon it and keep using the old connection — it will eventually
   * hit the 2h hard limit and normal auto-reconnect kicks in.
   */
  private scheduleProactiveReconnect(): void {
    log.debug(`Scheduling proactive reconnect in ${Math.round(this.proactiveReconnectMs / 60000)}min.`);
    this.proactiveReconnectTimer = setTimeout(() => {
      if (this.intentionalClose) {
        return;
      }
      void this.doProactiveReconnect();
    }, this.proactiveReconnectMs);
  }

  private async doProactiveReconnect(): Promise<void> {
    log.info('Proactive reconnect starting — opening new connection before closing old.');
    const oldWs = this.ws;

    try {
      const newWs = await this.createWs();
      await this.waitForOpen(newWs);

      log.info('Proactive reconnect — new connection open, entering overlap period.');
      // New connection is open — wire it up and keep old alive during overlap
      // so events are received on both while backend subscribes the new connectionId.
      if (oldWs) {
        oldWs.onclose = null;
        oldWs.onerror = null;
        oldWs.onopen = null;
      }
      this.clearTimers();
      this.ws = newWs;
      this.wireWsHandlers(newWs);
      // Route events from old WS to handlers during overlap
      if (oldWs) {
        oldWs.onmessage = (ev) => {
          this.handleMessage(ev.data);
        };
      }
      this.onWsConnected();

      // Close old connection after overlap period
      if (oldWs) {
        setTimeout(() => {
          log.info('Proactive reconnect — overlap complete, closing old connection.');
          oldWs.onmessage = null;
          try {
            oldWs.close();
          } catch {
            /* ignore */
          }
        }, PROACTIVE_OVERLAP_MS);
      }
    } catch (err) {
      // New connection failed — keep using old connection.
      // It will eventually hit the 2h hard limit and normal auto-reconnect kicks in.
      log.warn(
        `Proactive reconnect failed (${err instanceof Error ? err.message : 'unknown'}) — keeping old connection.`,
      );
    }
  }

  private scheduleReconnect(): void {
    log.info(`Scheduling reconnect in ${this.backoff}ms.`);
    this.reconnectTimer = setTimeout(() => {
      void this.doConnect().catch(() => {});
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  /** Clear all timers (keepalive, reconnect, proactive reconnect). */
  private clearTimers(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.proactiveReconnectTimer !== undefined) {
      clearTimeout(this.proactiveReconnectTimer);
      this.proactiveReconnectTimer = undefined;
    }
  }

  private cleanup(): void {
    if (this.ws) {
      this.detachWs(this.ws);
      this.ws = null;
    }
    this.clearTimers();
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) {
      return;
    }
    this.state = newState;
    for (const listener of this.stateListeners) {
      listener(newState);
    }
  }
}
