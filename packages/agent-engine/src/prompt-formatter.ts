/**
 * Prompt formatter — owns all prompt generation for agent sessions.
 *
 * Each implementation declares a semver {@link PromptFormatter.version}.
 * The {@link PromptManager} selects a compatible formatter based on the
 * major version stored with each session.
 */
import type { LoadSessionMemoryResponse } from '@newio/agent-sdk';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from './app/index.js';
import type { SessionMode, SessionPromptRole } from './prompts/v1/index.js';
import {
  instructionPrompt,
  greetingPrompt,
  memoryUpdatePrompt,
  sessionEndPrompt,
  initiateConversationPrompt,
  shareContextPrompt,
  memoryContextPrompt,
} from './prompts/v1/index.js';

export type { SessionMode, SessionPromptRole } from './prompts/v1/index.js';

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
  /** Returns true if the text represents a skip/done/handoff output (not a conversation reply). */
  isSkip(text: string): boolean;
  /** Extract the handoff note from session-end output, or undefined if not found. */
  extractHandoff(text: string): string | undefined;
  buildNewioInstruction(role?: SessionPromptRole, customInstructions?: string): Instruction;
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
  /** Build the prompt for context shared in from another session (absorbed, not sent). */
  buildShareContextPrompt(context: string): string;
}

export class PromptFormatterImpl implements PromptFormatter {
  readonly version: string = '1.0.0';
  readonly skipToken: string = '<skip';

  constructor(
    private readonly identity: PromptFormatterIdentity,
    private readonly owner: PromptFormatterOwner,
    private readonly sessionMode: SessionMode,
    /** When false (opted out), memory-related prompt sections are omitted. */
    private readonly memoryEnabled: boolean = false,
  ) {}

  /** Detects skip, done, or handoff tags — all mean "don't send as a conversation reply". */
  isSkip(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('<skip') || trimmed.startsWith('<done') || trimmed.startsWith('<handoff');
  }

  extractHandoff(text: string): string | undefined {
    const match = text.match(/<handoff>([\s\S]+?)<\/handoff>/i);
    return match?.[1]?.trim() || undefined;
  }

  buildNewioInstruction(role?: SessionPromptRole, customInstructions?: string): Instruction {
    const prompt = instructionPrompt({
      username: this.identity.username,
      displayName: this.identity.displayName,
      ownerDisplayName: this.owner.displayName,
      ownerUsername: this.owner.username,
      skipToken: this.skipToken,
      sessionMode: this.sessionMode,
      sessionRole: role,
      memoryEnabled: this.memoryEnabled,
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
      ? this.formatGroupBatch(first.conversationId, first.conversationType, first.groupName, messages)
      : this.formatDmBatch(first.conversationId, messages);
  }

  formatContactPrompt(events: readonly ContactEvent[]): string {
    if (events.length === 0) {
      return '';
    }
    const items = events.map((e) => {
      const attrs = [
        `type="${e.type}"`,
        `username="${e.username ?? 'unknown'}"`,
        `display_name="${e.displayName ?? 'Unknown'}"`,
        `account_type="${e.accountType}"`,
      ];
      if (e.ownerUsername) {
        attrs.push(`owner_username="${e.ownerUsername}"`);
      }
      if (e.ownerDisplayName) {
        attrs.push(`owner_display_name="${e.ownerDisplayName}"`);
      }
      attrs.push(`timestamp="${e.timestamp}"`);
      if (e.note) {
        return `  <contact_event ${attrs.join(' ')}>${e.note}</contact_event>`;
      }
      return `  <contact_event ${attrs.join(' ')} />`;
    });
    return `<event type="contact.batch">\n${items.join('\n')}\n</event>`;
  }

  formatCronPrompt(job: CronTriggerEvent): string {
    const attrs = `cron_id="${job.cronId}" label="${job.label}" triggered_at="${job.triggeredAt}"`;
    if (job.payload !== undefined) {
      return `<event type="cron.triggered" ${attrs}>\n  <payload>${JSON.stringify(job.payload)}</payload>\n</event>`;
    }
    return `<event type="cron.triggered" ${attrs} />`;
  }

  formatMemoryContext(memory: LoadSessionMemoryResponse, handoffNote?: string): string {
    // When opted out, never inject memory facts — only the handoff note (if any) is carried forward.
    if (!this.memoryEnabled) {
      const emptyScope = { summary: null, facts: [] };
      return memoryContextPrompt({
        memory: { global: emptyScope, participants: {}, conversation: emptyScope, topUsers: [], topConversations: [] },
        handoffNote,
      });
    }
    return memoryContextPrompt({ memory, handoffNote });
  }

  buildMemoryUpdatePrompt(): string {
    return memoryUpdatePrompt();
  }

  buildSessionEndPrompt(): string {
    return sessionEndPrompt(this.memoryEnabled);
  }

  buildInitiateConversationPrompt(context: string): string {
    return initiateConversationPrompt({ context, skipToken: this.skipToken });
  }

  buildShareContextPrompt(context: string): string {
    return shareContextPrompt({ context });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    if (!first) {
      return '';
    }
    const fromAttrs = `username="${first.senderUsername ?? 'unknown'}" display_name="${first.senderDisplayName ?? 'Unknown'}" account_type="${first.senderAccountType ?? 'unknown'}" relationship="${first.relationship}"`;
    const msgLines = messages.map((m) => `  ${this.formatMessageElement(m)}`);
    return `<event type="message.batch" conversation_id="${conversationId}" conversation_type="dm">\n  <from ${fromAttrs} />\n${msgLines.join('\n')}\n</event>`;
  }

  private formatGroupBatch(
    conversationId: string,
    conversationType: string,
    groupName: string | undefined,
    messages: readonly IncomingMessage[],
  ): string {
    const displayType = conversationType === 'temp_group' ? 'work_session' : conversationType;
    const nameAttr = groupName ? ` group_name="${groupName}"` : '';
    const msgLines = messages.map((m) => {
      const fromAttrs = `from_username="${m.senderUsername ?? 'unknown'}" from_display_name="${m.senderDisplayName ?? 'Unknown'}" from_account_type="${m.senderAccountType ?? 'unknown'}" relationship="${m.relationship}"`;
      return `  ${this.formatMessageElement(m, fromAttrs)}`;
    });
    return `<event type="message.batch" conversation_id="${conversationId}" conversation_type="${displayType}"${nameAttr}>\n${msgLines.join('\n')}\n</event>`;
  }

  private formatMessageElement(m: IncomingMessage, extraAttrs?: string): string {
    const attrs = extraAttrs ? ` ${extraAttrs}` : '';
    const hasAttachments = m.attachments && m.attachments.length > 0;
    if (!hasAttachments) {
      return `<message timestamp="${m.timestamp}"${attrs}>${m.text}</message>`;
    }
    const attachmentLines = m.attachments.map(
      (a) =>
        `    <attachment file_name="${a.fileName}" content_type="${a.contentType}" size="${a.size}" s3_key="${a.s3Key}" />`,
    );
    return `<message timestamp="${m.timestamp}"${attrs}>\n    <text>${m.text}</text>\n${attachmentLines.join('\n')}\n  </message>`;
  }
}
