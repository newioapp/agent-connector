import type { TokenProvider } from './http.js';
import type { EventMap, NewioEvent } from './events.js';
import type { ActivityStatus } from './types.js';

/** WebSocket connection state. */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

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
/** Proactive reconnect before API Gateway 2-hour hard limit. */
const PROACTIVE_RECONNECT_MS = 110 * 60 * 1000;
/** Backoff config. */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

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

  private readonly wsUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly wsFactory: WebSocketFactory;
  private readonly stateListeners: ConnectionStateListener[] = [];
  private readonly eventHandlers = new Map<string, Set<(event: never) => void>>();
  private onSubscribeAckHandler: ((ack: SubscribeAck) => void) | null = null;
  private onUnsubscribeAckHandler: ((ack: UnsubscribeAck) => void) | null = null;

  constructor(opts: { url: string; tokenProvider: TokenProvider; wsFactory?: WebSocketFactory }) {
    this.wsUrl = opts.url;
    this.tokenProvider = opts.tokenProvider;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Open the WebSocket connection. */
  async connect(): Promise<void> {
    this.intentionalClose = false;
    await this.doConnect();
  }

  /** Close the WebSocket connection. Does not auto-reconnect. */
  disconnect(): void {
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

  /** Subscribe to on-demand topics. */
  subscribe(topics: readonly OnDemandTopic[]): void {
    if (this.ws && this.state === 'connected') {
      this.ws.send(JSON.stringify({ action: 'subscribe', topics }));
    }
  }

  /** Unsubscribe from on-demand topics. */
  unsubscribe(topics: readonly OnDemandTopic[]): void {
    if (this.ws && this.state === 'connected') {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', topics }));
    }
  }

  /** Send an ephemeral activity status (typing, thinking, etc.) to a conversation. */
  sendActivity(conversationId: string, status: ActivityStatus): void {
    if (this.ws && this.state === 'connected') {
      this.ws.send(JSON.stringify({ action: 'activity', conversationId, status }));
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
        this.setState('connected');
        this.backoff = INITIAL_BACKOFF_MS;
        this.startKeepalive();
        this.scheduleProactiveReconnect();
        resolve();
      };

      ws.onclose = () => {
        this.cleanup();
        if (!this.intentionalClose) {
          this.setState('disconnected');
          this.scheduleReconnect();
        }
        reject(new Error('WebSocket closed before open'));
      };

      ws.onerror = () => {
        // onclose fires after onerror — rejection handled there
      };
    });

    ws.onmessage = (ev) => {
      this.handleMessage(ev.data);
    };
  }

  private handleMessage(data: unknown): void {
    try {
      const parsed: Record<string, unknown> =
        typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : (data as Record<string, unknown>);

      // Ack messages use 'action' field
      if (typeof parsed['action'] === 'string') {
        if (parsed['action'] === 'subscribe_ack') {
          this.onSubscribeAckHandler?.(parsed as unknown as SubscribeAck);
        } else if (parsed['action'] === 'unsubscribe_ack') {
          this.onUnsubscribeAckHandler?.(parsed as unknown as UnsubscribeAck);
        }
        return;
      }

      // Event messages use 'type' field
      const type = parsed['type'];
      if (typeof type !== 'string') {
        return;
      }

      const handlers = this.eventHandlers.get(type);
      if (handlers) {
        const event = parsed as unknown as NewioEvent;
        for (const handler of handlers) {
          handler(event as never);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.state === 'connected') {
        try {
          this.ws.send(JSON.stringify({ action: 'ping' }));
        } catch {
          // Will trigger onclose → reconnect
        }
      }
    }, KEEPALIVE_MS);
  }

  private scheduleProactiveReconnect(): void {
    this.proactiveReconnectTimer = setTimeout(() => {
      if (!this.intentionalClose) {
        void this.doConnect().catch(() => {});
      }
    }, PROACTIVE_RECONNECT_MS);
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      void this.doConnect().catch(() => {});
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
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
