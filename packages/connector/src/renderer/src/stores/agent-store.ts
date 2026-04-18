/**
 * Agent store — renderer-side cache of agent state from the main process.
 */
import { create } from 'zustand';
import type {
  AgentStatusInfo,
  AgentConfig,
  AddAgentInput,
  UpdateAgentInput,
  AgentRuntimeStatus,
  AgentSessionConfig,
} from '../../../shared/types';

interface SessionConfigEntry {
  readonly models?: AgentSessionConfig;
  readonly modes?: AgentSessionConfig;
}

interface AgentState {
  readonly agents: AgentStatusInfo[];
  readonly selectedAgentId: string | null;
  readonly approvalUrls: Record<string, string>;
  readonly pollTimestamps: Record<string, number>;
  /** Session configs keyed by agentId. Currently tracks the representative session's config. */
  readonly sessionConfigs: Record<string, SessionConfigEntry>;
}

interface AgentActions {
  load(): Promise<void>;
  addAgent(input: AddAgentInput): Promise<void>;
  updateAgent(agentId: string, updates: UpdateAgentInput): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  startAgent(agentId: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;
  selectAgent(agentId: string | null): void;
  setAgentStatus(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  setApprovalUrl(agentId: string, url: string): void;
  setPollTimestamp(agentId: string): void;
  updateConfig(agentId: string, config: AgentConfig): void;
  setSessionConfig(agentId: string, sessionId: string, models?: AgentSessionConfig, modes?: AgentSessionConfig): void;
}

type AgentStore = AgentState & AgentActions;

export const useAgentStore = create<AgentStore>((set) => ({
  agents: [],
  selectedAgentId: null,
  approvalUrls: {},
  pollTimestamps: {},
  sessionConfigs: {},

  async load(): Promise<void> {
    const agents = await window.api.listAgents();
    set((state: AgentState) => ({
      agents,
      selectedAgentId: state.selectedAgentId ?? (agents.length > 0 ? agents[0].id : null),
    }));
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
    set((state: AgentState) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removed, ...restConfigs } = state.sessionConfigs;
      return {
        agents: state.agents.filter((a) => a.id !== agentId),
        selectedAgentId: state.selectedAgentId === agentId ? null : state.selectedAgentId,
        sessionConfigs: restConfigs,
      };
    });
  },

  async startAgent(agentId: string): Promise<void> {
    await window.api.startAgent(agentId);
  },

  async stopAgent(agentId: string): Promise<void> {
    await window.api.stopAgent(agentId);
  },

  selectAgent(agentId: string | null): void {
    set({ selectedAgentId: agentId });
  },

  setAgentStatus(agentId: string, status: AgentRuntimeStatus, error?: string): void {
    set((state: AgentState) => {
      const isStopped = status === 'stopped' || status === 'error';
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removed, ...restConfigs } = state.sessionConfigs;
      return {
        agents: state.agents.map((a) => (a.id === agentId ? { ...a, runtimeStatus: status, error } : a)),
        approvalUrls:
          status !== 'awaiting_approval'
            ? Object.fromEntries(Object.entries(state.approvalUrls).filter(([k]) => k !== agentId))
            : state.approvalUrls,
        ...(isStopped ? { sessionConfigs: restConfigs } : {}),
      };
    });
  },

  setApprovalUrl(agentId: string, url: string): void {
    set((state: AgentState) => ({
      approvalUrls: { ...state.approvalUrls, [agentId]: url },
    }));
  },

  setPollTimestamp(agentId: string): void {
    set((state: AgentState) => ({
      pollTimestamps: { ...state.pollTimestamps, [agentId]: Date.now() },
    }));
  },

  updateConfig(agentId: string, config: AgentConfig): void {
    set((state: AgentState) => ({
      agents: state.agents.map((a) => (a.id === agentId ? { ...a, config } : a)),
    }));
  },

  setSessionConfig(agentId: string, _sessionId: string, models?: AgentSessionConfig, modes?: AgentSessionConfig): void {
    set((state: AgentState) => ({
      sessionConfigs: { ...state.sessionConfigs, [agentId]: { models, modes } },
    }));
  },
}));
