/**
 * Puppet-side control: how the spawned ACP agent decides what to do for each
 * prompt turn.
 *
 * - {@link SocketControl} connects back to the test's PuppetDriver over the
 *   `PUPPET_CONTROL_SOCKET` Unix socket and asks it (live) per turn.
 * - {@link DefaultControl} is the standalone fallback when no control socket is
 *   configured — it replies with a fixed message so the puppet is still usable
 *   (and the connector's startup greeting round-trip succeeds) without a driver.
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { LineDecoder, encodeLine, type PuppetMessage, type TurnInstruction } from './protocol.js';

/** Drives a single puppet's behavior. The puppet calls these as ACP requests arrive. */
export interface PuppetControl {
  /** Connect any backing transport. Resolves once ready (no-op for the default). */
  connect(): Promise<void>;
  onSessionNew(sessionId: string): void;
  onSessionLoad(sessionId: string): void;
  /** Resolve what the puppet should do for this prompt turn. */
  resolveTurn(sessionId: string, text: string): Promise<TurnInstruction>;
  /** Report the outcome of a `tool` action back to the driver, keyed by the turn `id`. */
  reportToolResult(turnId: number, name: string, isError: boolean, text: string): void;
  onCancel(sessionId: string): void;
  close(): void;
}

/** Default reply used by the standalone fallback and when the control socket drops mid-turn. */
function fallbackTurn(id: number, text: string): TurnInstruction {
  return { t: 'turn', id, actions: [{ kind: 'message', text }], stopReason: 'end_turn' };
}

/** Standalone behavior — replies with a fixed message, no driver required. */
export class DefaultControl implements PuppetControl {
  private nextId = 1;

  constructor(private readonly reply: string = 'ok') {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  onSessionNew(): void {}
  onSessionLoad(): void {}
  onCancel(): void {}
  reportToolResult(): void {}
  close(): void {}

  resolveTurn(): Promise<TurnInstruction> {
    return Promise.resolve(fallbackTurn(this.nextId++, this.reply));
  }
}

/** Narrow an arbitrary decoded object to a {@link TurnInstruction}. Returns undefined if it isn't one. */
function asTurnInstruction(value: unknown): TurnInstruction | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const obj: Record<string, unknown> = { ...value };
  if (obj.t !== 'turn' || typeof obj.id !== 'number' || !Array.isArray(obj.actions)) {
    return undefined;
  }
  return {
    t: 'turn',
    id: obj.id,
    actions: obj.actions,
    stopReason: obj.stopReason === 'cancelled' || obj.stopReason === 'refusal' ? obj.stopReason : 'end_turn',
    delayMs: typeof obj.delayMs === 'number' ? obj.delayMs : undefined,
  };
}

/** Live, driver-controlled behavior over the `PUPPET_CONTROL_SOCKET` Unix socket. */
export class SocketControl implements PuppetControl {
  private socket?: Socket;
  private readonly decoder = new LineDecoder();
  private nextId = 1;
  private connected = false;
  private readonly pending = new Map<number, (turn: TurnInstruction) => void>();

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.connected = true;
        this.send({ t: 'hello', pid: process.pid });
        resolve();
      });
      socket.once('error', (err) => {
        if (!this.connected) {
          reject(err);
        }
      });
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('close', () => this.onClose());
    });
  }

  private onData(chunk: string): void {
    for (const value of this.decoder.push(chunk)) {
      const turn = asTurnInstruction(value);
      if (turn) {
        const resolveTurn = this.pending.get(turn.id);
        if (resolveTurn) {
          this.pending.delete(turn.id);
          resolveTurn(turn);
        }
      }
    }
  }

  /** Resolve every outstanding turn with a fallback so the puppet never wedges if the driver drops. */
  private onClose(): void {
    this.connected = false;
    for (const [id, resolveTurn] of this.pending) {
      resolveTurn(fallbackTurn(id, 'ok'));
    }
    this.pending.clear();
  }

  private send(message: PuppetMessage): void {
    this.socket?.write(encodeLine(message));
  }

  onSessionNew(sessionId: string): void {
    this.send({ t: 'session_new', sessionId });
  }

  onSessionLoad(sessionId: string): void {
    this.send({ t: 'session_load', sessionId });
  }

  onCancel(sessionId: string): void {
    this.send({ t: 'cancelled', sessionId });
  }

  reportToolResult(turnId: number, name: string, isError: boolean, text: string): void {
    this.send({ t: 'tool_result', id: turnId, name, isError, text });
  }

  resolveTurn(sessionId: string, text: string): Promise<TurnInstruction> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.connected) {
        resolve(fallbackTurn(id, 'ok'));
        return;
      }
      this.pending.set(id, resolve);
      this.send({ t: 'prompt', id, sessionId, text });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
