/**
 * SessionStream — async generator that yields aggregated session update segments.
 *
 * Consecutive updates of the same type are merged into a single segment.
 * When the update type changes, the accumulated segment is yielded.
 * The generator completes when {@link finish} is called (i.e., when `conn.prompt` resolves).
 */
import type * as acp from '@agentclientprotocol/sdk';
import type { SessionStatusListener } from '../agent-session';

/** 1:1 mapping with ACP SessionUpdate types. */
export type SegmentType =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'usage_update';

/** An aggregated segment yielded by the stream. */
export interface SessionStreamSegment {
  readonly type: SegmentType;
  readonly text: string;
}

export class SessionStream {
  private currentType: SegmentType | undefined;
  private currentText = '';
  private done = false;

  /** Queued segments ready to be yielded. */
  private queue: SessionStreamSegment[] = [];
  /** Resolves when a new segment is queued or the stream finishes. */
  private waiter: (() => void) | undefined;

  constructor(private readonly statusListener: SessionStatusListener) {}

  /** Process a raw ACP session update — aggregates text and emits status. */
  handleSessionUpdate(params: acp.SessionNotification): void {
    const u = params.update;
    const type = u.sessionUpdate as SegmentType;
    let text: string | undefined;
    if ('content' in u) {
      const content = u.content as { type: string; text?: string };
      if (content.type === 'text') {
        text = content.text;
      }
    }

    this.push(type, text);

    switch (type) {
      case 'agent_message_chunk':
        this.statusListener('typing');
        break;
      case 'agent_thought_chunk':
        this.statusListener('thinking');
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.statusListener('tool_calling');
        break;
      default:
        break;
    }
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

  private push(type: SegmentType, text?: string): void {
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
      this.queue.push({ type: this.currentType, text: this.currentText });
      this.currentType = undefined;
      this.currentText = '';
      this.waiter?.();
    }
  }
}
