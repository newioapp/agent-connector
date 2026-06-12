/**
 * Control-channel protocol between the puppet (ACP agent, spawned by the
 * connector) and the PuppetDriver (running inside the test).
 *
 * Transport: newline-delimited JSON over a Unix domain socket whose path the
 * connector passes to the puppet via the `PUPPET_CONTROL_SOCKET` env var. Every
 * message is one JSON object on its own line.
 *
 * The driver is the controller: the puppet reports lifecycle events and, for
 * each prompt turn, asks the driver what to do and blocks until told. This is
 * what makes puppet behavior deterministic and live-scriptable from a test.
 */

/** A single thing the puppet should do during one prompt turn, in order. */
export type TurnAction =
  /** Emit an `agent_message_chunk` — the connector auto-delivers it to the current conversation. */
  | { readonly kind: 'message'; readonly text: string }
  /** Emit an `agent_thought_chunk` — surfaced to the owner only when "show thoughts" is on. */
  | { readonly kind: 'thought'; readonly text: string };

/** How a prompt turn concludes. Mirrors the ACP `StopReason` values the puppet uses. */
export type PuppetStopReason = 'end_turn' | 'cancelled' | 'refusal';

/** Driver → Puppet: how to handle a prompt turn, correlated to a `prompt` event by `id`. */
export interface TurnInstruction {
  readonly t: 'turn';
  readonly id: number;
  readonly actions: readonly TurnAction[];
  /** Defaults to `end_turn`. */
  readonly stopReason?: PuppetStopReason;
  /** Optional delay (ms) inserted before each action — exercises streaming/activity timing. */
  readonly delayMs?: number;
}

/** Puppet → Driver: a prompt arrived; the puppet blocks until it receives the matching `turn`. */
export interface PromptEvent {
  readonly t: 'prompt';
  readonly id: number;
  readonly sessionId: string;
  /** The full prompt text the connector sent (instruction + memory + the user message). */
  readonly text: string;
}

/** Puppet → Driver: lifecycle notifications (no response expected). */
export type PuppetLifecycleEvent =
  | { readonly t: 'hello'; readonly pid: number }
  | { readonly t: 'session_new'; readonly sessionId: string }
  | { readonly t: 'session_load'; readonly sessionId: string }
  | { readonly t: 'cancelled'; readonly sessionId: string };

/** Any message the puppet sends to the driver. */
export type PuppetMessage = PromptEvent | PuppetLifecycleEvent;

/** Any message the driver sends to the puppet. */
export type DriverMessage = TurnInstruction;

/** Encode a single protocol message as one newline-terminated JSON line. */
export function encodeLine(message: PuppetMessage | DriverMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Stateful newline-delimited JSON decoder. Feed it raw socket chunks; it yields
 * one parsed object per complete line, buffering any partial trailing line.
 */
export class LineDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    const out: unknown[] = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        out.push(JSON.parse(trimmed));
      }
    }
    return out;
  }
}
