/**
 * SessionStream — async generator that yields aggregated session update segments.
 *
 * Consecutive updates of the same type are merged into a single segment.
 * When the update type changes (or toolCallId changes for tool calls),
 * the accumulated segment is yielded.
 * The generator completes when {@link finish} is called (i.e., when `conn.prompt` resolves).
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { SegmentType, SessionStreamSegment, SessionStatusListener } from './types';
import { getLogger } from '@newio/agent-sdk';

const log = getLogger('acp-session-stream');

export class AcpSessionStream {
  private currentType: SegmentType | undefined;
  private currentText = '';
  private done = false;
  /** Whether we've already emitted a 'typing' status for the current agent_message_chunk run. */
  private typingStatusEmitted = false;

  /** Queued segments ready to be yielded. */
  private queue: SessionStreamSegment[] = [];
  /** Resolves when a new segment is queued or the stream finishes. */
  private waiter: (() => void) | undefined;

  constructor(
    private readonly statusListener: SessionStatusListener,
    private readonly skipToken: string,
    private readonly conversationId?: string,
  ) {}

  /** Process a raw ACP session update — aggregates text and emits status. Returns true if handled. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    const type = update.sessionUpdate;
    if (
      type !== 'agent_message_chunk' &&
      type !== 'agent_thought_chunk' &&
      type !== 'tool_call' &&
      type !== 'tool_call_update'
    ) {
      return false;
    }

    let text: string | undefined = undefined;

    if (type === 'tool_call' || type === 'tool_call_update') {
      log.debug('Session update:', update);
      this.statusListener('tool_calling', this.conversationId);
      const parsed = parseToolCallUpdate(update);
      if (parsed !== undefined) {
        text = parsed.text;
        this.pushToolCall(parsed.text, parsed.toolCallId, parsed.status);
      }
    } else if (type === 'agent_message_chunk') {
      text =
        update.content.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined;
      this.pushText('agent_message_chunk', text);
      if (!this.typingStatusEmitted && !isSkipPrefix(this.skipToken, this.currentText)) {
        this.typingStatusEmitted = true;
        this.statusListener('typing', this.conversationId);
      }
    } else {
      this.statusListener('thinking', this.conversationId);
      text =
        update.content.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined;
      this.pushText('agent_thought_chunk', text);
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

  private pushToolCall(text: string, toolCallId: string, toolCallStatus?: string): void {
    this.flushCurrent();
    this.queue.push({
      type: 'tool_call',
      text: text,
      toolCallId: toolCallId,
      toolCallStatus: toolCallStatus,
    });
    this.waiter?.();
  }

  private pushText(type: SegmentType, text?: string): void {
    if (this.currentType && this.currentType !== type) {
      this.flushCurrent();
    }

    this.currentType = type;
    if (text) {
      this.currentText += text;
    }
  }

  private flushCurrent(): void {
    if (this.currentType) {
      this.queue.push({
        type: this.currentType,
        text: this.currentText,
      });
      this.currentType = undefined;
      this.currentText = '';
      this.typingStatusEmitted = false;
      this.waiter?.();
    }
  }
}

interface ToolCallParsed {
  readonly toolCallId: string;
  readonly status?: string;
  readonly text: string;
}

/**
 * Parse a tool_call or tool_call_update ACP session update into a normalized shape.
 *
 * Different ACP agents produce different shapes:
 * - kiro-cli: tool_call with title + rawInput.__tool_use_purpose
 * - claude-agent-acp: tool_call_update with title + rawInput.description
 * - codex-acp: tool_call with title + status
 * - cursor: tool_call with title + status, tool_call_update with status only (no title)
 *
 * Text is built from title + purpose/description from rawInput when available.
 * Falls back to content text if no title exists.
 */
function parseToolCallUpdate(update: acp.SessionUpdate): ToolCallParsed | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return undefined;
  }

  if (typeof update.toolCallId !== 'string') {
    return undefined;
  }

  let segments: (string | undefined)[] = [trim(update.title)];
  segments.push(extractRawInputPurpose(update.rawInput));

  segments = segments.filter((s) => typeof s === 'string');
  if (segments.length === 0) {
    segments.push(update.toolCallId);
  }

  return {
    toolCallId: update.toolCallId,
    status: update.status ?? undefined,
    text: segments.join('\n'),
  };
}

/** Extract a human-readable purpose from rawInput (__tool_use_purpose for kiro-cli, description for claude). */
function extractRawInputPurpose(rawInput: unknown): string | undefined {
  if (typeof rawInput === 'object' && rawInput !== null) {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj['__tool_use_purpose'] === 'string' && obj['__tool_use_purpose'].length > 0) {
      return trim(obj['__tool_use_purpose']);
    } else if (typeof obj['description'] === 'string' && obj['description'].length > 0) {
      return trim(obj['description']);
    }
  }
  return undefined;
}

function trim(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  text = text.trim();
  return text.length > 0 ? text : undefined;
}

function isSkipPrefix(skipToken: string, text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length === 0) {
    return true;
  }
  return skipToken.startsWith(lower);
}
