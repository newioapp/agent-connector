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
} from '@newio/agent-engine';

export type ThemeSource = 'system' | 'light' | 'dark';
export type UpdateMode = 'auto' | 'manual' | 'disabled';
export type UpdateChannel = 'latest' | 'beta';
