/**
 * AcpAgentSession — one ACP session (one context window) on a shared connection.
 *
 * Lightweight: does not own a process or connection. Uses the shared
 * ClientSideConnection from AcpAgentInstance to send prompts and cancel.
 * Receives routed sessionUpdate/requestPermission calls from the instance.
 * Stores available models/modes discovered from the session response.
 */
import type { ClientSideConnection, NewSessionResponse, LoadSessionResponse } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSession, SessionStatusListener } from './agent-session';
import { SessionStream } from './session-stream';
import type { SessionStreamSegment } from './session-stream';
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
}

export class AcpAgentSession implements AgentSession {
  readonly correlationId: string;
  private readonly modelConfig: AgentSessionConfig | undefined;
  private readonly modeConfig: AgentSessionConfig | undefined;

  private readonly connection: ClientSideConnection;
  private stream?: SessionStream;
  private statusListener: SessionStatusListener = () => {};
  private readonly permissionHandler: PermissionHandler;
  private prompting = false;

  constructor(init: AcpAgentSessionInit) {
    this.correlationId = init.correlationId;
    this.connection = init.connection;
    this.permissionHandler = init.permissionHandler;

    const { configOptions, models, modes } = init.sessionResponse;

    // Prefer configOptions (newer API), fallback to legacy models/modes
    this.modelConfig =
      extractConfigByCategory(configOptions, 'model') ??
      (models
        ? {
            options: models.availableModels.map((m) => ({
              id: m.modelId,
              name: m.name,
              description: m.description ?? undefined,
            })),
            selectedId: models.currentModelId,
          }
        : undefined);

    this.modeConfig =
      extractConfigByCategory(configOptions, 'mode') ??
      (modes
        ? {
            options: modes.availableModes.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description ?? undefined,
            })),
            selectedId: modes.currentModeId,
          }
        : undefined);
  }

  // ---------------------------------------------------------------------------
  // AgentSession
  // ---------------------------------------------------------------------------

  onStatus(listener: SessionStatusListener): void {
    this.statusListener = listener;
  }

  async setModel(modelId: string): Promise<void> {
    await this.connection.unstable_setSessionModel({ sessionId: this.correlationId, modelId });
    log.info(`[${this.correlationId}] Model set to: ${modelId}`);
  }

  async setMode(modeId: string): Promise<void> {
    await this.connection.setSessionMode({ sessionId: this.correlationId, modeId });
    log.info(`[${this.correlationId}] Mode set to: ${modeId}`);
  }

  listModels(): AgentSessionConfig | undefined {
    return this.modelConfig;
  }

  listModes(): AgentSessionConfig | undefined {
    return this.modeConfig;
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

  dispose(): void {
    if (this.prompting) {
      log.info(`[${this.correlationId}] Cancelling in-flight prompt...`);
      this.connection.cancel({ sessionId: this.correlationId }).catch((err: unknown) => {
        log.debug(`[${this.correlationId}] Cancel failed (expected if already done)`, err);
      });
    }
    this.stream?.finish();
    log.info(`[${this.correlationId}] Session disposed`);
  }

  // ---------------------------------------------------------------------------
  // Routed from AcpAgentInstance (acp.Client dispatch)
  // ---------------------------------------------------------------------------

  handleSessionUpdate(params: acp.SessionNotification): void {
    this.stream?.handleSessionUpdate(params);
  }

  handleRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.permissionHandler(this.correlationId, params);
  }
}

/** Extract an AgentSessionConfig from configOptions by category, flattening grouped options. */
function extractConfigByCategory(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | null | undefined,
  category: string,
): AgentSessionConfig | undefined {
  if (!configOptions) {
    return undefined;
  }
  for (const opt of configOptions) {
    if (opt.type === 'select' && opt.category === category) {
      return {
        options: flattenSelectOptions(opt.options),
        selectedId: opt.currentValue,
      };
    }
  }
  return undefined;
}

/** Flatten SessionConfigSelectOptions (may be flat options or grouped) into AgentSessionConfigOption[]. */
function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions,
): { readonly id: string; readonly name: string; readonly description?: string }[] {
  const result: { readonly id: string; readonly name: string; readonly description?: string }[] = [];
  for (const item of options) {
    if ('value' in item) {
      result.push({ id: item.value, name: item.name, description: item.description ?? undefined });
    } else if ('options' in item) {
      result.push(...flattenSelectOptions(item.options));
    }
  }
  return result;
}
