/**
 * Claude agent instance — bridges Newio messages with Claude via the Anthropic Agent SDK.
 *
 * Uses streaming input mode: each turn passes the full system prompt + conversation
 * history as an AsyncIterable<SDKUserMessage>. This supports multi-turn context
 * without relying on the SDK's built-in session persistence.
 *
 * Uses streaming output: iterates SDKMessage events to detect when the model starts
 * generating tokens, enabling thinking → typing status transitions.
 *
 * Incoming Newio messages are queued per conversation and processed serially.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { BaseAgentInstance } from './base-agent-instance';
import type { IncomingMessage } from '../newio-app';
import { Logger } from '../../shared/logger';

const SKIP_TOKEN = '_skip';
const log = new Logger('claude-instance');

// ---------------------------------------------------------------------------
// Conversation history — tracks messages per conversation for multi-turn context
// ---------------------------------------------------------------------------

interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private processing = false;

  /** conversationId → queued incoming messages */
  private readonly messageQueue = new Map<string, IncomingMessage[]>();
  /** FIFO order of conversations with pending messages */
  private readonly pendingConversations: string[] = [];
  /** conversationId → conversation turn history for multi-turn context */
  private readonly conversationHistory = new Map<string, ConversationTurn[]>();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    if (!this.app) {
      throw new Error('NewioApp not initialized');
    }
    this.app.onMessage((msg) => {
      this.enqueue(msg);
    });
    await this.sendGreeting();
  }

  /**
   * Send a greeting DM to the owner to verify the LLM connection works.
   * Throws on failure so BaseAgentInstance.start() surfaces the error to the UI.
   */
  private async sendGreeting(): Promise<void> {
    if (!this.app?.identity.ownerId) {
      return;
    }

    const prompt =
      'You just connected to the Newio messaging platform. Send a brief, friendly greeting to your owner to let them know you are online and ready. Keep it to 1-2 sentences.';

    let response: string | undefined;
    try {
      response = await this.queryAgent(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`LLM connection test failed: ${message}`);
    }

    if (!response || response.trim().toLowerCase() === SKIP_TOKEN) {
      throw new Error('LLM connection test failed: model returned an empty response');
    }

    await this.app.dmOwner(response.trim());
  }

  protected onStopped(): void {
    this.messageQueue.clear();
    this.pendingConversations.length = 0;
    this.conversationHistory.clear();
    this.processing = false;
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private enqueue(msg: IncomingMessage): void {
    if (msg.isOwnMessage) {
      return;
    }
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
  // Claude interaction — streaming input + streaming output
  // ---------------------------------------------------------------------------

  private async processBatch(conversationId: string, messages: readonly IncomingMessage[]): Promise<void> {
    if (!this.app || !this.config.claude) {
      return;
    }

    // Build the user turn from the incoming batch
    const userText = formatPrompt(messages);

    // Track in conversation history
    const history = this.conversationHistory.get(conversationId) ?? [];
    history.push({ role: 'user', text: userText });

    // Set thinking status
    this.app.setStatus(conversationId, 'thinking');

    let response: string | undefined;
    try {
      response = await this.queryAgentStreaming(conversationId, history);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Query failed for ${conversationId}: ${errMsg}`);
      this.app.setStatus(conversationId, null);
      return;
    }

    // Clear status
    this.app.setStatus(conversationId, null);

    if (!response || response.trim().toLowerCase() === SKIP_TOKEN) {
      // Track the skip as an assistant turn so context stays coherent
      history.push({ role: 'assistant', text: SKIP_TOKEN });
      this.conversationHistory.set(conversationId, history);
      return;
    }

    const trimmed = response.trim();

    // Track assistant response in history
    history.push({ role: 'assistant', text: trimmed });
    this.conversationHistory.set(conversationId, history);

    try {
      await this.app.sendMessage(conversationId, trimmed);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to send message to ${conversationId}: ${errMsg}`);
    }
  }

  /**
   * Query Claude with streaming input (full history) and streaming output (token-level events).
   * Transitions status from 'thinking' to 'typing' on first text token.
   */
  private async queryAgentStreaming(
    conversationId: string,
    history: readonly ConversationTurn[],
  ): Promise<string | undefined> {
    if (!this.app || !this.config.claude) {
      return undefined;
    }

    // Build the messages array for streaming input
    const sdkMessages: SDKUserMessage[] = history.map((turn) => ({
      type: 'user' as const,
      message: {
        role: turn.role,
        content: turn.text,
      },
      parent_tool_use_id: null,
    }));

    // Create an async iterable that yields all messages then completes
    function* messageStream(): Generator<SDKUserMessage> {
      for (const msg of sdkMessages) {
        yield msg;
      }
    }

    // Wrap sync generator as async iterable for the SDK
    const asyncMessages: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        const iter = messageStream();
        return {
          next() {
            return Promise.resolve(iter.next());
          },
        };
      },
    };

    const q: Query = query({
      prompt: asyncMessages,
      options: {
        systemPrompt: this.app.buildSystemPrompt({ customInstructions: this.config.claude.systemPrompt }),
        model: this.config.claude.model,
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        includePartialMessages: true,
        env: {
          ANTHROPIC_API_KEY: this.config.claude.apiKey,
        },
      },
    });

    let resultText: string | undefined;
    let sentTyping = false;

    for await (const event of q as AsyncIterable<SDKMessage>) {
      // Detect first streaming token → switch to 'typing'
      if (!sentTyping && event.type === 'stream_event') {
        this.app.setStatus(conversationId, 'typing');
        sentTyping = true;
      }

      if (event.type === 'result') {
        if (event.subtype === 'success' && 'result' in event) {
          resultText = event.result;
        } else {
          log.error(`Query ended with ${event.subtype}`, 'errors' in event ? event.errors : '');
        }
      }
    }

    return resultText;
  }

  /**
   * Simple single-prompt query (used for greeting only).
   * Does not use streaming input since there's no conversation history.
   */
  private async queryAgent(prompt: string): Promise<string | undefined> {
    if (!this.app || !this.config.claude) {
      return undefined;
    }

    const q: Query = query({
      prompt,
      options: {
        systemPrompt: this.app.buildSystemPrompt({ customInstructions: this.config.claude.systemPrompt }),
        model: this.config.claude.model,
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        env: {
          ANTHROPIC_API_KEY: this.config.claude.apiKey,
        },
      },
    });

    let resultText: string | undefined;

    for await (const event of q as AsyncIterable<SDKMessage>) {
      if (event.type === 'result') {
        if (event.subtype === 'success' && 'result' in event) {
          resultText = event.result;
        } else {
          log.error(`Query ended with ${event.subtype}`, 'errors' in event ? event.errors : '');
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
