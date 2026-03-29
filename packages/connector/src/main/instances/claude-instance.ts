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
import type { IncomingMessage } from '../newio-app';

const SKIP_TOKEN = '_skip';

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private sessionId?: string;
  private processing = false;

  /** conversationId → queued messages */
  private readonly messageQueue = new Map<string, IncomingMessage[]>();
  /** FIFO order of conversations with pending messages */
  private readonly pendingConversations: string[] = [];

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected onConnected(): void {
    if (!this.app) {
      throw new Error('NewioApp not initialized');
    }
    this.app.onMessage((msg) => {
      this.enqueue(msg);
    });
  }

  protected onStopped(): void {
    this.messageQueue.clear();
    this.pendingConversations.length = 0;
    this.processing = false;
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

  private async processBatch(conversationId: string, messages: readonly IncomingMessage[]): Promise<void> {
    if (!this.app || !this.config.claude) {
      return;
    }

    const prompt = formatPrompt(messages);
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
    if (!this.app || !this.config.claude) {
      return undefined;
    }

    const q: Query = query({
      prompt,
      options: {
        systemPrompt: this.app.buildSystemPrompt({ customInstructions: this.config.claude.systemPrompt }),
        model: this.config.claude.model,
        // No built-in tools — the agent is a pure messaging responder.
        // MCP tools for Newio actions (send DM, create group, etc.) will be added in C6.
        tools: [],
        // bypassPermissions: since tools=[], no permission prompts will occur.
        // This avoids the SDK hanging on a permission request with no handler.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Don't load any filesystem settings (~/.claude/settings.json, .claude/settings.json, etc.)
        // This isolates the agent from the host machine's Claude Code configuration.
        settingSources: [],
        // Persist session to disk (~/.claude/projects/) so resume works across query() calls.
        // This is what gives the agent cross-conversation memory.
        persistSession: true,
        maxTurns: 1,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        env: {
          ANTHROPIC_API_KEY: this.config.claude.apiKey,
        },
      },
    });

    let resultText: string | undefined;

    // The query yields SDKMessage events. Key types:
    // - 'system' (subtype 'init'): session initialization with tools, model, session_id
    // - 'assistant': Claude's response (BetaMessage with content blocks)
    // - 'result': final outcome — 'success' (has .result text) or error subtypes
    // - 'stream_event': partial streaming chunks (when includePartialMessages is true)
    // We only need the session_id (for resume) and the final result text.
    for await (const event of q as AsyncIterable<SDKMessage>) {
      if (!this.sessionId && 'session_id' in event && typeof event.session_id === 'string') {
        this.sessionId = event.session_id;
      }

      if (event.type === 'result') {
        if (event.subtype === 'success' && 'result' in event) {
          resultText = event.result;
        } else {
          console.error(`[Claude] Query ended with ${event.subtype}`, 'errors' in event ? event.errors : '');
        }
      }
    }

    return resultText;
  }
}

// ---------------------------------------------------------------------------
// Prompt formatting (YAML)
// ---------------------------------------------------------------------------

function formatPrompt(messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';

  if (isGroup) {
    return formatGroupBatch(first.conversationId, first.groupName, messages);
  }
  return formatDmBatch(first.conversationId, messages);
}

function formatSender(m: IncomingMessage): string {
  return [
    `    username: ${m.senderUsername ?? 'unknown'}`,
    `    displayName: ${m.senderDisplayName ?? 'Unknown'}`,
    `    accountType: ${m.senderAccountType ?? 'unknown'}`,
    `    inContact: ${String(m.inContact)}`,
  ].join('\n');
}

function formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const lines = [`conversationId: ${conversationId}`, `type: dm`, `from:`, formatSender(first), `messages:`];
  for (const m of messages) {
    lines.push(`  - message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}

function formatGroupBatch(
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
    lines.push(formatSender(m));
    lines.push(`    message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}
