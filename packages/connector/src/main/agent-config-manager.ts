/**
 * Agent config manager — CRUD operations on persisted agent configurations.
 *
 * This is the "registry" of agents. Runtime state (running/stopped) is
 * managed separately by the AgentRuntimeManager (C3).
 */
import { randomUUID } from 'crypto';
import type Store from 'electron-store';
import type { StoreSchema } from './store';
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from '../shared/types';
import { getShellEnv, listAvailableShells } from './shell-env';

export type { AgentConfigManager, AgentTokens } from '../core/agent-config-manager';
import type { AgentConfigManager, AgentTokens } from '../core/agent-config-manager';

export class StoreAgentConfigManager implements AgentConfigManager {
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

  async add(input: AddAgentInput): Promise<AgentConfig> {
    const shells = listAvailableShells();
    const envVars = shells.length > 0 ? await getShellEnv(shells[0]) : {};
    const config: AgentConfig = {
      id: randomUUID(),
      type: input.type,
      newio: {
        displayName: input.displayName,
        ...(input.newioUsername ? { username: input.newioUsername } : {}),
      },
      envVars,
      ...(input.acp ? { acp: input.acp } : {}),
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
    const existing = agents[index];
    const usernameChanged = updates.newioUsername !== undefined && updates.newioUsername !== existing.newio?.username;
    const displayName = updates.displayName ?? existing.newio?.displayName;
    let newio = existing.newio;
    if (usernameChanged) {
      // Reset identity on username change — preserve displayName, will re-sync on next start
      newio = { displayName, ...(updates.newioUsername ? { username: updates.newioUsername } : {}) };
    } else if (updates.displayName !== undefined) {
      newio = { ...existing.newio, displayName: updates.displayName };
    }
    const updated: AgentConfig = {
      ...existing,
      newio,
      ...(updates.envVars !== undefined ? { envVars: updates.envVars } : {}),
      ...(updates.acp !== undefined ? { acp: updates.acp } : {}),
    };
    agents[index] = updated;
    this.store.set('agents', agents);

    // Clear persisted tokens when Newio identity changes — old tokens are invalid
    if (usernameChanged) {
      const tokens = this.store.get('agentTokens');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removed, ...rest } = tokens;
      this.store.set('agentTokens', rest);
    }

    return updated;
  }

  remove(agentId: string): void {
    const agents = this.store.get('agents');
    const filtered = agents.filter((a) => a.id !== agentId);
    if (filtered.length === agents.length) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    this.store.set('agents', filtered);
    this.clearTokens(agentId);
  }

  /** Update Newio identity on an agent config (called after registration). */
  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const agents = [...this.store.get('agents')];
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: AgentConfig = { ...agents[index], newio: identity };
    agents[index] = updated;
    this.store.set('agents', agents);
    return updated;
  }

  getTokens(agentId: string): AgentTokens | undefined {
    const all = this.store.get('agentTokens');
    return agentId in all ? all[agentId] : undefined;
  }

  setTokens(agentId: string, tokens: AgentTokens): void {
    const all = this.store.get('agentTokens');
    this.store.set('agentTokens', { ...all, [agentId]: tokens });
  }

  clearTokens(agentId: string): void {
    const all = this.store.get('agentTokens');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
    const { [agentId]: _removed, ...rest } = all;
    this.store.set('agentTokens', rest);
  }
}
