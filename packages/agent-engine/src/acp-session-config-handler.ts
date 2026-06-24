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
import type { SessionConfigUpdate } from '@newio/agent-sdk';
import { getLogger } from '@newio/agent-sdk';
import type { SessionConfig, SessionType } from './types';

const log = getLogger('acp-session-config-handler');

export class AcpSessionConfigHandler {
  private modelConfig: AgentSessionConfig | undefined;
  private modeConfig: AgentSessionConfig | undefined;

  constructor(
    private readonly sessionType: SessionType,
    private readonly externalReferenceId: string,
    private readonly correlationId: string,
    private readonly connection: ClientSideConnection,
    private readonly updateConfig: (config: SessionConfig) => Promise<void>,
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
    log.info(`[${this.sessionType}/${this.externalReferenceId}] Setting model to: ${modelId}`);
    try {
      await this.connection.unstable_setSessionModel({ sessionId: this.correlationId, modelId });
    } catch (err: unknown) {
      // `unstable_setSessionModel` is the experimental model API: older agents
      // implement it, newer agents drop it in favour of the stable
      // `setSessionConfigOption` and reply "method not found" (-32601). Only
      // fall back in that case — a genuine failure (e.g. an invalid model)
      // should surface its own error rather than be masked by a second attempt.
      if (!isMethodNotFound(err)) {
        throw new Error(extractAcpErrorMessage(err, `Failed to set model to "${modelId}"`));
      }
      log.info(
        `[${this.sessionType}/${this.externalReferenceId}] unstable_setSessionModel unavailable, falling back to setSessionConfigOption`,
      );
      try {
        await this.connection.setSessionConfigOption({
          sessionId: this.correlationId,
          configId: 'model',
          value: modelId,
        });
      } catch (fallbackErr: unknown) {
        throw new Error(extractAcpErrorMessage(fallbackErr, `Failed to set model to "${modelId}"`));
      }
    }
    if (this.modelConfig) {
      this.modelConfig = { ...this.modelConfig, selectedId: modelId };
    }
  }

  private async setMode(modeId: string): Promise<void> {
    log.info(`[${this.sessionType}/${this.externalReferenceId}] Setting mode to: ${modeId}`);
    try {
      await this.connection.setSessionMode({ sessionId: this.correlationId, modeId });
    } catch (err: unknown) {
      throw new Error(extractAcpErrorMessage(err, `Failed to set mode to "${modeId}"`));
    }
    if (this.modeConfig) {
      this.modeConfig = { ...this.modeConfig, selectedId: modeId };
    }
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
          log.info(
            `[${this.sessionType}/${this.externalReferenceId}] Received acpMode updated to: ${update.currentModeId}`,
          );
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
            log.info(
              `[${this.sessionType}/${this.externalReferenceId}] Received acpModel config updated via config_option_update to: ${opt.currentValue}`,
            );
          } else if (opt.category === 'mode') {
            this.modeConfig = {
              options: flattenSelectOptions(opt.options),
              selectedId: opt.currentValue,
            };
            log.info(
              `[${this.sessionType}/${this.externalReferenceId}] Received acpMode config updated via config_option_update to: ${opt.currentValue}`,
            );
          }
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Apply acpModel/acpMode config. Only applies a value the agent actually
   * advertises (from the session response or a later config_option_update);
   * otherwise the persisted value is left unapplied and the session's current
   * (valid) selection is reported back to correct the stale backend value.
   *
   * Why the validity gate rather than a try/catch: `setSessionModel` /
   * `setSessionConfigOption` accept an unknown id silently and only surface the
   * problem much later, at prompt time (e.g. a Codex runner that inherited a
   * Claude "opus" model ends up on a model the ChatGPT account rejects when the
   * first prompt runs). Setting never throws, so a try/catch fallback never
   * fires — we must validate up front and simply not apply an unsupported value.
   */
  async applySessionConfig(config: SessionConfigUpdate): Promise<void> {
    log.info(
      `[${this.sessionType}/${this.externalReferenceId}] Applying session config: acpMode=${config.acpMode}, acpModel=${config.acpModel}`,
    );
    let needsReport = false;

    if (config.acpModel) {
      if (this.isAdvertisedModel(config.acpModel)) {
        await this.setModel(config.acpModel);
      } else {
        log.warn(
          `[${this.sessionType}/${this.externalReferenceId}] Persisted model "${config.acpModel}" is not advertised by this agent; keeping current model "${this.modelConfig?.selectedId ?? 'unknown'}"`,
        );
        needsReport = true;
      }
    }

    if (config.acpMode) {
      if (this.isAdvertisedMode(config.acpMode)) {
        await this.setMode(config.acpMode);
      } else {
        log.warn(
          `[${this.sessionType}/${this.externalReferenceId}] Persisted mode "${config.acpMode}" is not advertised by this agent; keeping current mode "${this.modeConfig?.selectedId ?? 'unknown'}"`,
        );
        needsReport = true;
      }
    }

    if (needsReport) {
      await this.reportCurrentConfig();
    }
  }

  /** Whether the agent advertises a model with this id (from session response or config_option_update). */
  private isAdvertisedModel(modelId: string): boolean {
    return this.modelConfig?.options.some((o) => o.id === modelId) ?? false;
  }

  /** Whether the agent advertises a mode with this id. */
  private isAdvertisedMode(modeId: string): boolean {
    return this.modeConfig?.options.some((o) => o.id === modeId) ?? false;
  }

  /** Report the current model/mode back to the backend (corrects stale persisted values). */
  async reportCurrentConfig(): Promise<void> {
    if (this.sessionType !== 'conversation') {
      return;
    }
    try {
      await this.updateConfig({
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

/** JSON-RPC "method not found" — the agent does not implement the requested method. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** True when an ACP rejection indicates the method isn't implemented by the agent. */
function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const obj = err as Record<string, unknown>;
  return obj.code === JSON_RPC_METHOD_NOT_FOUND;
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
