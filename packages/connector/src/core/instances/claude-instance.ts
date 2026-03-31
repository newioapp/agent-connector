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
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { BaseAgentInstance } from './base-agent-instance';
import { MessageQueue } from './message-queue';
import type { IncomingMessage } from '../newio-app';
import { Logger } from '../logger';

const SKIP_TOKEN = '_skip';
const log = new Logger('claude-instance');

/**
 * Resolve the path to the bundled Claude Code CLI shipped inside
 * `@anthropic-ai/claude-agent-sdk`. We use createRequire so resolution
 * works in both electron-vite dev mode and production CJS builds.
 */
function resolveClaudeCodeCli(): string {
  const ownRequire = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url);
  const sdkEntry = ownRequire.resolve('@anthropic-ai/claude-agent-sdk');
  return join(dirname(sdkEntry), 'cli.js');
}

/**
 * Resolve the absolute path to `node`. Electron's PATH when launched from
 * the Dock is minimal (/usr/bin:/bin) and won't include nvm/homebrew node.
 * We resolve once at module load time using a multi-step fallback.
 */
const resolvedNodePath: string = (() => {
  // 1. Try node on current PATH (works when launched from terminal)
  try {
    execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return 'node';
  } catch {
    // not on PATH
  }

  // 2. Ask the user's login shell for the full PATH
  const shell = process.env.SHELL ?? '/bin/zsh';
  try {
    const nodePath = execFileSync(shell, ['-ilc', 'which node'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb' },
    }).trim();
    if (nodePath) {
      return nodePath;
    }
  } catch {
    // shell resolution failed
  }

  // 3. Check common macOS / Linux locations
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 3000 });
      return candidate;
    } catch {
      // not here
    }
  }

  return 'node';
})();

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private readonly messageQueue = new MessageQueue();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    if (!this.app) {
      throw new Error('NewioApp not initialized');
    }
    this.app.onMessage((msg) => {
      if (!msg.isOwnMessage) {
        this.messageQueue.enqueue(msg);
      }
    });
    void this.processLoop();
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
      throw new Error(`Claude Code connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      throw new Error('Claude Code test failed: model returned an empty response');
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
        ...this.buildExecOptions(),
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

  /** Build executable-related query options, using config overrides or defaults. */
  private buildExecOptions(): { executable: 'node'; pathToClaudeCodeExecutable: string; model: string; cwd?: string } {
    return {
      executable: (this.config.claude?.nodePath ?? resolvedNodePath) as 'node',
      pathToClaudeCodeExecutable: this.config.claude?.claudeCodeCliPath ?? resolveClaudeCodeCli(),
      model: this.config.claude?.model ?? 'claude-sonnet-4-6',
      ...(this.config.claude?.cwd ? { cwd: this.config.claude.cwd } : {}),
    };
  }

  protected onStopped(): void {
    this.messageQueue.close();
  }

  // ---------------------------------------------------------------------------
  // Processing loop
  // ---------------------------------------------------------------------------

  private async processLoop(): Promise<void> {
    for await (const [conversationId, messages] of this.messageQueue.batches()) {
      await this.processBatch(conversationId, messages);
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

    console.log('------ user message -----');
    console.log(userText);
    const q: Query = query({
      prompt: singleAsyncIterable(userMessage),
      options: {
        ...this.buildExecOptions(),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: this.app.buildNewioInstruction({ customInstructions: this.config.claude.userPrompt }),
        },
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

    console.log('------ agent response -----');
    console.log(resultText);
    return resultText;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a single value as an AsyncIterable that yields it once. */
function singleAsyncIterable<T>(value: T): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        next() {
          if (done) {
            return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
          }
          done = true;
          return Promise.resolve({ value, done: false });
        },
      };
    },
  };
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
