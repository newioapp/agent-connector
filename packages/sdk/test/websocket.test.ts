import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewioWebSocket, type WebSocketLike } from '../src/core/websocket.js';
import { ConnectionRejectedError } from '../src/core/errors.js';

/** Creates a mock WebSocket that exposes trigger methods. */
function createMockWs() {
  const ws: WebSocketLike & {
    triggerOpen: () => void;
    triggerClose: () => void;
    triggerMessage: (data: unknown) => void;
    triggerError: () => void;
    triggerOpenAndAccept: () => void;
    sent: string[];
  } = {
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    readyState: 1,
    sent: [],
    close: vi.fn(),
    send: vi.fn((data: string) => {
      ws.sent.push(data);
    }),
    triggerOpen() {
      ws.onopen?.(null);
    },
    triggerClose() {
      ws.onclose?.(null);
    },
    triggerMessage(data: unknown) {
      ws.onmessage?.({ data });
    },
    triggerError() {
      ws.onerror?.(null);
    },
    triggerOpenAndAccept() {
      ws.triggerOpen();
      queueMicrotask(() => ws.triggerMessage(JSON.stringify({ action: 'connection.accepted' })));
    },
  };
  return ws;
}

function createClient(mockWs: ReturnType<typeof createMockWs>, autoOpen = true) {
  return new NewioWebSocket({
    url: 'wss://ws.test',
    tokenProvider: () => 'test-token',
    wsFactory: (url) => {
      mockWs.sent.push(`CONNECT:${url}`);
      if (autoOpen) {
        // waitForReady sets ws.onopen synchronously, so triggerOpen fires after it's set.
        // Inside onopen, ws.onmessage is set synchronously, so the nested microtask fires after that.
        queueMicrotask(() => mockWs.triggerOpenAndAccept());
      }
      return mockWs;
    },
  });
}

describe('NewioWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connect / disconnect', () => {
    it('should connect with token in URL', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();
      expect(ws.sent[0]).toBe('CONNECT:wss://ws.test?token=test-token');
      expect(client.getState()).toBe('connected');

      client.disconnect();
      expect(client.getState()).toBe('disconnected');
      expect(ws.close).toHaveBeenCalled();
    });

    it('should notify state listeners', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      await client.connect();
      client.disconnect();

      expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    });

    it('should remove state listener with offStateChange', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      const states: string[] = [];
      const listener = (s: string) => states.push(s);
      client.onStateChange(listener);
      client.offStateChange(listener);

      await client.connect();
      expect(states).toEqual([]);
      client.disconnect();
    });
  });

  describe('event handlers', () => {
    it('should dispatch typed events via on()', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      const messages: unknown[] = [];
      client.on('message.new', (event) => {
        messages.push(event.payload);
      });

      ws.triggerMessage(
        JSON.stringify({
          type: 'message.new',
          timestamp: '2026-01-01T00:00:00Z',
          payload: { messageId: 'm1', conversationId: 'c1' },
        }),
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ messageId: 'm1', conversationId: 'c1' });

      client.disconnect();
    });

    it('should support multiple handlers for same event', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      let count = 0;
      client.on('message.new', () => count++);
      client.on('message.new', () => count++);

      ws.triggerMessage(JSON.stringify({ type: 'message.new', timestamp: '', payload: {} }));
      expect(count).toBe(2);

      client.disconnect();
    });

    it('should remove handler with off()', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      let count = 0;
      const handler = () => count++;
      client.on('message.new', handler);
      client.off('message.new', handler);

      ws.triggerMessage(JSON.stringify({ type: 'message.new', timestamp: '', payload: {} }));
      expect(count).toBe(0);

      client.disconnect();
    });

    it('should dispatch different event types', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      const events: string[] = [];
      client.on('contact.request_received', () => events.push('request'));
      client.on('conversation.updated', () => events.push('conv'));

      ws.triggerMessage(JSON.stringify({ type: 'contact.request_received', timestamp: '', payload: {} }));
      ws.triggerMessage(JSON.stringify({ type: 'conversation.updated', timestamp: '', payload: {} }));

      expect(events).toEqual(['request', 'conv']);

      client.disconnect();
    });

    it('should ignore malformed messages', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      // Should not throw
      ws.triggerMessage('not json{{{');
      ws.triggerMessage(JSON.stringify({ noType: true }));
      ws.triggerMessage(JSON.stringify({ type: 'unknown.event', payload: {} }));

      client.disconnect();
    });
  });

  describe('subscribe / unsubscribe acks', () => {
    it('should handle subscribe ack', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      let ack: unknown;
      client.setOnSubscribeAck((a) => {
        ack = a;
      });

      ws.triggerMessage(JSON.stringify({ action: 'subscribe_ack', subscribed: ['topic1'], errors: [] }));
      expect(ack).toEqual({ action: 'subscribe_ack', subscribed: ['topic1'], errors: [] });

      client.disconnect();
    });

    it('should handle unsubscribe ack', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      let ack: unknown;
      client.setOnUnsubscribeAck((a) => {
        ack = a;
      });

      ws.triggerMessage(JSON.stringify({ action: 'unsubscribe_ack', unsubscribed: ['topic1'] }));
      expect(ack).toEqual({ action: 'unsubscribe_ack', unsubscribed: ['topic1'] });

      client.disconnect();
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('should send subscribe message', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      client.subscribe(['conv_ondemand:c1']);
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as unknown;
      expect(sent).toEqual({ action: 'subscribe', topics: ['conv_ondemand:c1'] });

      client.disconnect();
    });

    it('should send unsubscribe message', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      client.unsubscribe(['conv_ondemand:c1']);
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as unknown;
      expect(sent).toEqual({ action: 'unsubscribe', topics: ['conv_ondemand:c1'] });

      client.disconnect();
    });

    it('should not send when disconnected', () => {
      const ws = createMockWs();
      const client = createClient(ws);
      client.subscribe(['conv_ondemand:c1']);
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe('keepalive', () => {
    it('should send ping every 5 minutes', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      const initialSent = ws.sent.length;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      const pings = ws.sent.slice(initialSent).filter((s) => s.includes('ping'));
      expect(pings).toHaveLength(1);
      expect(JSON.parse(pings[0]!) as unknown).toEqual({ action: 'ping' });

      client.disconnect();
    });
  });

  describe('auto-reconnect', () => {
    it('should reconnect on unexpected close', async () => {
      const mockWs1 = createMockWs();
      let connectCount = 0;

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          connectCount++;
          queueMicrotask(() => mockWs1.triggerOpenAndAccept());
          return mockWs1;
        },
      });

      await client.connect();
      expect(connectCount).toBe(1);

      // Simulate unexpected close
      mockWs1.triggerClose();
      expect(client.getState()).toBe('disconnected');

      // Advance past backoff (1s initial)
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectCount).toBe(2);

      client.disconnect();
    });

    it('should not reconnect on intentional disconnect', async () => {
      const mockWs1 = createMockWs();
      let connectCount = 0;

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          connectCount++;
          queueMicrotask(() => mockWs1.triggerOpenAndAccept());
          return mockWs1;
        },
      });

      await client.connect();
      client.disconnect();

      await vi.advanceTimersByTimeAsync(5000);
      expect(connectCount).toBe(1);
    });

    it('should use exponential backoff', async () => {
      const mockWs1 = createMockWs();
      let connectCount = 0;

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          connectCount++;
          queueMicrotask(() => mockWs1.triggerOpenAndAccept());
          return mockWs1;
        },
      });

      await client.connect();
      expect(connectCount).toBe(1);

      // First unexpected close → 1s backoff
      mockWs1.triggerClose();
      await vi.advanceTimersByTimeAsync(999);
      expect(connectCount).toBe(1); // Not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(connectCount).toBe(2); // 1s elapsed

      client.disconnect();
    });

    it('should not reconnect after connection.rejected', async () => {
      const mockWs1 = createMockWs();
      let connectCount = 0;
      const rejectedHandler = vi.fn();

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          connectCount++;
          // Send rejected instead of accepted after open
          queueMicrotask(() => {
            mockWs1.triggerOpen();
            queueMicrotask(() =>
              mockWs1.triggerMessage(
                JSON.stringify({ action: 'connection.rejected', reason: 'CONNECTION_LIMIT_EXCEEDED' }),
              ),
            );
          });
          return mockWs1;
        },
      });

      client.setOnConnectionRejected(rejectedHandler);
      // connect() throws on rejection
      await expect(client.connect()).rejects.toThrow(ConnectionRejectedError);
      expect(connectCount).toBe(1);
      expect(rejectedHandler).toHaveBeenCalledWith('CONNECTION_LIMIT_EXCEEDED');

      // Should NOT reconnect
      await vi.advanceTimersByTimeAsync(30_000);
      expect(connectCount).toBe(1);
    });

    it('should retry reconnect with backoff when doConnect fails', async () => {
      const mockWs1 = createMockWs();
      let connectCount = 0;

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          connectCount++;
          if (connectCount === 1) {
            queueMicrotask(() => mockWs1.triggerOpenAndAccept());
          } else {
            // Subsequent attempts fail — close before open
            queueMicrotask(() => mockWs1.triggerClose());
          }
          return mockWs1;
        },
      });

      await client.connect();
      expect(connectCount).toBe(1);

      // Unexpected close → schedules reconnect at 1s
      mockWs1.triggerClose();
      expect(client.getState()).toBe('disconnected');

      // First retry at 1s — fails
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectCount).toBe(2);
      expect(client.getState()).toBe('disconnected');

      // Second retry at 2s (doubled backoff) — also fails
      await vi.advanceTimersByTimeAsync(2000);
      expect(connectCount).toBe(3);
      expect(client.getState()).toBe('disconnected');

      client.disconnect();
    });
  });

  describe('proactive reconnect', () => {
    it('should close old connection on connection.accepted', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();
      expect(wsInstances).toHaveLength(1);

      // Trigger proactive reconnect
      await vi.advanceTimersByTimeAsync(5000);
      expect(wsInstances).toHaveLength(2);

      // New WS opens
      wsInstances[1]!.triggerOpen();
      await vi.advanceTimersByTimeAsync(0);

      // Old WS still alive — waiting for accepted
      expect(wsInstances[0]!.close).not.toHaveBeenCalled();
      expect(client.getState()).toBe('connected');

      // Server sends connection.accepted on new WS
      wsInstances[1]!.triggerMessage(JSON.stringify({ action: 'connection.accepted' }));
      await vi.advanceTimersByTimeAsync(0);

      // Old WS closed immediately
      expect(wsInstances[0]!.close).toHaveBeenCalled();

      client.disconnect();
    });

    it('should revert to old connection on connection.rejected', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();

      // Trigger proactive reconnect and open new WS
      await vi.advanceTimersByTimeAsync(5000);
      wsInstances[1]!.triggerOpen();
      await vi.advanceTimersByTimeAsync(0);

      // Server rejects new connection
      wsInstances[1]!.triggerMessage(
        JSON.stringify({ action: 'connection.rejected', reason: 'CONNECTION_LIMIT_EXCEEDED' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      // New WS closed, old WS kept
      expect(wsInstances[1]!.close).toHaveBeenCalled();
      expect(wsInstances[0]!.close).not.toHaveBeenCalled();
      expect(client.getState()).toBe('connected');

      // Old WS still receives events
      const messages: unknown[] = [];
      client.on('message.new', (event) => {
        messages.push(event.payload);
      });
      wsInstances[0]!.triggerMessage(
        JSON.stringify({ type: 'message.new', timestamp: '', payload: { id: 'still-works' } }),
      );
      expect(messages).toHaveLength(1);

      client.disconnect();
    });

    it('should revert to old connection on timeout if no accepted/rejected received', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();

      // Trigger proactive reconnect and open new WS (but no accepted)
      await vi.advanceTimersByTimeAsync(5000);
      wsInstances[1]!.triggerOpen();
      await vi.advanceTimersByTimeAsync(0);

      // No accepted/rejected — wait for 15s timeout
      expect(wsInstances[0]!.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);

      // New WS closed, old WS kept
      expect(wsInstances[1]!.close).toHaveBeenCalled();
      expect(wsInstances[0]!.close).not.toHaveBeenCalled();
      expect(client.getState()).toBe('connected');

      client.disconnect();
    });

    it('should forward non-accept/reject messages during wait', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      const messages: unknown[] = [];
      client.on('message.new', (event) => {
        messages.push(event.payload);
      });

      await client.connect();

      // Trigger proactive reconnect and open new WS
      await vi.advanceTimersByTimeAsync(5000);
      wsInstances[1]!.triggerOpen();
      await vi.advanceTimersByTimeAsync(0);

      // Regular event arrives on new WS before accepted
      wsInstances[1]!.triggerMessage(
        JSON.stringify({ type: 'message.new', timestamp: '', payload: { id: 'during-wait' } }),
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ id: 'during-wait' });

      // Events from old WS also delivered
      wsInstances[0]!.triggerMessage(
        JSON.stringify({ type: 'message.new', timestamp: '', payload: { id: 'from-old' } }),
      );
      expect(messages).toHaveLength(2);

      // Then accepted arrives
      wsInstances[1]!.triggerMessage(JSON.stringify({ action: 'connection.accepted' }));
      await vi.advanceTimersByTimeAsync(0);

      client.disconnect();
    });

    it('should keep old connection if new connection fails to open', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();

      // Trigger proactive reconnect
      await vi.advanceTimersByTimeAsync(5000);
      expect(wsInstances).toHaveLength(2);

      // New WS fails to connect
      wsInstances[1]!.triggerClose();
      await vi.advanceTimersByTimeAsync(0);

      // State stays connected — old WS still works
      expect(client.getState()).toBe('connected');
      expect(wsInstances[0]!.close).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('should not proactive reconnect after intentional disconnect', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();
      client.disconnect();

      await vi.advanceTimersByTimeAsync(5000);
      expect(wsInstances).toHaveLength(1);
    });

    it('should schedule reconnect when old WS dies and new WS is rejected', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        proactiveReconnectMs: 5000,
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          if (wsInstances.length === 1) {
            queueMicrotask(() => ws.triggerOpenAndAccept());
          }
          return ws;
        },
      });

      await client.connect();

      // Trigger proactive reconnect
      await vi.advanceTimersByTimeAsync(5000);
      expect(wsInstances).toHaveLength(2);
      wsInstances[1]!.triggerOpen();
      await vi.advanceTimersByTimeAsync(0);

      // Old WS dies
      wsInstances[0]!.triggerClose();

      // New WS rejected
      wsInstances[1]!.triggerMessage(
        JSON.stringify({ action: 'connection.rejected', reason: 'CONNECTION_LIMIT_EXCEEDED' }),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Both dead — should be disconnected
      expect(client.getState()).toBe('disconnected');
      expect(wsInstances[1]!.close).toHaveBeenCalled();

      // Should schedule reconnect — advance past 1s backoff
      await vi.advanceTimersByTimeAsync(1000);
      expect(wsInstances).toHaveLength(3);

      client.disconnect();
    });

    it('should use default 1h50m when proactiveReconnectMs not specified', async () => {
      const wsInstances: ReturnType<typeof createMockWs>[] = [];

      const client = new NewioWebSocket({
        url: 'wss://ws.test',
        tokenProvider: () => 'test-token',
        wsFactory: () => {
          const ws = createMockWs();
          wsInstances.push(ws);
          queueMicrotask(() => ws.triggerOpenAndAccept());
          return ws;
        },
      });

      await client.connect();
      expect(wsInstances).toHaveLength(1);

      // Not yet at 1h50m
      await vi.advanceTimersByTimeAsync(109 * 60 * 1000);
      expect(wsInstances).toHaveLength(1);

      // At 1h50m
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(wsInstances).toHaveLength(2);

      client.disconnect();
    });
  });

  describe('sendActivity', () => {
    it('should send activity when connected', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();

      client.sendActivity('conv-1', 'typing');
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as unknown;
      expect(sent).toEqual({ action: 'activity', conversationId: 'conv-1', status: 'typing' });

      client.disconnect();
    });

    it('should not send activity when disconnected', () => {
      const ws = createMockWs();
      const client = createClient(ws, false);
      client.sendActivity('conv-1', 'typing');
      // Only the CONNECT message should be absent since we never connected
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe('setState no-op', () => {
    it('should not fire listener when state is unchanged', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      const states: string[] = [];
      client.onStateChange((s) => states.push(s));

      await client.connect();
      expect(states).toEqual(['connecting', 'connected']);

      // Trigger open again — state is already 'connected'
      ws.triggerOpen();
      expect(states).toEqual(['connecting', 'connected']); // no duplicate

      client.disconnect();
    });
  });
});
