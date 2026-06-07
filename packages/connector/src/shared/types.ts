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
} from '@newio/agent-engine';

export type { Stage } from '@newio/cli';
import type { Stage } from '@newio/cli';

export type ThemeSource = 'system' | 'light' | 'dark';
export type UpdateMode = 'auto' | 'manual' | 'disabled';
export type UpdateChannel = 'latest' | 'beta';

/** The selectable stages, ordered for display. */
export const STAGES: readonly Stage[] = ['dev', 'integ', 'prod'];

/** Which stage the desktop attaches to, and whether the user may change it (dev builds only). */
export interface StageConfig {
  readonly stage: Stage;
  readonly selectorEnabled: boolean;
}
