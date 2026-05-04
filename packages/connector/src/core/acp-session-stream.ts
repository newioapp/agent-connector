/**
 * SessionStream — async generator that yields aggregated session update segments.
 *
 * Consecutive updates of the same type are merged into a single segment.
 * When the update type changes, the accumulated segment is yielded.
 * The generator completes when {@link finish} is called (i.e., when `conn.prompt` resolves).
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { SegmentType, SessionStreamSegment, SessionStatusListener } from './types';

export class AcpSessionStream {
  private currentType: SegmentType | undefined;
  private currentText = '';
  private currentToolCallId: string | undefined;
  private done = false;
  /** Whether we've already emitted a 'typing' status for the current agent_message_chunk run. */
  private typingStatusEmitted = false;

  /** Queued segments ready to be yielded. */
  private queue: SessionStreamSegment[] = [];
  /** Resolves when a new segment is queued or the stream finishes. */
  private waiter: (() => void) | undefined;

  constructor(
    private readonly statusListener: SessionStatusListener,
    private readonly isSkipPrefix: (text: string) => boolean,
    private readonly conversationId?: string,
  ) {}

  /** Process a raw ACP session update — aggregates text and emits status. Returns true if handled. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    const type = update.sessionUpdate;
    if (!isSegmentType(type)) {
      return false;
    }

    let text: string | undefined;
    let toolCallId: string | undefined;

    if (type === 'tool_call' || type === 'tool_call_update') {
      // tool_call and tool_call_update have toolCallId and title directly on the update
      const u = update as Record<string, unknown>;
      const tc = (type === 'tool_call' ? u.toolCall : u.toolCallUpdate) as Record<string, unknown> | undefined;
      if (tc) {
        if (typeof tc.toolCallId === 'string') {
          toolCallId = tc.toolCallId;
        }
        if (typeof tc.title === 'string') {
          text = tc.title;
        }
      }
    } else if ('content' in update) {
      // agent_message_chunk and agent_thought_chunk use content.text
      text = extractTextContent(update);
    }

    this.push(type, text, toolCallId);

    switch (type) {
      case 'agent_message_chunk':
        // Defer 'typing' status until we can confirm the response is not _skip.
        // Once accumulated text exceeds '_skip' length or doesn't match its prefix, emit.
        if (!this.typingStatusEmitted && !this.isSkipPrefix(this.currentText)) {
          this.typingStatusEmitted = true;
          this.statusListener('typing', this.conversationId);
        }
        break;
      case 'agent_thought_chunk':
        this.statusListener('thinking', this.conversationId);
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.statusListener('tool_calling', this.conversationId);
        break;
    }
    return true;
  }

  /** Signal that the prompt has completed. Flushes any remaining segment. */
  finish(): void {
    if (this.done) {
      return;
    }
    this.flushCurrent();
    this.done = true;
    this.waiter?.();
  }

  /** Async generator that yields aggregated segments as they become available. */
  async *segments(): AsyncGenerator<SessionStreamSegment> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      let next = this.queue.shift();
      while (next) {
        yield next;
        next = this.queue.shift();
      }

      if (this.done) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = undefined;
    }
  }

  private push(type: SegmentType, text?: string, toolCallId?: string): void {
    if (this.currentType && this.currentType !== type) {
      this.flushCurrent();
    }

    this.currentType = type;
    if (text) {
      this.currentText += text;
    }
    if (toolCallId) {
      this.currentToolCallId = toolCallId;
    }
  }

  private flushCurrent(): void {
    if (this.currentType) {
      this.queue.push({ type: this.currentType, text: this.currentText, toolCallId: this.currentToolCallId });
      this.currentType = undefined;
      this.currentText = '';
      this.currentToolCallId = undefined;
      this.typingStatusEmitted = false;
      this.waiter?.();
    }
  }
}

const SEGMENT_TYPES = new Set<string>(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);

function isSegmentType(type: string): type is SegmentType {
  return SEGMENT_TYPES.has(type);
}

/** Extract text from an ACP session update that has a content field with { type: 'text', text: string }. */
function extractTextContent(update: Record<string, unknown>): string | undefined {
  const content = update['content'];
  if (
    typeof content === 'object' &&
    content !== null &&
    'type' in content &&
    (content as Record<string, unknown>)['type'] === 'text' &&
    'text' in content &&
    typeof (content as Record<string, unknown>)['text'] === 'string'
  ) {
    return (content as Record<string, unknown>)['text'] as string;
  }
  return undefined;
}
