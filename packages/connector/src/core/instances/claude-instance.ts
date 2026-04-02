/**
 * Claude agent instance — bridges Newio messages with Claude via the Anthropic Agent SDK.
 *
 * Uses streaming input mode with `continue: true` so the SDK manages conversation
 * history across turns. Each turn passes a new user message via AsyncIterable.
 *
 * TODO: Refactor to multi-session architecture (one session per conversation).
 * Currently uses a single implicit session — all conversations share one context window.
 * This will be addressed in a follow-up PR.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { BaseAgentInstance } from './base-agent-instance';
import type { AgentSession, SessionStatusListener } from '../agent-session';
import { Logger } from '../logger';

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
 */
const resolvedNodePath: string = (() => {
  try {
    execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return 'node';
  } catch {
    // not on PATH
  }

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
// Claude session — temporary single-session wrapper
// ---------------------------------------------------------------------------

/**
 * Temporary AgentSession implementation for Claude that wraps the existing
 * streaming query logic. Will be replaced with proper multi-session support.
 */
class ClaudeSession implements AgentSession {
  readonly correlationId: string;
  private readonly instance: ClaudeInstance;
  statusListener: SessionStatusListener = () => {};

  constructor(correlationId: string, instance: ClaudeInstance) {
    this.correlationId = correlationId;
    this.instance = instance;
  }

  async prompt(text: string): Promise<string | undefined> {
    return this.instance.queryAgent(text, this.statusListener);
  }

  onStatus(listener: SessionStatusListener): void {
    this.statusListener = listener;
  }

  dispose(): void {
    // No-op for now — Claude sessions are stateless per query
  }
}

// ---------------------------------------------------------------------------
// ClaudeInstance
// ---------------------------------------------------------------------------

export class ClaudeInstance extends BaseAgentInstance {
  private sessionCounter = 0;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    await this.sendGreeting();
  }

  private async sendGreeting(): Promise<void> {
    const app = this.requireApp();
    if (!app.identity.ownerId) {
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

    await app.dmOwner(greeting.trim());
  }

  private async generateGreetingMessage(): Promise<string | undefined> {
    const app = this.requireApp();
    if (!this.config.claude) {
      return undefined;
    }

    const ownerName = app.getOwnerDisplayName() ?? 'your owner';
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

  private buildExecOptions(): { executable: 'node'; pathToClaudeCodeExecutable: string; model: string; cwd?: string } {
    return {
      executable: (this.config.claude?.nodePath ?? resolvedNodePath) as 'node',
      pathToClaudeCodeExecutable: this.config.claude?.claudeCodeCliPath ?? resolveClaudeCodeCli(),
      model: this.config.claude?.model ?? 'claude-sonnet-4-6',
      ...(this.config.claude?.cwd ? { cwd: this.config.claude.cwd } : {}),
    };
  }

  protected onStopped(): void {
    // Session cleanup handled by BaseAgentInstance
  }

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected createSession(): Promise<AgentSession> {
    this.sessionCounter++;
    return Promise.resolve(new ClaudeSession(`claude-${String(this.sessionCounter)}`, this));
  }

  protected resumeSession(correlationId: string): Promise<AgentSession> {
    // Claude sessions are stateless per query — resume is the same as create
    return Promise.resolve(new ClaudeSession(correlationId, this));
  }

  // ---------------------------------------------------------------------------
  // Claude query — used by ClaudeSession.prompt()
  // ---------------------------------------------------------------------------

  /** @internal — called by ClaudeSession */
  async queryAgent(userText: string, statusListener: SessionStatusListener): Promise<string | undefined> {
    const app = this.requireApp();
    if (!this.config.claude) {
      return undefined;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: userText },
      parent_tool_use_id: null,
    };

    const q: Query = query({
      prompt: singleAsyncIterable(userMessage),
      options: {
        ...this.buildExecOptions(),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: app.buildNewioInstruction({ customInstructions: this.config.claude.userPrompt }),
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

    statusListener('thinking');
    for await (const event of q as AsyncIterable<SDKMessage>) {
      switch (event.type) {
        case 'assistant':
          statusListener('typing');
          break;
        case 'tool_progress':
          statusListener('tool_calling');
          break;
        case 'result':
          if (event.subtype === 'success' && 'result' in event) {
            resultText = event.result;
          } else {
            log.error(`Query ended with ${event.subtype}`, 'errors' in event ? event.errors : '');
          }
          break;
        default:
          break;
      }
    }
    statusListener('idle');

    return resultText;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
