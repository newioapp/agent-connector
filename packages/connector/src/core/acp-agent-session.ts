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
import type { PermissionHandler, SessionStatusListener, SessionStreamSegment, SessionType } from './types';
import { AcpSessionConfigHandler } from './acp-session-config-handler';
import { AcpSessionContextWindowHandler } from './acp-session-context-window-handler';
import { AcpSlashCommandHandler } from './acp-slash-command-handler';
import { Logger } from './logger';
import type {
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  ModelOption,
  ModeOption,
  NewioClient,
  SessionConfigUpdate,
} from '@newio/agent-sdk';
import { extractErrorMessage } from './types';

const log = new Logger('acp-agent-session');

export interface AcpAgentSessionInit {
  readonly type: SessionType;
  /** ConversationId, __contact__, cron id job */
  readonly externalReferenceId: string;
  readonly promptFormatterVersion: string;
  readonly correlationId: string;
  readonly connection: ClientSideConnection;
  readonly client: NewioClient;
  readonly ownerId: string;
  readonly sessionResponse: NewSessionResponse | LoadSessionResponse;
  readonly disposable: boolean;
  readonly username?: string;
  /** Check whether text could still become the skip token. */
  readonly isSkipPrefix: (text: string) => boolean;
}

export interface AcpAgentSessionInterface extends AgentSession {}

export class AcpAgentSession implements AcpAgentSessionInterface {
  readonly type: SessionType;

  readonly externalReferenceId: string;

  readonly promptFormatterVersion: string;

  readonly correlationId: string;

  readonly disposable: boolean;

  private readonly connection: ClientSideConnection;
  private readonly configHandler: AcpSessionConfigHandler;
  private readonly contextWindowHandler: AcpSessionContextWindowHandler;
  private readonly slashCommandHandler: AcpSlashCommandHandler;
  private readonly logTag: string;
  private readonly _isSkipPrefix: (text: string) => boolean;
  private stream?: AcpSessionStream;
  private statusListener: SessionStatusListener = () => {};
  private permissionHandler: PermissionHandler = () => Promise.reject(new Error('Permission request is unsupported'));
  private _currentConversationId: string | undefined = undefined;

  constructor(init: AcpAgentSessionInit) {
    this.type = init.type;
    this.externalReferenceId = init.externalReferenceId;
    this.promptFormatterVersion = init.promptFormatterVersion;
    this.correlationId = init.correlationId;
    this.disposable = init.disposable;
    this.connection = init.connection;
    this.logTag = init.username ? `[${init.username}]` : '';
    this._isSkipPrefix = init.isSkipPrefix;
    this.configHandler = new AcpSessionConfigHandler(
      init.type,
      init.externalReferenceId,
      init.correlationId,
      init.connection,
      init.client,
      init.sessionResponse,
    );
    this.contextWindowHandler = new AcpSessionContextWindowHandler(
      init.type,
      init.externalReferenceId,
      init.ownerId,
      init.client,
    );
    this.slashCommandHandler = new AcpSlashCommandHandler(
      init.type,
      init.externalReferenceId,
      init.correlationId,
      init.connection,
    );
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

  onContextPressure(cb: () => void): void {
    this.contextWindowHandler.onContextPressure(cb);
  }

  async *prompt(text: string, conversationId?: string): AsyncGenerator<SessionStreamSegment> {
    this._currentConversationId = conversationId;
    const stream = new AcpSessionStream(this.statusListener, this._isSkipPrefix, conversationId);
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

  /** Cancel the current prompt turn for this session. */
  async cancel(): Promise<void> {
    log.info(`${this.logTag} [${this.correlationId}] Cancelling session`);
    await this.connection.cancel({ sessionId: this.correlationId });
  }

  getLiveSessionInfo(_request: LiveSessionInfoRequest): LiveSessionInfoResponse {
    const availableModels: ModelOption[] = [];
    const availableModes: ModeOption[] = [];
    let currentModel: string | undefined;
    let currentMode: string | undefined;

    const models = this.configHandler.listModels();
    if (models) {
      for (const o of models.options) {
        availableModels.push({ value: o.id, label: o.name });
      }
      currentModel = models.selectedId;
    }

    const modes = this.configHandler.listModes();
    if (modes) {
      for (const o of modes.options) {
        availableModes.push({ value: o.id, label: o.name });
      }
      currentMode = modes.selectedId;
    }

    return {
      sessionType: this.type,
      externalReferenceId: this.externalReferenceId,
      isLive: true,
      availableModels,
      currentModel,
      availableModes,
      currentMode,
      canCancel: true,
      canCompact: this.slashCommandHandler.isCompactSupported(),
      contextWindowSize: this.contextWindowHandler.getContextWindow()?.size,
      contextWindowUsed: this.contextWindowHandler.getContextWindow()?.used,
    };
  }

  async handleCancelSession(_request: CancelSessionRequest): Promise<CancelSessionResponse> {
    try {
      await this.cancel();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: extractErrorMessage(err) };
    }
  }

  async handleCompactSession(_request: CompactSessionRequest): Promise<CompactSessionResponse> {
    return this.slashCommandHandler.compact();
  }

  async applySessionConfig(config: SessionConfigUpdate): Promise<void> {
    await this.configHandler.applySessionConfig(config);
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
    this.contextWindowHandler.handleSessionUpdate(params.update);
    this.slashCommandHandler.handleSessionUpdate(params.update);
    this.stream?.handleSessionUpdate(params.update);
  }

  /** Handle a vendor-specific ext notification routed by method + sessionId. */
  handleExtNotification(method: string, params: Record<string, unknown>): void {
    this.contextWindowHandler.handleExtNotification(method, params);
    this.slashCommandHandler.handleExtNotification(method, params);
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
