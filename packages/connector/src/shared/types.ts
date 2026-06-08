export type {
  AgentType,
  AgentRuntimeStatus,
  AgentErrorCode,
  AcpConfig,
  AgentInfo,
  Capability,
  AgentAuthMethod,
  NewioIdentity,
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  AgentStatusInfo,
  SessionMode,
  EnvSyncMode,
} from '@newio/agent-engine';
import type { EnvSyncMode } from '@newio/agent-engine';

export type { Stage } from '@newio/cli';
import type { Stage } from '@newio/cli';

export type ThemeSource = 'system' | 'light' | 'dark';
export type UpdateMode = 'auto' | 'manual' | 'disabled';
export type UpdateChannel = 'latest' | 'beta';

/** The selectable stages, ordered for display. */
export const STAGES: readonly Stage[] = ['dev', 'integ', 'prod'];

/**
 * Env-sync modes for the env tab. Defined locally (not value-imported from
 * @newio/agent-engine) so the renderer bundle stays free of that node-only package;
 * the type still comes from the engine, keeping the two in sync.
 */
export const ENV_SYNC_MODES: readonly EnvSyncMode[] = ['basic', 'all'];

/** Which stage the desktop attaches to, and whether the user may change it (dev builds only). */
export interface StageConfig {
  readonly stage: Stage;
  readonly selectorEnabled: boolean;
}
