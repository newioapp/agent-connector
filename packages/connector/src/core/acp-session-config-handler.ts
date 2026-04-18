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
import { Logger } from './logger';

const log = new Logger('acp-session-config-handler');

export class AcpSessionConfigHandler {
  private modelConfig: AgentSessionConfig | undefined;
  private modeConfig: AgentSessionConfig | undefined;

  /** Called when model or mode config changes (user action or agent-initiated). */
  onConfigChanged?: () => void;

  constructor(
    private readonly sessionId: string,
    private readonly connection: ClientSideConnection,
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

  async setModel(modelId: string): Promise<void> {
    await this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
    if (this.modelConfig) {
      this.modelConfig = { ...this.modelConfig, selectedId: modelId };
    }
    log.info(`[${this.sessionId}] Model set to: ${modelId}`);
    this.onConfigChanged?.();
  }

  async setMode(modeId: string): Promise<void> {
    await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
    if (this.modeConfig) {
      this.modeConfig = { ...this.modeConfig, selectedId: modeId };
    }
    log.info(`[${this.sessionId}] Mode set to: ${modeId}`);
    this.onConfigChanged?.();
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
          log.info(`[${this.sessionId}] Mode updated to: ${update.currentModeId}`);
          this.onConfigChanged?.();
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
            log.info(`[${this.sessionId}] Model config updated via config_option_update`);
          } else if (opt.category === 'mode') {
            this.modeConfig = {
              options: flattenSelectOptions(opt.options),
              selectedId: opt.currentValue,
            };
            log.info(`[${this.sessionId}] Mode config updated via config_option_update`);
          }
        }
        this.onConfigChanged?.();
        return true;
      }
      default:
        return false;
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
