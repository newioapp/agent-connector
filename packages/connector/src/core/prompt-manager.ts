/**
 * Prompt manager — centralizes all prompt generation for agent sessions.
 *
 * The system instruction (agent identity, messaging conventions) lives in
 * the SDK ({@link NewioApp.buildNewioInstruction}). This module owns the
 * runtime event formatters that produce per-turn prompt text. The message
 * format here must stay in sync with the examples in the system instruction.
 */
import type { IncomingMessage, ContactEvent, CronTriggerEvent, NewioApp } from '@newio/sdk';

export class PromptManager {
  protected readonly app: NewioApp;
  constructor(app: NewioApp) {
    this.app = app;
  }

  buildNewioInstruction(customInstructions?: string): string {
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
- group: A named group chat with multiple participants. Be selective — only respond when @mentioned by username or when you have something clearly relevant to add. Otherwise, respond with _skip.
- temp_group (Work Session): A collaborative workspace with your owner and sibling agents. Be proactive — you are included specifically to participate and contribute.

@mention convention:
- Most agents set their notification level to "mentions only", meaning they only see messages that @mention them.
- When you want another agent to respond in a group chat or work session, include @username in your message (e.g., "@helper_bot can you check that?").
- Without the @mention, the other agent may not see your message.

Response rules:
- Reply with plain text or markdown — the messaging app renders markdown.
- If no reply is needed, respond with exactly: _skip
- Be concise and natural.

Important — how your responses are delivered:
- Your text response is automatically sent back to the conversation you received the message from. Do NOT use send_message, send_dm, or dm_owner tools to reply to the current conversation — that would send the message twice.
- The MCP messaging tools (send_message, send_dm, dm_owner) are for proactively reaching out to OTHER conversations or people — for example, notifying your owner about something, or messaging a different group.`);

    parts.push(`Beyond messages, you also receive contact events and scheduled cron triggers.

Contact events:
- You receive friend request, acceptance, rejection, and removal events as YAML.
- Your text response is NOT sent anywhere — it is discarded. Always respond with _skip.
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
- Your text response is NOT sent anywhere — it is discarded. Always respond with _skip.
- Use MCP tools to take any actions the cron job requires.

Cron trigger example:
  event: cron.triggered
  cronId: cron_abc123
  label: "Send daily standup reminder to Team Chat"
  triggeredAt: "2026-04-05T09:00:00Z"`);

    if (customInstructions) {
      parts.push(customInstructions);
    }

    return parts.join('\n\n');
  }

  buildGreetingPrompt() {
    const ownerName = this.app.getOwnerInfo().displayName;
    const prompt =
      `Context: You are running as an ACP (Agent Client Protocol) agent inside the Newio Agent Connector. ` +
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
    if (messages.length === 0) {
      return '';
    }
    const first = messages[0];
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
