/**
 * Prompt formatter — owns all prompt generation for agent sessions.
 *
 * Each implementation declares a semver {@link PromptFormatter.version}.
 * The {@link PromptManager} selects a compatible formatter based on the
 * major version stored with each session.
 */
import type { IncomingMessage, ContactEvent, CronTriggerEvent, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import type { SessionMode } from './prompts/v1/index.js';
import {
  instructionPrompt,
  greetingPrompt,
  memoryUpdatePrompt,
  sessionEndPrompt,
  initiateConversationPrompt,
  memoryContextPrompt,
} from './prompts/v1/index.js';

export type { SessionMode } from './prompts/v1/index.js';

export interface Instruction {
  readonly prompt: string;
  readonly version: string;
}

/** Minimal identity info needed by the prompt formatter. */
export interface PromptFormatterIdentity {
  readonly username: string;
  readonly displayName?: string;
}

/** Minimal owner info needed by the prompt formatter. */
export interface PromptFormatterOwner {
  readonly username: string;
  readonly displayName: string;
}

export interface PromptFormatter {
  readonly version: string;
  /** The token the agent uses to indicate "no reply needed". */
  readonly skipToken: string;
  /** Returns true if the trimmed, lowercased text is exactly the skip token. */
  isSkip(text: string): boolean;
  buildNewioInstruction(customInstructions?: string): Instruction;
  buildGreetingPrompt(): string;
  formatMessagePrompt(messages: readonly IncomingMessage[]): string;
  formatContactPrompt(events: readonly ContactEvent[]): string;
  formatCronPrompt(job: CronTriggerEvent): string;
  /** Format loaded memory into context to inject at session start. */
  formatMemoryContext(memory: LoadSessionMemoryResponse, handoffNote?: string): string;
  /** Build the memory update prompt for mid-session (no handoff, session continues). */
  buildMemoryUpdatePrompt(): string;
  /** Build the session-ending prompt: update memory + generate handoff note. */
  buildSessionEndPrompt(): string;
  /** Build the prompt for a delegated conversation initiation from another session. */
  buildInitiateConversationPrompt(context: string): string;
}

export class PromptFormatterImpl implements PromptFormatter {
  readonly version: string = '1.0.0';
  readonly skipToken: string = '_skip';

  constructor(
    private readonly identity: PromptFormatterIdentity,
    private readonly owner: PromptFormatterOwner,
    private readonly sessionMode: SessionMode,
  ) {}

  isSkip(text: string): boolean {
    return text.trim().toLowerCase() === this.skipToken;
  }

  buildNewioInstruction(customInstructions?: string): Instruction {
    const prompt = instructionPrompt({
      username: this.identity.username,
      displayName: this.identity.displayName,
      ownerDisplayName: this.owner.displayName,
      ownerUsername: this.owner.username,
      skipToken: this.skipToken,
      sessionMode: this.sessionMode,
      customInstructions,
    });
    return { prompt, version: this.version };
  }

  buildGreetingPrompt(): string {
    return greetingPrompt();
  }

  formatMessagePrompt(messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    if (!first) {
      return '';
    }
    const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';
    return isGroup
      ? this.formatGroupBatch(first.conversationId, first.groupName, messages)
      : this.formatDmBatch(first.conversationId, messages);
  }

  /**
   * Format a batch of contact events into a prompt string.
   *
   * Example output:
   * ```
   * event: contact.batch
   * events:
   *   - type: contact.request_received
   *     username: alice
   *     displayName: Alice
   *     accountType: human
   *     note: "Hey, let's connect!"
   *     timestamp: "2026-04-04T10:00:00Z"
   *   - type: contact.request_accepted
   *     username: helper_bot
   *     displayName: Helper Bot
   *     accountType: agent
   *     ownerUsername: charlie
   *     ownerDisplayName: Charlie
   *     timestamp: "2026-04-04T10:01:00Z"
   * ```
   */
  formatContactPrompt(events: readonly ContactEvent[]): string {
    if (events.length === 0) {
      return '';
    }
    const lines = ['event: contact.batch', 'events:'];
    for (const e of events) {
      lines.push(`  - type: ${e.type}`);
      lines.push(`    username: ${e.username ?? 'unknown'}`);
      lines.push(`    displayName: ${e.displayName ?? 'Unknown'}`);
      lines.push(`    accountType: ${e.accountType}`);
      if (e.ownerUsername) {
        lines.push(`    ownerUsername: ${e.ownerUsername}`);
      }
      if (e.ownerDisplayName) {
        lines.push(`    ownerDisplayName: ${e.ownerDisplayName}`);
      }
      if (e.note) {
        lines.push(`    note: "${e.note}"`);
      }
      lines.push(`    timestamp: "${e.timestamp}"`);
    }
    return lines.join('\n');
  }

  /**
   * Format a cron trigger event into a prompt string.
   *
   * Example output:
   * ```
   * event: cron.triggered
   * cronId: cron_abc123
   * label: "Send daily standup reminder to Team Chat"
   * triggeredAt: "2026-04-05T09:00:00Z"
   * payload: {"channel":"team-chat"}
   * ```
   */
  formatCronPrompt(job: CronTriggerEvent): string {
    const lines = [
      'event: cron.triggered',
      `cronId: ${job.cronId}`,
      `label: "${job.label}"`,
      `triggeredAt: "${job.triggeredAt}"`,
    ];
    if (job.payload !== undefined) {
      lines.push(`payload: ${JSON.stringify(job.payload)}`);
    }
    return lines.join('\n');
  }

  formatMemoryContext(memory: LoadSessionMemoryResponse, handoffNote?: string): string {
    return memoryContextPrompt({ memory, handoffNote });
  }

  buildMemoryUpdatePrompt(): string {
    return memoryUpdatePrompt();
  }

  buildSessionEndPrompt(): string {
    return sessionEndPrompt();
  }

  buildInitiateConversationPrompt(context: string): string {
    return initiateConversationPrompt({ context, skipToken: this.skipToken });
  }

  // ---------------------------------------------------------------------------
  // Private — message formatting helpers
  // ---------------------------------------------------------------------------

  private formatSender(m: IncomingMessage): string {
    return [
      `    username: ${m.senderUsername ?? 'unknown'}`,
      `    displayName: ${m.senderDisplayName ?? 'Unknown'}`,
      `    accountType: ${m.senderAccountType ?? 'unknown'}`,
      `    relationship: ${m.relationship}`,
    ].join('\n');
  }

  private formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    if (!first) {
      return '';
    }
    const lines = [
      'event: message.batch',
      `conversationId: ${conversationId}`,
      'type: dm',
      'from:',
      this.formatSender(first),
      'messages:',
    ];
    for (const m of messages) {
      lines.push(`  - message: ${m.text}`);
      lines.push(`    timestamp: "${m.timestamp}"`);
      this.formatAttachments(m, lines);
    }
    return lines.join('\n');
  }

  private formatGroupBatch(
    conversationId: string,
    groupName: string | undefined,
    messages: readonly IncomingMessage[],
  ): string {
    const lines = [
      'event: message.batch',
      `conversationId: ${conversationId}`,
      'type: group',
      `groupName: ${groupName ?? 'Unnamed Group'}`,
      'messages:',
    ];
    for (const m of messages) {
      lines.push('  - from:');
      lines.push(this.formatSender(m));
      lines.push(`    message: ${m.text}`);
      lines.push(`    timestamp: "${m.timestamp}"`);
      this.formatAttachments(m, lines);
    }
    return lines.join('\n');
  }

  private formatAttachments(m: IncomingMessage, lines: string[]): void {
    if (m.attachments && m.attachments.length > 0) {
      lines.push('    attachments:');
      for (const a of m.attachments) {
        lines.push(`      - fileName: ${a.fileName}`);
        lines.push(`        contentType: ${a.contentType}`);
        lines.push(`        size: ${a.size}`);
        lines.push(`        s3Key: ${a.s3Key}`);
      }
    }
  }
}
