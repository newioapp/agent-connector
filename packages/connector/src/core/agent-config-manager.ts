/**
 * Agent config manager interface — defines the contract for agent config and token persistence.
 *
 * Implementation: StoreAgentConfigManager (main/) — backed by electron-store.
 */
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity, AcpAgentInfo } from './types';

export interface AgentTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface AgentConfigManager {
  list(): AgentConfig[];
  get(agentId: string): AgentConfig | undefined;
  add(input: AddAgentInput): AgentConfig | Promise<AgentConfig>;
  update(agentId: string, updates: UpdateAgentInput): AgentConfig;
  remove(agentId: string): void;
  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig;
  setAcpAgentInfo(agentId: string, info: AcpAgentInfo): AgentConfig;
  getTokens(agentId: string): AgentTokens | undefined;
  setTokens(agentId: string, tokens: AgentTokens): void;
  clearTokens(agentId: string): void;
}
