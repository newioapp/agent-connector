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

export class AcpSessionStream {
  private currentType: SegmentType | undefined;
  private currentText = '';
  private currentToolCallId: string | undefined;
  private currentToolCallStatus: string | undefined;
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
    let toolCallStatus: string | undefined;

    if (type === 'tool_call' || type === 'tool_call_update') {
      const parsed = parseToolCallUpdate(update);
      toolCallId = parsed.toolCallId;
      toolCallStatus = parsed.status;
      text = parsed.text;
    } else if (
      type === 'agent_message_chunk' ||
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrows union to ContentChunk
      type === 'agent_thought_chunk'
    ) {
      text =
        update.content.type === 'text' && typeof update.content.text === 'string' ? update.content.text : undefined;
    }

    this.push(type, text, toolCallId, toolCallStatus);

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

  private push(type: SegmentType, text?: string, toolCallId?: string, toolCallStatus?: string): void {
    // Flush when type changes or when toolCallId changes (different tool call)
    if (this.currentType && (this.currentType !== type || (toolCallId && this.currentToolCallId !== toolCallId))) {
      this.flushCurrent();
    }

    this.currentType = type;
    if (text) {
      this.currentText += text;
    }
    if (toolCallId) {
      this.currentToolCallId = toolCallId;
    }
    if (toolCallStatus) {
      this.currentToolCallStatus = toolCallStatus;
    }
  }

  private flushCurrent(): void {
    if (this.currentType) {
      this.queue.push({
        type: this.currentType,
        text: this.currentText,
        toolCallId: this.currentToolCallId,
        toolCallStatus: this.currentToolCallStatus,
      });
      this.currentType = undefined;
      this.currentText = '';
      this.currentToolCallId = undefined;
      this.currentToolCallStatus = undefined;
      this.typingStatusEmitted = false;
      this.waiter?.();
    }
  }
}

const SEGMENT_TYPES = new Set<string>(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);

function isSegmentType(type: string): type is SegmentType {
  return SEGMENT_TYPES.has(type);
}

interface ToolCallParsed {
  readonly toolCallId?: string;
  readonly status?: string;
  readonly text?: string;
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
function parseToolCallUpdate(update: acp.SessionUpdate): ToolCallParsed {
  const raw = update as Record<string, unknown>;
  const tc =
    update.sessionUpdate === 'tool_call'
      ? (raw['toolCall'] as Record<string, unknown> | undefined)
      : (raw['toolCallUpdate'] as Record<string, unknown> | undefined);
  if (!tc) {
    return {};
  }

  const toolCallId = typeof tc['toolCallId'] === 'string' ? tc['toolCallId'] : undefined;
  const status = typeof tc['status'] === 'string' ? tc['status'] : undefined;
  const title = typeof tc['title'] === 'string' && tc['title'].length > 0 ? tc['title'] : undefined;
  const purpose = extractRawInputPurpose(tc);

  if (title) {
    const text = purpose ? `${title}\n${purpose}` : title;
    return { toolCallId, status, text };
  }

  // Fallback: first content item with a text description (claude-agent-acp shape)
  if (Array.isArray(tc['content'])) {
    for (const item of tc['content']) {
      if (typeof item === 'object' && item !== null) {
        const entry = item as Record<string, unknown>;
        if (typeof entry['content'] === 'object' && entry['content'] !== null) {
          const inner = entry['content'] as Record<string, unknown>;
          if (inner['type'] === 'text' && typeof inner['text'] === 'string') {
            return { toolCallId, status, text: inner['text'] };
          }
        }
      }
    }
  }

  return { toolCallId, status };
}

/** Extract a human-readable purpose from rawInput (__tool_use_purpose for kiro-cli, description for claude). */
function extractRawInputPurpose(tc: Record<string, unknown>): string | undefined {
  if (typeof tc['rawInput'] !== 'object' || tc['rawInput'] === null) {
    return undefined;
  }
  const ri = tc['rawInput'] as Record<string, unknown>;
  if (typeof ri['__tool_use_purpose'] === 'string' && ri['__tool_use_purpose'].length > 0) {
    return ri['__tool_use_purpose'];
  }
  if (typeof ri['description'] === 'string' && ri['description'].length > 0) {
    return ri['description'];
  }
  return undefined;
}
