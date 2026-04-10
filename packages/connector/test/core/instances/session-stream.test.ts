import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStream } from '../../../src/core/instances/session-stream';
import type { SessionStatusListener } from '../../../src/core/agent-session';

function makeUpdate(type: string, text?: string) {
  const update: Record<string, unknown> = { sessionUpdate: type };
  if (text !== undefined) {
    update.content = { type: 'text', text };
  }
  return { update } as never;
}

describe('SessionStream', () => {
  let statusListener: SessionStatusListener;
  let statuses: string[];

  beforeEach(() => {
    statuses = [];
    statusListener = (s) => statuses.push(s);
  });

  it('aggregates consecutive chunks of the same type', async () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'Hello '));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'world'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    expect(segments).toEqual([{ type: 'agent_message_chunk', text: 'Hello world' }]);
  });

  it('flushes when type changes', async () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate(makeUpdate('agent_thought_chunk', 'thinking...'));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'result'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: 'agent_thought_chunk', text: 'thinking...' });
    expect(segments[1]).toEqual({ type: 'agent_message_chunk', text: 'result' });
  });

  it('handles updates without text content', async () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate(makeUpdate('tool_call'));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'done'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: 'tool_call', text: '' });
    expect(segments[1]).toEqual({ type: 'agent_message_chunk', text: 'done' });
  });

  it('emits status changes based on update type', () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'hi'));
    stream.handleSessionUpdate(makeUpdate('agent_thought_chunk', 'hmm'));
    stream.handleSessionUpdate(makeUpdate('tool_call'));
    stream.handleSessionUpdate(makeUpdate('tool_call_update'));
    stream.handleSessionUpdate(makeUpdate('plan'));
    stream.finish();

    expect(statuses).toEqual(['typing', 'thinking', 'tool_calling', 'tool_calling']);
  });

  it('finish is idempotent', async () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'hi'));
    stream.finish();
    stream.finish(); // second call should be no-op

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toHaveLength(1);
  });

  it('yields nothing when no updates before finish', async () => {
    const stream = new SessionStream(statusListener);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toHaveLength(0);
  });

  it('handles non-text content gracefully', async () => {
    const stream = new SessionStream(statusListener);

    // Content with non-text type
    stream.handleSessionUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
    } as never);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toEqual([{ type: 'agent_message_chunk', text: '' }]);
  });

  it('handles content with non-string text gracefully', async () => {
    const stream = new SessionStream(statusListener);

    stream.handleSessionUpdate({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 123 } },
    } as never);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    // text is not a string, so it should be treated as no text
    expect(segments).toEqual([{ type: 'agent_message_chunk', text: '' }]);
  });

  it('segments() awaits when no data is ready', async () => {
    const stream = new SessionStream(statusListener);

    const segments: { type: string; text: string }[] = [];
    const consumer = (async () => {
      for await (const s of stream.segments()) {
        segments.push(s);
      }
    })();

    // Let the consumer start awaiting
    await new Promise((r) => setTimeout(r, 10));
    expect(segments).toHaveLength(0);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'delayed'));
    stream.finish();

    await consumer;
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('delayed');
  });
});
