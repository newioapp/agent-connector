import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpSessionStream } from '../../src/acp-session-stream';
import type { SessionStatusListener } from '../../src/types';

function makeUpdate(type: string, text?: string) {
  const update: Record<string, unknown> = { sessionUpdate: type };
  if (text !== undefined) {
    update.content = { type: 'text', text };
  }
  return update as never;
}

const SKIP_TOKEN = '_skip';

/** Default isSkipPrefix matching PromptFormatterImpl behavior. */
function defaultIsSkipPrefix(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length === 0) {
    return true;
  }
  return SKIP_TOKEN.startsWith(lower);
}

describe('AcpSessionStream', () => {
  let statusListener: SessionStatusListener;
  let statuses: string[];

  beforeEach(() => {
    statuses = [];
    statusListener = (s) => statuses.push(s);
  });

  it('aggregates consecutive chunks of the same type', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'Hello '));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'world'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    expect(segments).toEqual([
      { type: 'agent_message_chunk', text: 'Hello world', toolCallId: undefined, toolCallStatus: undefined },
    ]);
  });

  it('flushes when type changes', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_thought_chunk', 'thinking...'));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'result'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      type: 'agent_thought_chunk',
      text: 'thinking...',
      toolCallId: undefined,
      toolCallStatus: undefined,
    });
    expect(segments[1]).toEqual({
      type: 'agent_message_chunk',
      text: 'result',
      toolCallId: undefined,
      toolCallStatus: undefined,
    });
  });

  it('handles updates without text content', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('tool_call'));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'done'));
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }

    // tool_call without toolCallId is dropped
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      type: 'agent_message_chunk',
      text: 'done',
    });
  });

  it('emits status changes based on update type', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'hi'));
    stream.handleSessionUpdate(makeUpdate('agent_thought_chunk', 'hmm'));
    stream.handleSessionUpdate(makeUpdate('tool_call'));
    stream.handleSessionUpdate(makeUpdate('tool_call_update'));
    stream.finish();

    expect(statuses).toEqual(['typing', 'thinking', 'tool_calling', 'tool_calling']);
  });

  it('finish is idempotent', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

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
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toHaveLength(0);
  });

  it('handles non-text content gracefully', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image' },
    } as never);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toEqual([
      { type: 'agent_message_chunk', text: '', toolCallId: undefined, toolCallStatus: undefined },
    ]);
  });

  it('handles content with non-string text gracefully', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 123 },
    } as never);
    stream.finish();

    const segments = [];
    for await (const s of stream.segments()) {
      segments.push(s);
    }
    expect(segments).toEqual([
      { type: 'agent_message_chunk', text: '', toolCallId: undefined, toolCallStatus: undefined },
    ]);
  });

  it('segments() awaits when no data is ready', async () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

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

  it('returns false for unknown session update types', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    expect(stream.handleSessionUpdate(makeUpdate('current_mode_update'))).toBe(false);
    expect(stream.handleSessionUpdate(makeUpdate('config_option_update'))).toBe(false);
    expect(stream.handleSessionUpdate(makeUpdate('unknown_type'))).toBe(false);
  });

  it('passes conversationId to status listener', () => {
    const calls: { status: string; conversationId?: string }[] = [];
    const listener: SessionStatusListener = (s, cid) => calls.push({ status: s, conversationId: cid });
    const stream = new AcpSessionStream(listener, defaultIsSkipPrefix, 'conv-123');

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'hi'));
    stream.handleSessionUpdate(makeUpdate('tool_call'));

    expect(calls).toEqual([
      { status: 'typing', conversationId: 'conv-123' },
      { status: 'tool_calling', conversationId: 'conv-123' },
    ]);
  });

  it('suppresses typing status when response is _skip', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', '_skip'));
    stream.finish();

    expect(statuses).toHaveLength(0);
  });

  it('suppresses typing status for incremental _skip chunks', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', '_s'));
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'kip'));
    stream.finish();

    expect(statuses).toHaveLength(0);
  });

  it('emits typing once text diverges from _skip prefix', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', '_s'));
    expect(statuses).toHaveLength(0);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'omething else'));
    expect(statuses).toEqual(['typing']);

    stream.finish();
  });

  it('emits typing for text that is not a _skip prefix', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'Hello'));
    expect(statuses).toEqual(['typing']);

    stream.finish();
  });

  it('resets typing suppression between segment runs', () => {
    const stream = new AcpSessionStream(statusListener, defaultIsSkipPrefix);

    // First run: _skip (suppressed)
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', '_skip'));
    stream.handleSessionUpdate(makeUpdate('tool_call'));
    // Second run: real message (should emit)
    stream.handleSessionUpdate(makeUpdate('agent_message_chunk', 'real response'));
    stream.finish();

    expect(statuses).toEqual(['tool_calling', 'typing']);
  });
});
