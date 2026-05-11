/**
 * AcpSessionConfigHandler — manages model/mode config for an ACP session.
 *
 * Extracts config from the session response (preferring configOptions over legacy
 * models/modes), handles set/list operations, and processes config-related session
 * updates (current_mode_update, config_option_update).
 */
import type { ClientSideConnection, NewSessionResponse, LoadSessionResponse } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSessionConfig } from './agent-instance';
import type { NewioClient, SessionConfigUpdate } from '@newio/agent-sdk';
import { getLogger } from '@newio/agent-sdk';
import { SessionType } from './types';

const log = getLogger('acp-session-config-handler');

export class AcpSessionConfigHandler {
  private modelConfig: AgentSessionConfig | undefined;
  private modeConfig: AgentSessionConfig | undefined;

  constructor(
    private readonly sessionType: SessionType,
    private readonly externalReferenceId: string,
    private readonly correlationId: string,
    private readonly connection: ClientSideConnection,
    private readonly client: NewioClient,
    private readonly agentUserId: string,
    sessionResponse: NewSessionResponse | LoadSessionResponse,
  ) {
    const { configOptions, models, modes } = sessionResponse;

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

  private async setModel(modelId: string): Promise<void> {
    try {
      await this.connection.unstable_setSessionModel({ sessionId: this.correlationId, modelId });
    } catch (err: unknown) {
      throw new Error(extractAcpErrorMessage(err, `Failed to set model to "${modelId}"`));
    }
    if (this.modelConfig) {
      this.modelConfig = { ...this.modelConfig, selectedId: modelId };
    }
    log.info(`[${this.sessionType}/${this.externalReferenceId}] Model set to: ${modelId}`);
  }

  private async setMode(modeId: string): Promise<void> {
    try {
      await this.connection.setSessionMode({ sessionId: this.correlationId, modeId });
    } catch (err: unknown) {
      throw new Error(extractAcpErrorMessage(err, `Failed to set mode to "${modeId}"`));
    }
    if (this.modeConfig) {
      this.modeConfig = { ...this.modeConfig, selectedId: modeId };
    }
    log.info(`[${this.sessionType}/${this.externalReferenceId}] Mode set to: ${modeId}`);
  }

  listModels(): AgentSessionConfig | undefined {
    return this.modelConfig;
  }

  listModes(): AgentSessionConfig | undefined {
    return this.modeConfig;
  }

  /** Handle config-related session updates. Returns true if the update was handled. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case 'current_mode_update': {
        if (this.modeConfig) {
          this.modeConfig = { ...this.modeConfig, selectedId: update.currentModeId };
          log.info(`[${this.sessionType}/${this.externalReferenceId}] Mode updated to: ${update.currentModeId}`);
        }
        return true;
      }
      case 'config_option_update': {
        for (const opt of update.configOptions) {
          if (opt.type !== 'select') {
            continue;
          }
          if (opt.category === 'model') {
            this.modelConfig = {
              options: flattenSelectOptions(opt.options),
              selectedId: opt.currentValue,
            };
            log.info(`[${this.sessionType}/${this.externalReferenceId}] Model config updated via config_option_update`);
          } else if (opt.category === 'mode') {
            this.modeConfig = {
              options: flattenSelectOptions(opt.options),
              selectedId: opt.currentValue,
            };
            log.info(`[${this.sessionType}/${this.externalReferenceId}] Mode config updated via config_option_update`);
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Apply acpModel/acpMode config. Reports corrected values back if unavailable.
   */
  async applySessionConfig(config: SessionConfigUpdate): Promise<void> {
    let needsReport = false;

    if (config.acpModel) {
      try {
        await this.setModel(config.acpModel);
      } catch {
        log.warn(`[${this.sessionType}/${this.externalReferenceId}] Model ${config.acpModel} not available`);
        needsReport = true;
      }
    }

    if (config.acpMode) {
      try {
        await this.setMode(config.acpMode);
      } catch {
        log.warn(`[${this.sessionType}/${this.externalReferenceId}] Mode ${config.acpMode} not available`);
        needsReport = true;
      }
    }

    if (needsReport) {
      await this.reportCurrentConfig();
    }
  }

  /** Report the current model/mode back to the backend (corrects stale persisted values). */
  async reportCurrentConfig(): Promise<void> {
    if (this.sessionType !== 'conversation') {
      return;
    }
    try {
      await this.client.updateAgentMember({
        conversationId: this.externalReferenceId,
        targetUserId: this.agentUserId,
        acpModel: this.modelConfig?.selectedId ?? null,
        acpMode: this.modeConfig?.selectedId ?? null,
      });
      log.info(
        `[${this.sessionType}/${this.externalReferenceId}] Reported corrected config for session ${this.correlationId}`,
      );
    } catch (err: unknown) {
      log.warn(`[${this.sessionType}/${this.externalReferenceId}] Failed to report corrected session config`, err);
    }
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

/** Extract a human-readable message from an ACP JSON-RPC error. */
function extractAcpErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.data === 'object' && obj.data !== null) {
      const details = (obj.data as Record<string, unknown>).details;
      if (typeof details === 'string') {
        return details;
      }
    }
    if (typeof obj.message === 'string') {
      return obj.message;
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return fallback;
}
