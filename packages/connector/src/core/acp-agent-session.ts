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
import { AcpSlashCommandHandler } from './acp-slash-command-handler';
import { Logger } from './logger';
import type { AgentSessionConfig } from './agent-instance';
import type {
  AgentCapability,
  CapabilityOption,
  InvokeCapabilityPayload,
  InvokeCapabilityResponsePayload,
  NewioClient,
  SessionConfigUpdate,
} from '@newio/agent-sdk';
import { extractErrorMessage } from './types';

const log = new Logger('acp-agent-session');

export interface AcpAgentSessionInit {
  readonly sessionId: string;
  readonly promptFormatterVersion: string;
  readonly correlationId: string;
  readonly connection: ClientSideConnection;
  readonly client: NewioClient;
  readonly sessionResponse: NewSessionResponse | LoadSessionResponse;
  readonly disposable: boolean;
  readonly username?: string;
  /** Check whether text could still become the skip token. */
  readonly isSkipPrefix: (text: string) => boolean;
}

export interface AcpAgentSessionInterface extends AgentSession {
  /** Set the model for this session. */
  setModel(modelId: string): Promise<void>;

  /** Set the operational mode for this session. */
  setMode(modeId: string): Promise<void>;

  /** List available models for this session. */
  listModels(): AgentSessionConfig | undefined;

  /** List available modes for this session. */
  listModes(): AgentSessionConfig | undefined;

  /** Register a listener for model/mode config changes. */
  onConfigChanged(listener: () => void): void;
}

export class AcpAgentSession implements AcpAgentSessionInterface {
  readonly sessionId: string;
  readonly promptFormatterVersion: string;

  readonly correlationId: string;

  readonly disposable: boolean;

  private readonly connection: ClientSideConnection;
  private readonly configHandler: AcpSessionConfigHandler;
  private readonly slashCommandHandler: AcpSlashCommandHandler;
  private readonly logTag: string;
  private readonly _isSkipPrefix: (text: string) => boolean;
  private stream?: AcpSessionStream;
  private statusListener: SessionStatusListener = () => {};
  private permissionHandler: PermissionHandler = () => Promise.reject(new Error('Permission request is unsupported'));
  private _currentConversationId: string | undefined = undefined;

  constructor(init: AcpAgentSessionInit) {
    this.sessionId = init.sessionId;
    this.promptFormatterVersion = init.promptFormatterVersion;
    this.correlationId = init.correlationId;
    this.disposable = init.disposable;
    this.connection = init.connection;
    this.logTag = init.username ? `[${init.username}]` : '';
    this._isSkipPrefix = init.isSkipPrefix;
    this.configHandler = new AcpSessionConfigHandler(
      init.correlationId,
      init.sessionId,
      init.connection,
      init.client,
      init.sessionResponse,
    );
    this.slashCommandHandler = new AcpSlashCommandHandler(init.correlationId);
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

  getCapabilities(): readonly AgentCapability[] {
    const capabilities: AgentCapability[] = [];
    const models = this.listModels();
    if (models) {
      const options: CapabilityOption[] = models.options.map((o) => ({
        value: o.id,
        label: o.name,
        description: o.description,
      }));
      capabilities.push({
        id: 'set_model',
        name: 'Change Model',
        scope: 'session',
        options,
        currentValue: models.selectedId,
      });
    }
    const modes = this.listModes();
    if (modes) {
      const options: CapabilityOption[] = modes.options.map((o) => ({
        value: o.id,
        label: o.name,
        description: o.description,
      }));
      capabilities.push({
        id: 'set_mode',
        name: 'Set Mode',
        scope: 'session',
        options,
        currentValue: modes.selectedId,
      });
    }
    capabilities.push({ id: 'cancel', name: 'Cancel', scope: 'session' });
    if (this.slashCommandHandler.isCompactSupported()) {
      capabilities.push({ id: 'compact', name: 'Compact Context', scope: 'session' });
    }
    return capabilities;
  }

  async handleCapabilityInvocation(invocation: InvokeCapabilityPayload): Promise<InvokeCapabilityResponsePayload> {
    const { capabilityId, params } = invocation;
    if (capabilityId === 'set_model') {
      const value = params?.['value'];
      if (typeof value !== 'string') {
        return { capabilityId, success: false, error: 'Missing value' };
      }
      try {
        await this.setModel(value);
        return { capabilityId, success: true, result: { model: value } };
      } catch (err: unknown) {
        return { capabilityId, success: false, error: extractErrorMessage(err) };
      }
    }
    if (capabilityId === 'set_mode') {
      const value = params?.['value'];
      if (typeof value !== 'string') {
        return { capabilityId, success: false, error: 'Missing value' };
      }
      try {
        await this.setMode(value);
        return { capabilityId, success: true, result: { mode: value } };
      } catch (err: unknown) {
        return { capabilityId, success: false, error: extractErrorMessage(err) };
      }
    }
    if (capabilityId === 'cancel') {
      try {
        await this.cancel();
        return { capabilityId, success: true };
      } catch (err: unknown) {
        return { capabilityId, success: false, error: extractErrorMessage(err) };
      }
    }
    if (capabilityId === 'compact') {
      const commandName = this.slashCommandHandler.getCompactCommandName();
      if (!commandName) {
        return { capabilityId, success: false, error: 'Compact not supported by this agent' };
      }
      try {
        const result = await this.connection.prompt({
          sessionId: this.correlationId,
          prompt: [{ type: 'text', text: `/${commandName}` }],
        });
        log.info(`${this.logTag} [${this.correlationId}] Compact completed: stopReason=${result.stopReason}`);
        return { capabilityId, success: true };
      } catch (err: unknown) {
        return { capabilityId, success: false, error: extractErrorMessage(err) };
      }
    }
    return { capabilityId, success: false, error: 'unknown_capability' };
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
    this.slashCommandHandler.handleSessionUpdate(params.update);
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
