/**
 * Claude agent instance — bridges Newio messages with Claude via the Anthropic Agent SDK.
 *
 * Uses a single persistent Claude session (v1 query API with resume) so the agent
 * maintains cross-conversation context. Incoming Newio messages are queued per
 * conversation and processed serially — one batch at a time.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BaseAgentInstance } from './base-agent-instance';
import { NewioApp, type IncomingMessage } from '../newio-app';
import type { ContactRecord } from '@newio/sdk';

const SKIP_TOKEN = '_skip';

// ---------------------------------------------------------------------------
// Message queue types
// ---------------------------------------------------------------------------

interface QueuedMessage {
  readonly conversationId: string;
  readonly conversationType: string;
  readonly groupName?: string;
  readonly senderUsername?: string;
  readonly senderDisplayName?: string;
  readonly inContact: boolean;
  readonly text: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private app?: NewioApp;
  private sessionId?: string;
  private processing = false;

  /** conversationId → queued messages */
  private readonly messageQueue = new Map<string, QueuedMessage[]>();
  /** FIFO order of conversations with pending messages */
  private readonly pendingConversations: string[] = [];

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    if (!this.client || !this.ws) {
      throw new Error('Client or WebSocket not initialized');
    }

    const me = await this.client.getMe({});
    if (!me.username) {
      throw new Error('Agent has no username');
    }

    this.app = new NewioApp(
      { userId: me.userId, username: me.username, displayName: me.displayName, ownerId: me.ownerId },
      this.client,
      this.ws,
    );
    await this.app.init();

    this.app.onMessage((msg) => {
      this.enqueue(msg);
    });
  }

  protected onStopped(): void {
    this.messageQueue.clear();
    this.pendingConversations.length = 0;
    this.processing = false;
    this.app = undefined;
    this.sessionId = undefined;
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private enqueue(msg: IncomingMessage): void {
    const existing = this.messageQueue.get(msg.conversationId);
    if (existing) {
      existing.push(msg);
    } else {
      this.messageQueue.set(msg.conversationId, [msg]);
      this.pendingConversations.push(msg.conversationId);
    }
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.pendingConversations.length === 0) {
      return;
    }

    this.processing = true;
    try {
      while (this.pendingConversations.length > 0) {
        const conversationId = this.pendingConversations.shift();
        if (!conversationId) {
          continue;
        }
        const messages = this.messageQueue.get(conversationId);
        this.messageQueue.delete(conversationId);

        if (!messages || messages.length === 0) {
          continue;
        }

        await this.processBatch(conversationId, messages);
      }
    } finally {
      this.processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Claude interaction
  // ---------------------------------------------------------------------------

  private async processBatch(conversationId: string, messages: readonly QueuedMessage[]): Promise<void> {
    if (!this.app || !this.config.claude) {
      return;
    }

    const prompt = this.formatPrompt(messages);
    const response = await this.queryAgent(prompt);

    if (!response || response.trim().toLowerCase() === SKIP_TOKEN) {
      return;
    }

    try {
      await this.app.sendMessage(conversationId, response.trim());
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Claude] Failed to send message to ${conversationId}: ${errMsg}`);
    }
  }

  private async queryAgent(prompt: string): Promise<string | undefined> {
    if (!this.config.claude) {
      return undefined;
    }

    const q: Query = query({
      prompt,
      options: {
        systemPrompt: this.buildSystemPrompt(),
        model: this.config.claude.model,
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        persistSession: true,
        maxTurns: 1,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        env: {
          ANTHROPIC_API_KEY: this.config.claude.apiKey,
        },
      },
    });

    let resultText: string | undefined;

    for await (const event of q as AsyncIterable<SDKMessage>) {
      // Capture session ID from the first message
      if (!this.sessionId && 'session_id' in event && typeof event.session_id === 'string') {
        this.sessionId = event.session_id;
      }

      if (event.type === 'result' && event.subtype === 'success' && 'result' in event) {
        resultText = event.result;
      }
    }

    return resultText;
  }

  // ---------------------------------------------------------------------------
  // Prompt formatting
  // ---------------------------------------------------------------------------

  private formatPrompt(messages: readonly QueuedMessage[]): string {
    const first = messages[0];

    const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';

    if (isGroup) {
      return this.formatGroupBatch(first.conversationId, first.groupName, messages);
    }
    return this.formatDmBatch(first.conversationId, messages);
  }

  private formatDmBatch(conversationId: string, messages: readonly QueuedMessage[]): string {
    const first = messages[0];
    const payload = {
      conversationId,
      type: 'dm',
      from: {
        username: first.senderUsername ?? 'unknown',
        displayName: first.senderDisplayName ?? 'Unknown',
        inContact: first.inContact,
      },
      messages: messages.map((m) => ({
        message: m.text,
        timestamp: m.timestamp,
      })),
    };
    return JSON.stringify(payload);
  }

  private formatGroupBatch(
    conversationId: string,
    groupName: string | undefined,
    messages: readonly QueuedMessage[],
  ): string {
    const payload = {
      conversationId,
      type: 'group',
      groupName: groupName ?? 'Unnamed Group',
      messages: messages.map((m) => ({
        from: {
          username: m.senderUsername ?? 'unknown',
          displayName: m.senderDisplayName ?? 'Unknown',
          inContact: m.inContact,
        },
        message: m.text,
        timestamp: m.timestamp,
      })),
    };
    return JSON.stringify(payload);
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    if (!this.app) {
      return '';
    }

    const { username, displayName } = this.app.identity;
    const ownerContact = this.findOwnerContact();
    const customPrompt = this.config.claude?.systemPrompt;

    const parts: string[] = [];

    parts.push(`## Background

You are using a messaging app. Your username is "${username}"${displayName ? `, your display name is "${displayName}"` : ''}. In the current session, multiple people can direct message you, and you may be in group chats as well.`);

    if (ownerContact) {
      parts.push(`## Relationships

- User "${ownerContact.friendDisplayName ?? ownerContact.friendUsername ?? 'Unknown'}" (username: "${ownerContact.friendUsername ?? 'unknown'}") is your owner.`);
    }

    if (customPrompt) {
      parts.push(`## Agent Instructions

${customPrompt}`);
    }

    parts.push(`## Message Format

You will receive messages as JSON. Each message batch is from a single conversation.

Direct message example:
\`\`\`json
{
  "conversationId": "abc-123",
  "type": "dm",
  "from": { "username": "alice", "displayName": "Alice", "inContact": true },
  "messages": [
    { "message": "Hey, how are you?", "timestamp": "2026-03-17T22:55:41.956Z" }
  ]
}
\`\`\`

Group message example:
\`\`\`json
{
  "conversationId": "def-456",
  "type": "group",
  "groupName": "Team Chat",
  "messages": [
    { "from": { "username": "bob", "displayName": "Bob", "inContact": true }, "message": "Meeting at 3?", "timestamp": "2026-03-17T23:01:02.241Z" },
    { "from": { "username": "carol", "displayName": "Carol", "inContact": false }, "message": "Works for me", "timestamp": "2026-03-17T23:01:15.000Z" }
  ]
}
\`\`\`

## Response Rules

- If you want to reply, respond with ONLY the message text. No JSON, no formatting, just the plain text message.
- If you don't need to reply, respond with exactly: ${SKIP_TOKEN}
- In group chats, only respond when the message is directed at you or relevant to you. Don't reply to every message.
- Be concise and natural, like a real person messaging.`);

    return parts.join('\n\n');
  }

  private findOwnerContact(): ContactRecord | undefined {
    if (!this.app) {
      return undefined;
    }
    const ownerId = this.app.identity.ownerId;
    if (!ownerId) {
      return undefined;
    }
    return this.app.getContact(ownerId);
  }
}
