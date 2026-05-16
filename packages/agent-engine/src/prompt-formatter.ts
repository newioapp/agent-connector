/**
 * Prompt formatter — owns all prompt generation for agent sessions.
 *
 * Each implementation declares a semver {@link PromptFormatter.version}.
 * The {@link PromptManager} selects a compatible formatter based on the
 * major version stored with each session.
 */
import type {
  IncomingMessage,
  ContactEvent,
  CronTriggerEvent,
  NewioApp,
  LoadSessionMemoryResponse,
} from '@newio/agent-sdk';

export interface Instruction {
  readonly prompt: string;
  readonly version: string;
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
  private readonly app: NewioApp;
  readonly version: string = '1.0.0';
  readonly skipToken: string = '_skip';

  constructor(app: NewioApp) {
    this.app = app;
  }

  isSkip(text: string): boolean {
    return text.trim().toLowerCase() === this.skipToken;
  }

  buildNewioInstruction(customInstructions?: string): Instruction {
    const { username, displayName } = this.app.identity;

    const parts: string[] = [];

    parts.push(
      `You are an AI agent on a messaging platform. Your username is "${username}"${displayName ? ` and your display name is "${displayName}"` : ''}. You receive messages from multiple conversations — both direct messages and group chats. Each message batch you receive is from a single conversation.`,
    );

    const ownerInfo = this.app.getOwnerInfo();
    parts.push(
      `Your owner is "${ownerInfo.displayName}" (username: ${ownerInfo.username}). Treat messages from your owner with priority.`,
    );

    parts.push(`Messages arrive as YAML. Each sender has a username, display name, account type (human or agent), and relationship to you (owner, peer, in-contact, or stranger).

DM example:
  conversationId: abc-123
  type: dm
  from:
    username: alice
    displayName: Alice
    accountType: human
    relationship: in-contact
  messages:
    - message: Hey, check this out!
      timestamp: "2026-03-17T22:55:41Z"
      attachments:
        - fileName: photo.jpg
          contentType: image/jpeg
          size: 245000
          s3Key: media/abc-123/01ARZ3N.jpg

Group example:
  conversationId: def-456
  type: group
  groupName: Team Chat
  messages:
    - from:
        username: bob
        displayName: Bob
        accountType: human
        relationship: in-contact
      message: Meeting at 3?
      timestamp: "2026-03-17T23:01:02Z"
    - from:
        username: helper_bot
        displayName: Helper Bot
        accountType: agent
        relationship: stranger
      message: I can help schedule that
      timestamp: "2026-03-17T23:01:15Z"

Conversation types and how to behave:
- dm: A direct message between you and one other person. Always respond — they are talking to you directly.
- group: A named group chat with multiple participants. Be selective — only respond when @mentioned by username or when you have something clearly relevant to add. Otherwise, respond with ${this.skipToken}.
- temp_group (Work Session): A collaborative workspace with your owner and sibling agents. Be proactive — you are included specifically to participate and contribute.

@mention convention:
- Most agents set their notification level to "mentions only", meaning they only see messages that @mention them.
- When you want another agent to respond in a group chat or work session, include @username in your message (e.g., "@helper_bot can you check that?").
- Without the @mention, the other agent may not see your message.

Response rules:
- Reply with plain text or markdown — the messaging app renders markdown.
- If no reply is needed, respond with exactly: ${this.skipToken}
- Be concise and natural.

Important — how your responses are delivered:
- Your text response is automatically sent back to the conversation you received the message from. Do NOT use send_message, send_dm, or dm_owner tools to reply to the current conversation — that would send the message twice.
- The MCP messaging tools (send_message, send_dm, dm_owner) are for proactively reaching out to OTHER conversations or people — for example, notifying your owner about something, or messaging a different group.`);

    parts.push(`Beyond messages, you also receive contact events and scheduled cron triggers.

Contact events:
- You receive friend request, acceptance, rejection, and removal events as YAML.
- Your text response is NOT sent anywhere — it is discarded. Always respond with ${this.skipToken}.
- If you need to take action (e.g., accept a friend request, notify your owner), use MCP tools like dm_owner, send_dm, accept_friend_request, reject_friend_request, send_friend_request, or remove_friend.

Contact event example:
  events:
    - event: contact.request_received
      username: alice
      displayName: Alice
      accountType: human
      note: "Hey, let's connect!"
      timestamp: "2026-04-04T10:00:00Z"
    - event: contact.request_accepted
      username: bob
      displayName: Bob
      accountType: agent
      ownerUsername: charlie
      ownerDisplayName: Charlie
      timestamp: "2026-04-04T10:01:00Z"

Cron triggers:
- You can schedule recurring tasks using the schedule_cron MCP tool.
- When a cron job fires, you receive a trigger event with the label and optional payload you set.
- Your text response is NOT sent anywhere — it is discarded. Always respond with ${this.skipToken}.
- Use MCP tools to take any actions the cron job requires.

Cron trigger example:
  event: cron.triggered
  cronId: cron_abc123
  label: "Send daily standup reminder to Team Chat"
  triggeredAt: "2026-04-05T09:00:00Z"`);

    parts.push(`Session lifecycle:
- Your sessions are ephemeral. Each conversation interaction starts a fresh session with your persistent memory loaded.
- You may receive a "memory update" prompt asking you to review the session and persist important facts using memory MCP tools. Your session will continue after this.
- You may receive a "session ending" prompt when your session is about to close (idle timeout or context limit). You should update memory and produce a brief handoff note so the next session can pick up context.
- Memory and handoff notes are your continuity mechanism across sessions.`);

    if (customInstructions) {
      parts.push(customInstructions);
    }

    return { prompt: parts.join('\n\n'), version: this.version };
  }

  buildGreetingPrompt() {
    const ownerName = this.app.getOwnerInfo().displayName;
    const prompt =
      `Context: You are running as an ACP (Agent Client Protocol) agent inside the Agent Connector. ` +
      `The connector has already handled authentication and connected you to the Newio messaging platform on your behalf — you do not need to do anything to connect. ` +
      `This is a startup test to verify the connection is working. ` +
      `Your response will be sent as a message to ${ownerName} in your DM conversation.\n\n` +
      `Task: Write a brief, friendly greeting (1-2 sentences) to let ${ownerName} know you are online and ready. ` +
      `Just output the greeting text, nothing else.`;
    return prompt;
  }

  // ---------------------------------------------------------------------------
  // Message formatting
  // ---------------------------------------------------------------------------

  /** Format a batch of incoming messages into a prompt string. */
  formatMessagePrompt(messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    if (!first) {
      return '';
    }
    const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';
    if (isGroup) {
      return this.formatGroupBatch(first.conversationId, first.groupName, messages);
    }
    return this.formatDmBatch(first.conversationId, messages);
  }

  // ---------------------------------------------------------------------------
  // Contact event formatting
  // ---------------------------------------------------------------------------

  /** Format a batch of contact events into a prompt string. */
  formatContactPrompt(events: readonly ContactEvent[]): string {
    if (events.length === 0) {
      return '';
    }
    const lines = ['events:'];
    for (const e of events) {
      lines.push(`  - event: ${e.type}`);
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

  // ---------------------------------------------------------------------------
  // Cron event formatting
  // ---------------------------------------------------------------------------

  /** Format a cron trigger event into a prompt string. */
  formatCronPrompt(job: CronTriggerEvent): string {
    const lines = [
      `event: cron.triggered`,
      `cronId: ${job.cronId}`,
      `label: "${job.label}"`,
      `triggeredAt: "${job.triggeredAt}"`,
    ];
    if (job.payload !== undefined) {
      lines.push(`payload: ${JSON.stringify(job.payload)}`);
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Memory & session lifecycle
  // ---------------------------------------------------------------------------

  formatMemoryContext(memory: LoadSessionMemoryResponse, handoffNote?: string): string {
    const sections: string[] = [];

    if (handoffNote) {
      sections.push(`## Handoff from previous session\n${handoffNote}`);
    }

    const globalParts: string[] = [];
    if (memory.global.summary) {
      globalParts.push(memory.global.summary.text);
    }
    for (const fact of memory.global.facts) {
      globalParts.push(`- ${fact.text}`);
    }
    if (globalParts.length > 0) {
      sections.push(`## Your memory (global)\n${globalParts.join('\n')}`);
    }

    for (const [userId, data] of Object.entries(memory.participants)) {
      const parts: string[] = [];
      if (data.summary) {
        parts.push(`Summary: ${data.summary.text}`);
      }
      for (const fact of data.facts) {
        parts.push(`- ${fact.text}`);
      }
      if (parts.length > 0) {
        sections.push(`## Memory about user ${userId}\n${parts.join('\n')}`);
      }
    }

    const convParts: string[] = [];
    if (memory.conversation.summary) {
      convParts.push(`Summary: ${memory.conversation.summary.text}`);
    }
    for (const fact of memory.conversation.facts) {
      convParts.push(`- ${fact.text}`);
    }
    if (convParts.length > 0) {
      sections.push(`## Memory about this conversation\n${convParts.join('\n')}`);
    }

    if (memory.topUsers.length > 0) {
      const lines = memory.topUsers.map((s) => `- ${s.scopeId}: ${s.text}`);
      sections.push(`## Other people you know\n${lines.join('\n')}`);
    }

    if (memory.topConversations.length > 0) {
      const lines = memory.topConversations.map((s) => `- ${s.scopeId}: ${s.text}`);
      sections.push(`## Other conversations\n${lines.join('\n')}`);
    }

    if (sections.length === 0) {
      return '';
    }

    return `# Memory\n\nThe following is your persistent memory from previous sessions. Use it for context but do not repeat it back to users.\n\n${sections.join('\n\n')}`;
  }

  buildMemoryUpdatePrompt(): string {
    return `Update your memory now. Your session will continue after this.\n\n${this.memoryUpdateRules()}`;
  }

  buildSessionEndPrompt(): string {
    return `Your session is ending. Update your memory and produce a handoff note.

## Step 1: Update memory

${this.memoryUpdateRules()}

## Step 2: Handoff note

After updating memory, output a brief handoff note (2-4 sentences) describing what was happening in this session so the next session can pick up context. This should capture the current state of work, not durable facts (those go in memory).

Output the handoff note as your final message, prefixed with exactly "HANDOFF:" on its own line.`;
  }

  buildInitiateConversationPrompt(context: string): string {
    return `Another one of your sessions has delegated a task to this conversation.

## Delegation context

${context}

## Instructions

Based on the context above, compose an appropriate message for this conversation. Consider the relationship and tone you have with the people in this conversation.

If you decide a message should be sent, output it after the keyword "MESSAGE:" on its own line. Only the text after MESSAGE: will be delivered — do not include any preamble or explanation before it.

If you determine no message is needed (e.g., the context is unclear or irrelevant to this conversation), respond with exactly: ${this.skipToken}`;
  }

  /** Shared memory update instructions used by both mid-session and session-end prompts. */
  private memoryUpdateRules(): string {
    return `Before making changes, use \`get_memory\` to check what you already know about relevant users and this conversation.

For each piece of durable information from this session:

1. **Future Utility** — Will this matter in future interactions?
2. **Novelty** — Is this already captured in your current memory?
3. **Factual** — Is this a fact, preference, or decision (not ephemeral chatter)?
4. **Safe** — No sensitive credentials or PII?

Actions:
- New fact → \`add_memory\` with the appropriate username or conversationId
- Update existing → \`update_memory\` with the factId
- Obsolete → \`delete_memory\` with the factId
- Summary needs refresh → \`update_memory_summary\`

Rules:
- Facts: self-contained, third-person, no pronouns.
- Summaries: max 8 lines. Keep them high-level overviews.
- Do NOT store: transient task status, verbatim conversation, or anything stale tomorrow.
- Omit username and conversationId to store facts about yourself (global scope).`;
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
    const lines = [`conversationId: ${conversationId}`, `type: dm`, `from:`, this.formatSender(first), `messages:`];
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
      `conversationId: ${conversationId}`,
      `type: group`,
      `groupName: ${groupName ?? 'Unnamed Group'}`,
      `messages:`,
    ];
    for (const m of messages) {
      lines.push(`  - from:`);
      lines.push(this.formatSender(m));
      lines.push(`    message: ${m.text}`);
      lines.push(`    timestamp: "${m.timestamp}"`);
      this.formatAttachments(m, lines);
    }
    return lines.join('\n');
  }

  private formatAttachments(m: IncomingMessage, lines: string[]): void {
    if (m.attachments && m.attachments.length > 0) {
      lines.push(`    attachments:`);
      for (const a of m.attachments) {
        lines.push(`      - fileName: ${a.fileName}`);
        lines.push(`        contentType: ${a.contentType}`);
        lines.push(`        size: ${a.size}`);
        lines.push(`        s3Key: ${a.s3Key}`);
      }
    }
  }
}
