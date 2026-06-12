/**
 * PuppetAgent — a deterministic ACP agent (the "server"/agent side of the
 * protocol). The connector spawns it as a `custom` agent and drives it exactly
 * like a real one: initialize → newSession/loadSession → prompt → cancel.
 *
 * Behavior is delegated to a {@link PuppetControl}, so a test can script each
 * prompt turn live over the control socket. Replies are emitted as
 * `agent_message_chunk` updates, which the connector auto-delivers to the
 * current conversation — so the basic message round-trip needs no MCP at all.
 *
 * On `newSession`/`loadSession` the puppet spawns the Newio MCP bridge the
 * connector asked for. It never speaks MCP over it; spawning just lets the
 * bridge connect to the connector's UDS socket so the connector's per-launch
 * MCP-wiring wait resolves immediately instead of hitting its ~10s timeout.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { PuppetControl } from './control.js';

/** Whether to spawn the Newio MCP bridge on session create/load. */
const SPAWN_MCP_BRIDGE = process.env.PUPPET_SPAWN_MCP_BRIDGE !== '0';

interface PuppetSession {
  /** Aborts the in-flight prompt turn, if any. */
  pending?: AbortController;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Concatenate the text content blocks of a prompt into a single string. */
function extractPromptText(blocks: readonly acp.ContentBlock[]): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  return text;
}

export class PuppetAgent implements acp.Agent {
  private readonly sessions = new Map<string, PuppetSession>();
  private readonly bridges: ChildProcess[] = [];

  constructor(
    private readonly conn: acp.AgentSideConnection,
    private readonly control: PuppetControl,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'newio-acp-puppet', version: '0.1.0' },
      // loadSession is mandatory: the connector rejects agents without it.
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {});
    this.spawnBridges(params.mcpServers);
    this.control.onSessionNew(sessionId);
    return { sessionId };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.sessions.set(params.sessionId, {});
    this.spawnBridges(params.mcpServers);
    this.control.onSessionLoad(params.sessionId);
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId) ?? {};
    this.sessions.set(params.sessionId, session);

    session.pending?.abort();
    const abort = new AbortController();
    session.pending = abort;

    const text = extractPromptText(params.prompt);
    const turn = await this.control.resolveTurn(params.sessionId, text);

    for (const action of turn.actions) {
      if (abort.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      if (turn.delayMs) {
        await sleep(turn.delayMs);
      }
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: action.kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: action.text },
        },
      });
    }

    session.pending = undefined;
    if (abort.signal.aborted) {
      return { stopReason: 'cancelled' };
    }
    return { stopReason: turn.stopReason ?? 'end_turn' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pending?.abort();
    this.control.onCancel(params.sessionId);
  }

  /** Kill any spawned MCP bridge children. Called on process shutdown. */
  dispose(): void {
    for (const child of this.bridges) {
      child.kill('SIGTERM');
    }
    this.bridges.length = 0;
  }

  /** Spawn each requested MCP bridge so it connects to the connector's UDS socket. */
  private spawnBridges(servers: readonly acp.McpServer[] | undefined): void {
    if (!SPAWN_MCP_BRIDGE || !servers) {
      return;
    }
    for (const server of servers) {
      if (!('command' in server)) {
        continue;
      }
      try {
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const pair of server.env) {
          env[pair.name] = pair.value;
        }
        const child = spawn(server.command, server.args, { stdio: 'ignore', env });
        child.on('error', () => {});
        this.bridges.push(child);
      } catch {
        // Best-effort: a missing bridge only costs the connector its MCP-wiring
        // timeout; the message round-trip still works without it.
      }
    }
  }
}
