export type {
  AgentType,
  AgentRuntimeStatus,
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
  ClaudeAuthMethod,
} from '@newio/agent-engine';

export type ThemeSource = 'system' | 'light' | 'dark';
export type UpdateMode = 'auto' | 'manual' | 'disabled';
export type UpdateChannel = 'latest' | 'beta';

/** Outcome of an interactive Claude authentication run. */
export interface ClaudeAuthResult {
  readonly ok: boolean;
  /** Process exit code, if the auth process exited. */
  readonly code?: number;
}
