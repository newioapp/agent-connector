import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewioWebSocket, type WebSocketLike } from '../src/websocket.js';

/** Creates a mock WebSocket that exposes trigger methods. */
function createMockWs() {
  const ws: WebSocketLike & {
    triggerOpen: () => void;
    triggerClose: () => void;
    triggerMessage: (data: unknown) => void;
    triggerError: () => void;
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
  };
  return ws;
}

function createClient(mockWs: ReturnType<typeof createMockWs>) {
  return new NewioWebSocket({
    url: 'wss://ws.test',
    tokenProvider: () => 'test-token',
    wsFactory: (url) => {
      mockWs.sent.push(`CONNECT:${url}`);
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
      expect(client.getState()).toBe('connecting');

      ws.triggerOpen();
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
      ws.triggerOpen();
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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

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
      ws.triggerOpen();

      client.subscribe(['conv:c1']);
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as unknown;
      expect(sent).toEqual({ action: 'subscribe', topics: ['conv:c1'] });

      client.disconnect();
    });

    it('should send unsubscribe message', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();
      ws.triggerOpen();

      client.unsubscribe(['conv:c1']);
      const sent = JSON.parse(ws.sent[ws.sent.length - 1]!) as unknown;
      expect(sent).toEqual({ action: 'unsubscribe', topics: ['conv:c1'] });

      client.disconnect();
    });

    it('should not send when disconnected', () => {
      const ws = createMockWs();
      const client = createClient(ws);
      client.subscribe(['conv:c1']);
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe('keepalive', () => {
    it('should send ping every 5 minutes', async () => {
      const ws = createMockWs();
      const client = createClient(ws);
      await client.connect();
      ws.triggerOpen();

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
          return mockWs1;
        },
      });

      await client.connect();
      mockWs1.triggerOpen();
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
          return mockWs1;
        },
      });

      await client.connect();
      mockWs1.triggerOpen();
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
          return mockWs1;
        },
      });

      await client.connect();
      mockWs1.triggerOpen();

      // First disconnect → 1s backoff
      mockWs1.triggerClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectCount).toBe(2);

      // Second disconnect → 2s backoff
      mockWs1.triggerClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectCount).toBe(2); // Not yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(connectCount).toBe(3);

      client.disconnect();
    });
  });
});
