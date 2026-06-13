/**
 * PuppetAgent — a deterministic ACP agent (the "server"/agent side of the
 * protocol). The connector spawns it as a `custom` agent and drives it exactly
 * like a real one: initialize → newSession/loadSession → prompt → cancel → close.
 *
 * Behavior is delegated to a {@link PuppetControl}, so a test can script each
 * prompt turn live over the control socket. A turn is a list of actions:
 *   - `message` / `thought` → streamed as `agent_message_chunk`/`agent_thought_chunk`
 *     (the connector auto-delivers messages to the current conversation, so the
 *     basic reply path needs no MCP), and
 *   - `tool` → a real MCP tool call (`send_message`, `add_memory`, …) over the
 *     connector-provided MCP server, with the result reported back to the driver.
 *
 * The puppet connects to the MCP server(s) the connector hands it at session
 * setup via an injectable {@link McpConnector} (a real stdio client in
 * production, a fake in unit tests). Connecting also lets the connector's
 * per-launch MCP-wiring wait resolve immediately instead of hitting its timeout.
 */
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { PuppetControl } from './control.js';
import type { PermissionTurnOption } from './protocol.js';
import { StdioMcpConnector, type McpConnection, type McpConnector, type McpToolResult } from './mcp-connector.js';

interface PuppetSession {
  /** Aborts the in-flight prompt turn, if any. */
  pending?: AbortController;
  /** MCP connections opened for this session (resolves to [] when none were provided). */
  readonly mcp: Promise<McpConnection[]>;
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

  constructor(
    private readonly conn: acp.AgentSideConnection,
    private readonly control: PuppetControl,
    private readonly mcpConnector: McpConnector = new StdioMcpConnector(),
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'newio-acp-puppet', version: '0.1.0' },
      agentCapabilities: {
        // loadSession is mandatory: the connector rejects agents without it.
        loadSession: true,
        // Advertise close so the connector exercises its session-dispose path
        // (session rotation / idle teardown) against the puppet.
        sessionCapabilities: { close: {} },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { mcp: this.connectMcp(params.mcpServers) });
    this.control.onSessionNew(sessionId);
    return { sessionId };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.sessions.set(params.sessionId, { mcp: this.connectMcp(params.mcpServers) });
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
    const session = this.sessions.get(params.sessionId) ?? { mcp: Promise.resolve([]) };
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
      if (action.kind === 'tool') {
        const result = await this.callTool(session, action.name, action.args ?? {});
        this.control.reportToolResult(turn.id, action.name, result.isError, result.text);
      } else if (action.kind === 'permission') {
        const { outcome, optionId } = await this.requestPermission(params.sessionId, action.title, action.options);
        this.control.reportPermissionResult(turn.id, params.sessionId, outcome, optionId);
      } else {
        await this.conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: action.kind === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: action.text },
          },
        });
      }
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

  async unstable_closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    await this.closeSessionMcp(params.sessionId);
    this.sessions.delete(params.sessionId);
    return {};
  }

  /** Close every session's MCP connections. Called on process shutdown (best-effort). */
  dispose(): void {
    for (const sessionId of this.sessions.keys()) {
      void this.closeSessionMcp(sessionId);
    }
    this.sessions.clear();
  }

  /**
   * Issue an ACP `session/request_permission` and normalize the response. The
   * connector blocks this call until the owner answers the resulting ActionRequest.
   * Never throws — a rejected/failed request is reported as `cancelled`.
   */
  private async requestPermission(
    sessionId: string,
    title: string,
    options: readonly PermissionTurnOption[],
  ): Promise<{ outcome: 'selected' | 'cancelled'; optionId?: string }> {
    try {
      const response = await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: `puppet-permission-${randomUUID()}`, title },
        options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      });
      const outcome = response.outcome;
      if (outcome.outcome === 'selected') {
        return { outcome: 'selected', optionId: outcome.optionId };
      }
      return { outcome: 'cancelled' };
    } catch {
      return { outcome: 'cancelled' };
    }
  }

  /** Call an MCP tool over the session's first connection; never throws. */
  private async callTool(session: PuppetSession, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const conns = await session.mcp;
    const conn = conns[0];
    if (!conn) {
      return { isError: true, text: `No MCP connection available to call "${name}"` };
    }
    try {
      return await conn.callTool(name, args);
    } catch (err: unknown) {
      return { isError: true, text: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Begin connecting the provided MCP servers (non-blocking); failures are dropped. */
  private connectMcp(servers: readonly acp.McpServer[] | undefined): Promise<McpConnection[]> {
    if (!servers || servers.length === 0) {
      return Promise.resolve([]);
    }
    return Promise.all(
      servers.map((server) =>
        this.mcpConnector.connect(server).catch((err: unknown) => {
          process.stderr.write(`[puppet] MCP connect failed for ${server.name}: ${String(err)}\n`);
          return undefined;
        }),
      ),
    ).then((conns) => conns.filter((c): c is McpConnection => c !== undefined));
  }

  private async closeSessionMcp(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const conns = await session.mcp.catch(() => [] as McpConnection[]);
    await Promise.all(conns.map((c) => c.close().catch(() => {})));
  }
}
