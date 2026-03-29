/**
 * Claude agent instance — bridges Newio messages with Claude via the Anthropic Agent SDK.
 *
 * Uses streaming input mode with `continue: true` so the SDK manages conversation
 * history across turns. Each turn passes a new user message via AsyncIterable.
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
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private processing = false;

  /** conversationId → queued incoming messages */
  private readonly messageQueue = new Map<string, IncomingMessage[]>();
  /** FIFO order of conversations with pending messages */
  private readonly pendingConversations: string[] = [];

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

    let greeting: string | undefined;
    try {
      greeting = await this.generateGreetingMessage();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`LLM connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().toLowerCase() === SKIP_TOKEN) {
      throw new Error('LLM connection test failed: model returned an empty response');
    }

    await this.app.dmOwner(greeting.trim());
  }

  /**
   * Generate a greeting message using Claude. No system prompt — just a simple
   * instruction to produce a personalized greeting for the owner.
   */
  private async generateGreetingMessage(): Promise<string | undefined> {
    if (!this.app || !this.config.claude) {
      return undefined;
    }

    const ownerName = this.app.getOwnerDisplayName() ?? 'your owner';
    const prompt = `You just connected to the Newio messaging platform. Send a brief, friendly greeting to ${ownerName} to let them know you are online and ready. Keep it to 1-2 sentences.`;

    const q: Query = query({
      prompt,
      options: {
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
          log.error(`Greeting query ended with ${event.subtype}`, 'errors' in event ? event.errors : '');
        }
      }
    }

    return resultText;
  }

  protected onStopped(): void {
    this.messageQueue.clear();
    this.pendingConversations.length = 0;
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

    const userText = formatPrompt(messages);

    // Set thinking status
    this.app.setStatus('thinking', conversationId);

    let response: string | undefined;
    try {
      response = await this.queryAgentStreaming(conversationId, userText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Query failed for ${conversationId}: ${errMsg}`);
      this.app.setStatus(null, conversationId);
      return;
    }

    // Clear status
    this.app.setStatus(null, conversationId);

    if (!response || response.trim().toLowerCase() === SKIP_TOKEN) {
      return;
    }

    try {
      await this.app.sendMessage(conversationId, response.trim());
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to send message to ${conversationId}: ${errMsg}`);
    }
  }

  /**
   * Query Claude with streaming output. Uses `continue: true` so the SDK
   * manages conversation history across turns. Transitions status from
   * 'thinking' to 'typing' on first text token.
   */
  private async queryAgentStreaming(conversationId: string, userText: string): Promise<string | undefined> {
    if (!this.app || !this.config.claude) {
      return undefined;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: userText },
      parent_tool_use_id: null,
    };

    // Wrap single message as async iterable for streaming input
    const asyncMessages: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next() {
            if (done) {
              return Promise.resolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
            }
            done = true;
            return Promise.resolve({ value: userMessage, done: false });
          },
        };
      },
    };

    const q: Query = query({
      prompt: asyncMessages,
      options: {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: this.app.buildNewioInstruction({ customInstructions: this.config.claude.userPrompt }),
        },
        model: this.config.claude.model,
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        continue: true,
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
        this.app.setStatus('typing', conversationId);
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
