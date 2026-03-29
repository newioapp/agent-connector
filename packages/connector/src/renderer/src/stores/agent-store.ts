/**
 * Agent store — renderer-side cache of agent state from the main process.
 */
import { create } from 'zustand';
import type { AgentStatusInfo, AddAgentInput, UpdateAgentInput, AgentRuntimeStatus } from '../../../shared/types';

interface AgentState {
  readonly agents: AgentStatusInfo[];
  readonly selectedAgentId: string | null;
}

interface AgentActions {
  load(): Promise<void>;
  addAgent(input: AddAgentInput): Promise<void>;
  updateAgent(agentId: string, updates: UpdateAgentInput): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  selectAgent(agentId: string | null): void;
  setAgentStatus(agentId: string, status: AgentRuntimeStatus, error?: string): void;
}

type AgentStore = AgentState & AgentActions;

export const useAgentStore = create<AgentStore>((set) => ({
  agents: [],
  selectedAgentId: null,

  async load(): Promise<void> {
    const agents = await window.api.listAgents();
    set({ agents });
  },

  async addAgent(input: AddAgentInput): Promise<void> {
    const config = await window.api.addAgent(input);
    const newAgent: AgentStatusInfo = { id: config.id, config, runtimeStatus: 'stopped' };
    set((state: AgentState) => ({ agents: [...state.agents, newAgent], selectedAgentId: config.id }));
  },

  async updateAgent(agentId: string, updates: UpdateAgentInput): Promise<void> {
    const config = await window.api.updateAgent(agentId, updates);
    set((state: AgentState) => ({
      agents: state.agents.map((a) => (a.id === agentId ? { ...a, config } : a)),
    }));
  },

  async removeAgent(agentId: string): Promise<void> {
    await window.api.removeAgent(agentId);
    set((state: AgentState) => ({
      agents: state.agents.filter((a) => a.id !== agentId),
      selectedAgentId: state.selectedAgentId === agentId ? null : state.selectedAgentId,
    }));
  },

  selectAgent(agentId: string | null): void {
    set({ selectedAgentId: agentId });
  },

  setAgentStatus(agentId: string, status: AgentRuntimeStatus, error?: string): void {
    set((state: AgentState) => ({
      agents: state.agents.map((a) => (a.id === agentId ? { ...a, runtimeStatus: status, error } : a)),
    }));
  },
}));
