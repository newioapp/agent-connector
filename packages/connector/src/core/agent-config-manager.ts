/**
 * Agent config manager interface — defines the contract for agent config and token persistence.
 *
 * Implementations:
 * - StoreAgentConfigManager (main/) — backed by electron-store
 * - InMemoryConfigManager (cli.ts) — in-memory for CLI usage
 */
import type { AgentConfig, AddAgentInput, UpdateAgentInput } from './types';

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
  setNewioIdentity(
    agentId: string,
    identity: {
      newioAgentId: string;
      newioUsername: string;
      newioDisplayName?: string;
      newioAvatarUrl?: string;
    },
  ): AgentConfig;
  getTokens(agentId: string): AgentTokens | undefined;
  setTokens(agentId: string, tokens: AgentTokens): void;
  clearTokens(agentId: string): void;
}
