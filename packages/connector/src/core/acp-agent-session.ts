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
import type { AgentSession } from './agent-session';
import { AcpSessionStream } from './acp-session-stream';
import type { PermissionHandler, SessionStatusListener, SessionStreamSegment } from './types';
import { AcpSessionConfigHandler } from './acp-session-config-handler';
import { Logger } from './logger';
import type { AgentSessionConfig } from './agent-instance';

const log = new Logger('acp-agent-session');

export interface AcpAgentSessionInit {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly connection: ClientSideConnection;
  readonly sessionResponse: NewSessionResponse | LoadSessionResponse;
  readonly disposable: boolean;
  readonly username?: string;
}

export class AcpAgentSession implements AgentSession {
  readonly sessionId: string;
  readonly correlationId: string;

  readonly disposable: boolean;

  private readonly connection: ClientSideConnection;
  private readonly configHandler: AcpSessionConfigHandler;
  private readonly logTag: string;
  private stream?: AcpSessionStream;
  private statusListener: SessionStatusListener = () => {};
  private permissionHandler: PermissionHandler = () => Promise.reject(new Error('Permission request is unsupported'));
  private _currentConversationId: string | undefined = undefined;

  constructor(init: AcpAgentSessionInit) {
    this.sessionId = init.sessionId;
    this.correlationId = init.correlationId;
    this.disposable = init.disposable;
    this.connection = init.connection;
    this.logTag = init.username ? `[${init.username}]` : '';
    this.configHandler = new AcpSessionConfigHandler(init.correlationId, init.connection, init.sessionResponse);
  }

  // ---------------------------------------------------------------------------
  // AgentSession
  // ---------------------------------------------------------------------------
  get currentConversationId(): string | undefined {
    return this._currentConversationId;
  }

  onStatus(listener: SessionStatusListener): void {
    this.statusListener = listener;
  }

  onPermissionRequest(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  /** Set a callback for when model/mode config changes. */
  onConfigChanged(listener: () => void): void {
    this.configHandler.setOnConfigChanged(listener);
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

  async *prompt(text: string, conversationId?: string): AsyncGenerator<SessionStreamSegment> {
    this._currentConversationId = conversationId;
    const stream = new AcpSessionStream(this.statusListener, conversationId);
    this.stream = stream;

    const promptDone = this.connection
      .prompt({
        sessionId: this.correlationId,
        prompt: [{ type: 'text', text }],
      })
      .then((result) => {
        stream.finish();
        if (result.stopReason !== 'end_turn') {
          log.warn(`${this.logTag} [${this.correlationId}] Prompt ended with stop reason: ${result.stopReason}`);
        }
      })
      .catch((err: unknown) => {
        log.error(`${this.logTag} [${this.correlationId}] Prompt failed`, err);
        stream.finish();
        throw err;
      });

    try {
      yield* stream.segments();
      await promptDone;
    } finally {
      this.stream = undefined;
      const convId = this._currentConversationId;
      this._currentConversationId = undefined;
      this.statusListener('idle', convId);
    }
  }

  async dispose(): Promise<void> {
    if (!this.disposable) {
      log.info(`${this.logTag} [${this.correlationId}] Session is not disposable, skipping dispose`);
      return;
    }
    this.stream?.finish();
    try {
      await this.connection.unstable_closeSession({ sessionId: this.correlationId });
    } catch (err: unknown) {
      log.debug(`${this.logTag} [${this.correlationId}] closeSession failed (best-effort)`, err);
    }
    log.info(`${this.logTag} [${this.correlationId}] Session disposed`);
  }

  // ---------------------------------------------------------------------------
  // Routed from AcpAgentInstance (acp.Client dispatch)
  // ---------------------------------------------------------------------------

  handleSessionUpdate(params: acp.SessionNotification): void {
    this.configHandler.handleSessionUpdate(params.update);
    this.stream?.handleSessionUpdate(params.update);
  }

  async handleRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const title = params.toolCall.title ?? 'Permission request';
    if (params.toolCall.content) {
      log.debug(
        `[${this.correlationId}] Permission request toolCall content: ${JSON.stringify(params.toolCall.content)}`,
      );
    }

    try {
      const selectedOptionId = await this.permissionHandler(title, params.options, this._currentConversationId);
      return { outcome: { outcome: 'selected' as const, optionId: selectedOptionId } };
    } catch (err: unknown) {
      log.warn(`${this.logTag} Permission request failed`, err);
      return { outcome: { outcome: 'cancelled' as const } };
    }
  }
}
