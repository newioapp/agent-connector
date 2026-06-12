/**
 * PuppetDriver — runs inside a test and live-controls one or more puppets.
 *
 * It listens on a Unix socket, hands the path to the connector via the puppet's
 * `PUPPET_CONTROL_SOCKET` env var, and answers each prompt turn from a handler
 * the test supplies. It also records every prompt for assertions.
 *
 * Typical use:
 *   const driver = await PuppetDriver.start();
 *   driver.onPrompt(({ text }) => (text.includes(marker) ? marker + ':reply' : 'hello'));
 *   // configure the connector's custom agent with:
 *   //   executablePath: driver.executablePath
 *   //   envVars:        { PUPPET_CONTROL_SOCKET: driver.socketPath }
 */
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LineDecoder, encodeLine, type TurnAction, type TurnInstruction } from './protocol.js';

/** A prompt turn the driver is being asked to answer. */
export interface PuppetPrompt {
  readonly sessionId: string;
  readonly text: string;
}

/** The outcome of a `tool` action the puppet executed, reported back for assertions. */
export interface PuppetToolResult {
  readonly name: string;
  readonly isError: boolean;
  readonly text: string;
}

/**
 * What a prompt handler may return:
 * - `string` → a single `message` action ending the turn,
 * - `TurnAction[]` → those actions in order,
 * - a partial {@link TurnInstruction} (without `t`/`id`) → full control of the turn.
 */
export type PromptHandlerResult = string | readonly TurnAction[] | Omit<TurnInstruction, 't' | 'id'>;

export type PromptHandler = (prompt: PuppetPrompt) => PromptHandlerResult | Promise<PromptHandlerResult>;

export interface PuppetDriverOptions {
  /** Override the puppet entry file. Defaults to this package's built `dist/bin.js`. */
  readonly binPath?: string;
  /** Override the runtime used to launch the puppet. Defaults to the current Node binary. */
  readonly command?: string;
  /** Default reply when no handler is registered (keeps the connector's greeting round-trip alive). */
  readonly defaultReply?: string;
}

/** Distinguish a full instruction object from a bare action array (Array.isArray can't narrow `readonly`). */
function isInstruction(
  result: readonly TurnAction[] | Omit<TurnInstruction, 't' | 'id'>,
): result is Omit<TurnInstruction, 't' | 'id'> {
  return !Array.isArray(result);
}

function normalize(result: PromptHandlerResult, id: number): TurnInstruction {
  if (typeof result === 'string') {
    return { t: 'turn', id, actions: [{ kind: 'message', text: result }], stopReason: 'end_turn' };
  }
  if (isInstruction(result)) {
    return { t: 'turn', id, ...result };
  }
  return { t: 'turn', id, actions: result, stopReason: 'end_turn' };
}

export class PuppetDriver {
  private readonly recorded: PuppetPrompt[] = [];
  private readonly recordedToolResults: PuppetToolResult[] = [];
  private readonly promptWaiters: { predicate: (p: PuppetPrompt) => boolean; resolve: (p: PuppetPrompt) => void }[] =
    [];
  private readonly toolWaiters: {
    predicate: (r: PuppetToolResult) => boolean;
    resolve: (r: PuppetToolResult) => void;
  }[] = [];
  private handler?: PromptHandler;

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly binPath: string,
    private readonly command: string,
    private readonly defaultReply: string,
  ) {}

  static start(options: PuppetDriverOptions = {}): Promise<PuppetDriver> {
    const socketPath = join(tmpdir(), `newio-puppet-${process.pid}-${randomUUID()}.sock`);
    const binPath = options.binPath ?? fileURLToPath(new URL('./bin.js', import.meta.url));
    const command = options.command ?? process.execPath;
    const defaultReply = options.defaultReply ?? 'ok';
    const server = createServer();

    const driver = new PuppetDriver(server, socketPath, binPath, command, defaultReply);
    server.on('connection', (socket) => driver.onConnection(socket));

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve(driver);
      });
    });
  }

  /** The `executablePath` to put in the connector's `custom` agent config (`<command> <binPath>`). */
  get executablePath(): string {
    return `${this.command} ${this.binPath}`;
  }

  /** Every prompt the driver has answered so far, in order. */
  get prompts(): readonly PuppetPrompt[] {
    return this.recorded;
  }

  /** Every `tool` action result the puppet has reported, in order. */
  get toolResults(): readonly PuppetToolResult[] {
    return this.recordedToolResults;
  }

  /** Register the handler that answers each prompt turn. Replaces any previous handler. */
  onPrompt(handler: PromptHandler): void {
    this.handler = handler;
  }

  /** Resolve once a prompt matching `predicate` arrives (checks already-recorded prompts first). */
  waitForPrompt(predicate: (p: PuppetPrompt) => boolean, timeoutMs = 30_000): Promise<PuppetPrompt> {
    const existing = this.recorded.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.promptWaiters.findIndex((w) => w.resolve === wrapped);
        if (idx >= 0) {
          this.promptWaiters.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for a matching puppet prompt after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (p: PuppetPrompt): void => {
        clearTimeout(timer);
        resolve(p);
      };
      this.promptWaiters.push({ predicate, resolve: wrapped });
    });
  }

  /**
   * Resolve once a tool result matching `predicate` arrives. Tool results are
   * reported over the control socket independently of the ACP prompt response,
   * so they may land slightly after `prompt()` resolves — await this rather than
   * reading {@link toolResults} immediately.
   */
  waitForToolResult(predicate: (r: PuppetToolResult) => boolean, timeoutMs = 30_000): Promise<PuppetToolResult> {
    const existing = this.recordedToolResults.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.toolWaiters.findIndex((w) => w.resolve === wrapped);
        if (idx >= 0) {
          this.toolWaiters.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for a matching tool result after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped = (r: PuppetToolResult): void => {
        clearTimeout(timer);
        resolve(r);
      };
      this.toolWaiters.push({ predicate, resolve: wrapped });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private onConnection(socket: Socket): void {
    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => {
      for (const value of decoder.push(chunk)) {
        void this.onMessage(value, socket);
      }
    });
    socket.on('error', () => {});
  }

  private async onMessage(value: unknown, socket: Socket): Promise<void> {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const message: Record<string, unknown> = { ...value };
    if (message.t === 'tool_result') {
      if (typeof message.name === 'string' && typeof message.text === 'string') {
        const result: PuppetToolResult = {
          name: message.name,
          isError: message.isError === true,
          text: message.text,
        };
        this.recordedToolResults.push(result);
        for (let i = this.toolWaiters.length - 1; i >= 0; i--) {
          const waiter = this.toolWaiters[i];
          if (waiter && waiter.predicate(result)) {
            this.toolWaiters.splice(i, 1);
            waiter.resolve(result);
          }
        }
      }
      return;
    }
    if (message.t !== 'prompt') {
      return; // other lifecycle events (hello/session_*/cancelled) are not acted on yet
    }
    if (typeof message.id !== 'number' || typeof message.sessionId !== 'string' || typeof message.text !== 'string') {
      return;
    }

    const prompt: PuppetPrompt = { sessionId: message.sessionId, text: message.text };
    this.recorded.push(prompt);
    this.notifyWaiters(prompt);

    const result = this.handler ? await this.handler(prompt) : this.defaultReply;
    const turn = normalize(result, message.id);
    socket.write(encodeLine(turn));
  }

  private notifyWaiters(prompt: PuppetPrompt): void {
    for (let i = this.promptWaiters.length - 1; i >= 0; i--) {
      const waiter = this.promptWaiters[i];
      if (waiter && waiter.predicate(prompt)) {
        this.promptWaiters.splice(i, 1);
        waiter.resolve(prompt);
      }
    }
  }
}
