/**
 * Agent config manager interface — defines the contract for agent config and token persistence.
 *
 * Implementation: FileAgentConfigManager (core/) — backed by ~/.newio/ JSON files.
 */
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from './types';

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
  getTokens(agentId: string): AgentTokens | undefined;
  setTokens(agentId: string, tokens: AgentTokens): void;
  clearTokens(agentId: string): void;
}
