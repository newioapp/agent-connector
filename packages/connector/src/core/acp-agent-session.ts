/**
 * AcpAgentSession — one ACP session (one context window) on a shared connection.
 *
 * Lightweight: does not own a process or connection. Uses the shared
 * ClientSideConnection from AcpAgentInstance to send prompts and cancel.
 * Receives routed sessionUpdate/requestPermission calls from the instance.
 * Delegates model/mode config to AcpSessionConfigHandler.
 */
import type { ClientSideConnection, NewSessionResponse, LoadSessionResponse } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSession, SessionStatusListener } from './agent-session';
import { SessionStream } from './acp-session-stream';
import type { SessionStreamSegment } from './acp-session-stream';
import { AcpSessionConfigHandler } from './acp-session-config-handler';
import { Logger } from './logger';
import type { AgentSessionConfig } from './agent-instance';

const log = new Logger('acp-agent-session');

/** Callback for routing permission requests to the owner via Newio. */
export type PermissionHandler = (
  correlationId: string,
  params: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

export interface AcpAgentSessionInit {
  readonly correlationId: string;
  readonly connection: ClientSideConnection;
  readonly permissionHandler: PermissionHandler;
  readonly sessionResponse: NewSessionResponse | LoadSessionResponse;
  readonly disposable: boolean;
}

export class AcpAgentSession implements AgentSession {
  readonly correlationId: string;
  disposable: boolean;

  private readonly connection: ClientSideConnection;
  private readonly configHandler: AcpSessionConfigHandler;
  private stream?: SessionStream;
  private statusListener: SessionStatusListener = () => {};
  private readonly permissionHandler: PermissionHandler;
  private prompting = false;

  constructor(init: AcpAgentSessionInit) {
    this.correlationId = init.correlationId;
    this.disposable = init.disposable;
    this.connection = init.connection;
    this.permissionHandler = init.permissionHandler;
    this.configHandler = new AcpSessionConfigHandler(init.correlationId, init.connection, init.sessionResponse);
  }

  // ---------------------------------------------------------------------------
  // AgentSession
  // ---------------------------------------------------------------------------

  onStatus(listener: SessionStatusListener): void {
    this.statusListener = listener;
  }

  async setModel(modelId: string): Promise<void> {
    await this.configHandler.setModel(modelId);
  }

  async setMode(modeId: string): Promise<void> {
    await this.configHandler.setMode(modeId);
  }

  listModels(): AgentSessionConfig | undefined {
    return this.configHandler.listModels();
  }

  listModes(): AgentSessionConfig | undefined {
    return this.configHandler.listModes();
  }

  async *prompt(text: string): AsyncGenerator<SessionStreamSegment> {
    this.prompting = true;
    this.statusListener('thinking');
    const stream = new SessionStream(this.statusListener);
    this.stream = stream;

    const promptDone = this.connection
      .prompt({
        sessionId: this.correlationId,
        prompt: [{ type: 'text', text }],
      })
      .then((result) => {
        stream.finish();
        if (result.stopReason !== 'end_turn') {
          log.warn(`[${this.correlationId}] Prompt ended with stop reason: ${result.stopReason}`);
        }
      })
      .catch((err: unknown) => {
        log.error(`[${this.correlationId}] Prompt failed`, err);
        stream.finish();
        throw err;
      });

    try {
      yield* stream.segments();
      await promptDone;
    } finally {
      this.stream = undefined;
      this.prompting = false;
      this.statusListener('idle');
    }
  }

  async dispose(): Promise<void> {
    if (!this.disposable) {
      log.info(`[${this.correlationId}] Session is not disposable, skipping dispose`);
      return;
    }
    if (this.prompting) {
      log.info(`[${this.correlationId}] Cancelling in-flight prompt...`);
      try {
        await this.connection.cancel({ sessionId: this.correlationId });
      } catch (err: unknown) {
        log.debug(`[${this.correlationId}] Cancel failed (expected if already done)`, err);
      }
    }
    this.stream?.finish();
    try {
      await this.connection.unstable_closeSession({ sessionId: this.correlationId });
    } catch (err: unknown) {
      log.debug(`[${this.correlationId}] closeSession failed (best-effort)`, err);
    }
    log.info(`[${this.correlationId}] Session disposed`);
  }

  // ---------------------------------------------------------------------------
  // Routed from AcpAgentInstance (acp.Client dispatch)
  // ---------------------------------------------------------------------------

  handleSessionUpdate(params: acp.SessionNotification): void {
    this.configHandler.handleSessionUpdate(params.update);
    this.stream?.handleSessionUpdate(params.update);
  }

  handleRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.permissionHandler(this.correlationId, params);
  }
}
