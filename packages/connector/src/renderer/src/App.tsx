/**
 * Root app component — two-panel layout: sidebar (agent list) + detail panel.
 */
import { useEffect, useState } from 'react';
import { Bot, Plus, Settings } from 'lucide-react';
import { useAgentStore } from './stores/agent-store';
import { AgentListItem } from './components/AgentListItem';
import { AgentDetailPanel } from './components/AgentDetailPanel';
import { AgentFormPanel } from './components/AgentFormPanel';
import { SettingsPanel } from './components/SettingsPanel';

type PanelMode = { kind: 'view' } | { kind: 'add' } | { kind: 'edit'; agentId: string } | { kind: 'settings' };

export function App(): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const load = useAgentStore((s) => s.load);
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const setAgentStatus = useAgentStore((s) => s.setAgentStatus);
  const setApprovalUrl = useAgentStore((s) => s.setApprovalUrl);
  const setPollTimestamp = useAgentStore((s) => s.setPollTimestamp);
  const updateConfig = useAgentStore((s) => s.updateConfig);
  const [panelMode, setPanelMode] = useState<PanelMode>({ kind: 'view' });

  useEffect(() => {
    void load();
    // Apply initial theme class
    void window.api.getTheme().then(async (t) => {
      if (t === 'light' || (t === 'system' && !(await window.api.getNativeThemeDark()))) {
        document.documentElement.classList.add('light');
      }
    });
  }, [load]);

  useEffect(() => {
    const unsub1 = window.api.onAgentStatusChanged(({ agentId, status, error }) => {
      setAgentStatus(agentId, status, error);
    });
    const unsub2 = window.api.onAgentApprovalUrl(({ agentId, approvalUrl }) => {
      setApprovalUrl(agentId, approvalUrl);
    });
    const unsub2b = window.api.onAgentPollAttempt(({ agentId }) => {
      setPollTimestamp(agentId);
    });
    const unsub3 = window.api.onAgentConfigUpdated(({ agentId, config }) => {
      updateConfig(agentId, config);
    });
    return () => {
      unsub1();
      unsub2();
      unsub2b();
      unsub3();
    };
  }, [setAgentStatus, setApprovalUrl, setPollTimestamp, updateConfig]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  function handleSelectAgent(agentId: string): void {
    selectAgent(agentId);
    setPanelMode({ kind: 'view' });
  }

  function handleAdd(): void {
    selectAgent(null);
    setPanelMode({ kind: 'add' });
  }

  function handleFormClose(): void {
    setPanelMode({ kind: 'view' });
  }

  function renderDetailPanel(): React.JSX.Element {
    if (panelMode.kind === 'settings') {
      return <SettingsPanel />;
    }

    if (panelMode.kind === 'add') {
      return <AgentFormPanel onDone={handleFormClose} />;
    }

    if (panelMode.kind === 'edit') {
      const editAgent = agents.find((a) => a.id === panelMode.agentId);
      if (editAgent) {
        return <AgentFormPanel editAgent={editAgent.config} onDone={handleFormClose} />;
      }
    }

    if (selectedAgent) {
      return (
        <AgentDetailPanel
          agent={selectedAgent}
          onEdit={() => setPanelMode({ kind: 'edit', agentId: selectedAgent.id })}
        />
      );
    }

    return (
      <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
        <Bot size={48} className="mb-3 opacity-30" />
        <p className="text-sm">Select an agent or add a new one to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-background text-foreground">
      {/* Sidebar */}
      <div className="flex w-60 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
        {/* Drag region */}
        <div className="h-10 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3">
          <h1 className="text-sm font-semibold">Agents</h1>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:opacity-80"
            title="Add agent"
            onClick={handleAdd}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto px-2">
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 pt-12 opacity-60">
              <Bot size={32} className="mb-2 opacity-40" />
              <p className="text-center text-xs">No agents yet. Click + to connect your first agent.</p>
            </div>
          ) : (
            agents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedAgentId && panelMode.kind === 'view'}
                onClick={() => handleSelectAgent(agent.id)}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center border-t border-white/10 px-4 py-3">
          <button
            className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground opacity-85 transition-opacity hover:opacity-100"
            onClick={() => setPanelMode({ kind: 'settings' })}
          >
            <Settings size={14} />
            Settings
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col bg-background">
        {/* Drag region */}
        <div className="h-10 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        {renderDetailPanel()}
      </div>
    </div>
  );
}
