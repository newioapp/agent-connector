/**
 * AcpSessionConfigHandler — manages a session's config dimensions (model, mode, …).
 *
 * Extracts each dimension from the session response (preferring configOptions over
 * the legacy models/modes fields), applies persisted values, processes config-related
 * session updates, and keeps the backend member record in sync with the value the
 * agent is actually using.
 *
 * Every dimension is set through one generic ACP call — `setSessionConfigOption` — so
 * supporting a new one (e.g. "effort") is just a CONFIG_FIELD entry plus extraction;
 * no bespoke setter. The per-dimension legacy methods (`unstable_setSessionModel`,
 * `setSessionMode`) survive only as a fallback for agents that predate the generic API.
 */
import type { ClientSideConnection, NewSessionResponse, LoadSessionResponse } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSessionConfig } from './agent-instance';
import type { SessionConfigUpdate } from '@newio/agent-sdk';
import { getLogger } from '@newio/agent-sdk';
import type { SessionConfig, SessionType } from './types';

const log = getLogger('acp-session-config-handler');

/** An ACP config dimension we track and sync with the backend member record. */
type ConfigCategory = 'model' | 'mode';

/** Backend SessionConfig field storing each category's selected value. */
type ConfigField = 'acpModel' | 'acpMode';

/** Maps each config dimension to its backend field. Single extension point for new dimensions. */
const CONFIG_FIELD: Record<ConfigCategory, ConfigField> = {
  model: 'acpModel',
  mode: 'acpMode',
};

const CONFIG_CATEGORIES = Object.keys(CONFIG_FIELD) as ConfigCategory[];

function isConfigCategory(category: string | null | undefined): category is ConfigCategory {
  return category != null && (CONFIG_CATEGORIES as string[]).includes(category);
}

export class AcpSessionConfigHandler {
  /** The value the agent is actually using per dimension — the source of truth. */
  private readonly current: Record<ConfigCategory, AgentSessionConfig | undefined>;

  /**
   * The advertised config-option `id` per category — the `configId` to pass to
   * setSessionConfigOption. Present only when the agent advertises the dimension via
   * configOptions; absent for legacy models/modes agents (we then fall back to the
   * category name as a best-effort configId, which a true legacy agent rejects with
   * -32601 so we drop to its per-dimension setter). Tracked separately because ACP's
   * configId is the option's `id`, which need not equal the (UX-only) `category`.
   */
  private readonly configOptionId: Partial<Record<ConfigCategory, string>> = {};

  /** What we believe the backend member record holds per dimension; reconcile target. */
  private readonly believedBackend: Partial<Record<ConfigCategory, string | null>> = {};

  /** Serializes reconcile writes so a slow earlier write can't complete after a newer one. */
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionType: SessionType,
    private readonly externalReferenceId: string,
    private readonly correlationId: string,
    private readonly connection: ClientSideConnection,
    private readonly updateConfig: (config: SessionConfig) => Promise<void>,
    sessionResponse: NewSessionResponse | LoadSessionResponse,
  ) {
    const { configOptions, models, modes } = sessionResponse;

    const current = {} as Record<ConfigCategory, AgentSessionConfig | undefined>;
    for (const category of CONFIG_CATEGORIES) {
      const option = findSelectOption(configOptions, category);
      if (option) {
        current[category] = { options: flattenSelectOptions(option.options), selectedId: option.currentValue };
        this.configOptionId[category] = option.id;
        continue;
      }
      // Legacy fallback: older agents advertise model/mode via the dedicated fields, not configOptions.
      if (category === 'model' && models) {
        current[category] = {
          options: models.availableModels.map((m) => ({
            id: m.modelId,
            name: m.name,
            description: m.description ?? undefined,
          })),
          selectedId: models.currentModelId,
        };
      } else if (category === 'mode' && modes) {
        current[category] = {
          options: modes.availableModes.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description ?? undefined,
          })),
          selectedId: modes.currentModeId,
        };
      } else {
        current[category] = undefined;
      }
    }
    this.current = current;
  }

  /**
   * Set a dimension's value through the generic ACP config-option API, with the
   * per-dimension legacy method as a fallback.
   *
   * setSessionConfigOption is the stable, generic setter that supersedes the dedicated
   * model/mode methods. We always try it first (using the agent's advertised option id,
   * or the category name as a best-effort id for legacy agents). Only on a "method not
   * found" (-32601) reply — an agent that predates the generic API — do we fall back to
   * the per-dimension legacy setter. Any other error (e.g. an invalid value) is a genuine
   * failure that must surface rather than be masked by a second attempt.
   */
  private async applyCategory(category: ConfigCategory, value: string): Promise<void> {
    log.info(`[${this.tag}] Setting ${category} to: ${value}`);
    const configId = this.configOptionId[category] ?? category;
    const legacy = this.legacySetter(category);
    try {
      await this.connection.setSessionConfigOption({ sessionId: this.correlationId, configId, value });
    } catch (err: unknown) {
      if (!legacy || !isMethodNotFound(err)) {
        throw new Error(extractAcpErrorMessage(err, `Failed to set ${category} to "${value}"`));
      }
      log.info(`[${this.tag}] setSessionConfigOption unavailable for ${category}, falling back to legacy setter`);
      try {
        await legacy(value);
      } catch (fallbackErr: unknown) {
        throw new Error(extractAcpErrorMessage(fallbackErr, `Failed to set ${category} to "${value}"`));
      }
    }
    const cur = this.current[category];
    if (cur) {
      this.current[category] = { ...cur, selectedId: value };
    }
  }

  /** The per-dimension legacy ACP setter for agents that predate setSessionConfigOption, if any. */
  private legacySetter(category: ConfigCategory): ((value: string) => Promise<unknown>) | undefined {
    switch (category) {
      case 'model':
        return (value) => this.connection.unstable_setSessionModel({ sessionId: this.correlationId, modelId: value });
      case 'mode':
        return (value) => this.connection.setSessionMode({ sessionId: this.correlationId, modeId: value });
      default:
        return undefined;
    }
  }

  listModels(): AgentSessionConfig | undefined {
    return this.current.model;
  }

  listModes(): AgentSessionConfig | undefined {
    return this.current.mode;
  }

  /** Handle config-related session updates. Returns true if the update was handled. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case 'current_mode_update': {
        if (this.current.mode) {
          this.current.mode = { ...this.current.mode, selectedId: update.currentModeId };
          log.info(`[${this.tag}] Received acpMode updated to: ${update.currentModeId}`);
          // The runner emits this for every confirmed change — agent-initiated or external — so it's
          // the place that keeps the backend in sync afterward. reportConfig no-ops if already in sync.
          void this.reportConfig();
        }
        return true;
      }
      case 'config_option_update': {
        let changed = false;
        for (const opt of update.configOptions) {
          if (opt.type !== 'select' || !isConfigCategory(opt.category)) {
            continue;
          }
          this.current[opt.category] = {
            options: flattenSelectOptions(opt.options),
            selectedId: opt.currentValue,
          };
          // The agent confirms it speaks the generic config-option API for this dimension; record
          // its id so future sets target it directly rather than guessing from the category name.
          if (opt.id) {
            this.configOptionId[opt.category] = opt.id;
          }
          changed = true;
          log.info(
            `[${this.tag}] Received ${CONFIG_FIELD[opt.category]} updated via config_option_update to: ${opt.currentValue}`,
          );
        }
        if (changed) {
          void this.reportConfig();
        }
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Apply persisted/requested config, then reconcile the backend with reality.
   *
   * Only a value the agent actually advertises is applied; an unadvertised value
   * is skipped (not applied) because `setSessionConfigOption` accepts an unknown id
   * silently and only fails much later at prompt time (e.g. a Codex runner that
   * inherited a Claude "opus" model) — so a try/catch fallback never fires and we
   * must validate up front. The incoming value is the current backend value
   * (persisted load at startup, or the desktop's PUT), so we record it as
   * believed-backend before reconciling; reportConfig then corrects the backend
   * wherever the agent's actual selection differs.
   */
  async applySessionConfig(config: SessionConfigUpdate): Promise<void> {
    log.info(`[${this.tag}] Applying session config: acpMode=${config.acpMode}, acpModel=${config.acpModel}`);
    for (const category of CONFIG_CATEGORIES) {
      const requested = config[CONFIG_FIELD[category]];
      this.believedBackend[category] = requested ?? null;
      if (!requested) {
        continue;
      }
      if (this.isAdvertised(category, requested)) {
        await this.applyCategory(category, requested);
      } else {
        log.warn(
          `[${this.tag}] Persisted ${category} "${requested}" is not advertised by this agent; keeping current "${this.current[category]?.selectedId ?? 'unknown'}"`,
        );
      }
    }
    await this.reportConfig();
  }

  /** Whether the agent advertises a value with this id for the category. */
  private isAdvertised(category: ConfigCategory, id: string): boolean {
    return this.current[category]?.options.some((o) => o.id === id) ?? false;
  }

  /**
   * Reconcile the backend member record with the value the agent is actually
   * using: for each dimension where the agent advertises a current value that
   * differs from what we believe the backend holds, push it. A dimension the
   * agent advertises no value for is left untouched (undefined = unknown, not
   * cleared). No-ops when already in sync, so it is safe to call after every
   * apply and every session update without double-reporting.
   *
   * Reconciles run serialized on a single chain: rapid ACP updates (each firing
   * a fire-and-forget reportConfig) must not write concurrently, or an older
   * write completing last could leave the backend stale while believedBackend
   * has already advanced. Serializing also coalesces — a queued reconcile re-reads
   * the latest selection when it runs and no-ops if a prior write already synced it.
   */
  private reportConfig(): Promise<void> {
    this.reconcileChain = this.reconcileChain.then(() => this.doReportConfig());
    return this.reconcileChain;
  }

  private async doReportConfig(): Promise<void> {
    if (this.sessionType !== 'conversation') {
      return;
    }
    const payload: Partial<Record<ConfigField, string | null>> = {};
    const reconciled: ConfigCategory[] = [];
    for (const category of CONFIG_CATEGORIES) {
      const selected = this.current[category]?.selectedId;
      if (selected === undefined || selected === this.believedBackend[category]) {
        continue;
      }
      payload[CONFIG_FIELD[category]] = selected;
      reconciled.push(category);
    }
    if (reconciled.length === 0) {
      return;
    }
    try {
      await this.updateConfig(payload);
      // Record what we actually wrote, not the live selection — a newer update may have advanced
      // this.current while this write was in flight, and its own reconcile will pick that up.
      for (const category of reconciled) {
        this.believedBackend[category] = payload[CONFIG_FIELD[category]] ?? null;
      }
      log.info(
        `[${this.tag}] Reported config: ${reconciled.map((c) => `${CONFIG_FIELD[c]}=${payload[CONFIG_FIELD[c]]}`).join(', ')}`,
      );
    } catch (err: unknown) {
      log.warn(`[${this.tag}] Failed to report session config`, err);
    }
  }

  private get tag(): string {
    return `${this.sessionType}/${this.externalReferenceId}`;
  }
}

/** Find the select config option advertised for a category — carries its setter `id`. */
function findSelectOption(
  configOptions: ReadonlyArray<acp.SessionConfigOption> | null | undefined,
  category: string,
): (acp.SessionConfigOption & { type: 'select' }) | undefined {
  if (!configOptions) {
    return undefined;
  }
  for (const opt of configOptions) {
    if (opt.type === 'select' && opt.category === category) {
      return opt;
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
