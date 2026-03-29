/**
 * Agent config manager — CRUD operations on persisted agent configurations.
 *
 * This is the "registry" of agents. Runtime state (running/stopped) is
 * managed separately by the AgentRuntimeManager (C3).
 */
import { randomUUID } from 'crypto';
import type Store from 'electron-store';
import type { StoreSchema } from './store';
import type { AgentConfig, AddAgentInput, UpdateAgentInput } from '../shared/types';

export class AgentConfigManager {
  private readonly store: Store<StoreSchema>;

  constructor(store: Store<StoreSchema>) {
    this.store = store;
  }

  list(): AgentConfig[] {
    return this.store.get('agents');
  }

  get(agentId: string): AgentConfig | undefined {
    return this.store.get('agents').find((a) => a.id === agentId);
  }

  add(input: AddAgentInput): AgentConfig {
    const config: AgentConfig = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      ...(input.newioUsername ? { newioUsername: input.newioUsername } : {}),
      ...(input.claude ? { claude: input.claude } : {}),
      ...(input.kiroCli ? { kiroCli: input.kiroCli } : {}),
    };
    const agents = this.store.get('agents');
    this.store.set('agents', [...agents, config]);
    return config;
  }

  update(agentId: string, updates: UpdateAgentInput): AgentConfig {
    const agents = [...this.store.get('agents')];
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: AgentConfig = {
      ...agents[index],
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.claude !== undefined ? { claude: updates.claude } : {}),
      ...(updates.kiroCli !== undefined ? { kiroCli: updates.kiroCli } : {}),
    };
    agents[index] = updated;
    this.store.set('agents', agents);
    return updated;
  }

  remove(agentId: string): void {
    const agents = this.store.get('agents');
    const filtered = agents.filter((a) => a.id !== agentId);
    if (filtered.length === agents.length) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    this.store.set('agents', filtered);
  }

  /** Update Newio identity on an agent config (called after registration). */
  setNewioIdentity(
    agentId: string,
    identity: {
      newioAgentId: string;
      newioUsername: string;
      newioDisplayName?: string;
      newioAvatarUrl?: string;
    },
  ): AgentConfig {
    const agents = [...this.store.get('agents')];
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: AgentConfig = { ...agents[index], ...identity };
    agents[index] = updated;
    this.store.set('agents', agents);
    return updated;
  }
}
