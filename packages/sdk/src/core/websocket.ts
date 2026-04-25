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
/** Timeout waiting for connection.accepted during proactive reconnect. Falls back to closing old connection. */
const PROACTIVE_ACCEPT_TIMEOUT_MS = 15_000;
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

    const result = await this.waitForReady(ws);

    if (result === 'rejected') {
      log.warn('WebSocket connection rejected during initial connect.');
      this.rejected = true;
      this.onConnectionRejectedHandler?.('CONNECTION_LIMIT_EXCEEDED');
      this.detachWs(ws);
      throw new Error('connection rejected');
    }

    log.info(result === 'accepted' ? 'WebSocket ready (accepted).' : 'WebSocket ready (accept timeout, proceeding).');
    this.setState('connected');
    this.wireWsHandlers(ws);
    this.onWsConnected();
  }

  /** Create a new WebSocket instance with a fresh token. */
  private async createWs(): Promise<WebSocketLike> {
    const token = await this.tokenProvider();
    const url = `${this.wsUrl}?token=${encodeURIComponent(token)}`;
    return this.wsFactory(url);
  }

  /**
   * Wait for a WebSocket to open and receive `connection.accepted` or `connection.rejected`.
   * Resolves with 'accepted' or 'rejected'. Rejects on timeout or connection failure.
   * Messages received between open and accepted/rejected are forwarded to handleMessage.
   */
  private waitForReady(ws: WebSocketLike): Promise<'accepted' | 'rejected' | 'timeout'> {
    return new Promise<'accepted' | 'rejected' | 'timeout'>((resolve, reject) => {
      let opened = false;

      const timeout = setTimeout(() => {
        log.warn(`WebSocket ready timeout after ${PROACTIVE_ACCEPT_TIMEOUT_MS}ms (opened=${String(opened)}).`);
        resolve('timeout');
      }, PROACTIVE_ACCEPT_TIMEOUT_MS);

      ws.onopen = () => {
        opened = true;
        log.info('WebSocket connected, waiting for subscription setup.');
      };
      ws.onmessage = (ev) => {
        if (!opened) {
          return;
        }
        try {
          const parsed: Record<string, unknown> =
            typeof ev.data === 'string'
              ? (JSON.parse(ev.data) as Record<string, unknown>)
              : (ev.data as Record<string, unknown>);

          if (parsed['action'] === 'connection.accepted') {
            clearTimeout(timeout);
            resolve('accepted');
            return;
          }
          if (parsed['action'] === 'connection.rejected') {
            clearTimeout(timeout);
            resolve('rejected');
            return;
          }
        } catch (err) {
          log.warn(
            `Failed to parse message while waiting for accept/reject: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        }
        this.handleMessage(ev.data);
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        reject(new Error(opened ? 'closed before ready' : 'closed before open'));
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('connection error'));
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
   * Seamless proactive reconnect: opens a new connection first, waits for the server
   * to confirm subscription setup (`connection.accepted`), then closes the old one.
   * If the server rejects or the accept times out, reverts to the old connection.
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

      // If old WS dies during the wait, abandon proactive reconnect and let normal reconnect handle it
      const oldWsState = { died: false };
      if (oldWs) {
        oldWs.onclose = () => {
          log.warn('Proactive reconnect — old connection died during wait.');
          oldWsState.died = true;
        };
        oldWs.onerror = null;
        oldWs.onopen = null;
      }

      const result = await this.waitForReady(newWs);

      if (oldWsState.died) {
        // Old WS is gone — just use the new one regardless of result
        log.info('Proactive reconnect — old connection died, using new connection.');
        this.clearTimers();
        this.ws = newWs;
        this.wireWsHandlers(newWs);
        this.onWsConnected();
      } else if (result === 'accepted') {
        log.info('Proactive reconnect — connection accepted, closing old connection.');
        this.clearTimers();
        this.ws = newWs;
        this.wireWsHandlers(newWs);
        this.onWsConnected();
        if (oldWs) {
          oldWs.onmessage = null;
          oldWs.onclose = null;
          try {
            oldWs.close();
          } catch {
            /* ignore */
          }
        }
      } else {
        // Rejected or timeout — revert to old connection
        log.warn(`Proactive reconnect — ${result}, reverting to old connection.`);
        this.detachWs(newWs);
        if (oldWs) {
          this.clearTimers();
          this.ws = oldWs;
          this.wireWsHandlers(oldWs);
          this.onWsConnected();
        }
      }
    } catch (err) {
      // New connection failed to open — keep using old connection.
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
