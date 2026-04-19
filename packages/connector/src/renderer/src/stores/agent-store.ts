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
  AgentInfo,
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
  /** ACP agent info keyed by agentId — runtime only, cleared on stop. */
  readonly agentInfos: Partial<Record<string, AgentInfo>>;
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
  setAgentInfo(agentId: string, info: AgentInfo): void;
}

type AgentStore = AgentState & AgentActions;

export const useAgentStore = create<AgentStore>((set) => ({
  agents: [],
  selectedAgentId: null,
  approvalUrls: {},
  pollTimestamps: {},
  sessionConfigs: {},
  agentInfos: {},

  async load(): Promise<void> {
    const agents = await window.api.listAgents();
    const infos: Record<string, AgentInfo> = {};
    await Promise.all(
      agents
        .filter(
          (a) => a.runtimeStatus === 'running' || a.runtimeStatus === 'initializing' || a.runtimeStatus === 'greeting',
        )
        .map(async (a) => {
          const info = await window.api.getAgentInfo(a.id);
          if (info) {
            infos[a.id] = info;
          }
        }),
    );
    set((state: AgentState) => ({
      agents,
      selectedAgentId: state.selectedAgentId ?? (agents.length > 0 ? agents[0].id : null),
      agentInfos: { ...state.agentInfos, ...infos },
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removedInfo, ...restInfos } = state.agentInfos;
      return {
        agents: state.agents.map((a) => (a.id === agentId ? { ...a, runtimeStatus: status, error } : a)),
        approvalUrls:
          status !== 'awaiting_approval'
            ? Object.fromEntries(Object.entries(state.approvalUrls).filter(([k]) => k !== agentId))
            : state.approvalUrls,
        ...(isStopped ? { sessionConfigs: restConfigs, agentInfos: restInfos } : {}),
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

  setAgentInfo(agentId: string, info: AgentInfo): void {
    set((state: AgentState) => ({
      agentInfos: { ...state.agentInfos, [agentId]: info },
    }));
  },
}));
