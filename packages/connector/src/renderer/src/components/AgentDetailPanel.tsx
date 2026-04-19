/**
 * Agent detail panel — shows config, status, and lifecycle actions.
 * Two tabs: Configuration and Environment Variables.
 */
import { useEffect, useState } from 'react';
import { Bot, Terminal, Play, Square, Loader2 } from 'lucide-react';
import type { AgentStatusInfo } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { agentTypeLabel } from '../lib/agent-type-label';
import { ConfigTab } from './ConfigTab';
import { EnvVarsTab } from './EnvVarsTab';
import { Button } from './ui';

const STATUS_LABELS: Record<string, string> = {
  stopped: 'Stopped',
  starting: 'Connecting to Newio…',
  awaiting_approval: 'Awaiting approval',
  initializing: 'Initializing…',
  greeting: 'Starting session…',
  running: 'Running',
  error: 'Error',
};

const STATUS_CLASSES: Record<string, string> = {
  stopped: 'text-muted-foreground',
  starting: 'text-warning',
  awaiting_approval: 'text-warning',
  initializing: 'text-warning',
  greeting: 'text-warning',
  running: 'text-success',
  error: 'text-destructive',
};

const DOT_CLASSES: Record<string, string> = {
  stopped: 'bg-muted-foreground',
  starting: 'bg-warning',
  awaiting_approval: 'bg-warning',
  initializing: 'bg-warning',
  greeting: 'bg-warning',
  running: 'bg-success',
  error: 'bg-destructive',
};

type Tab = 'config' | 'env';

export function AgentDetailPanel({
  agent,
  onEdit,
}: {
  readonly agent: AgentStatusInfo;
  readonly onEdit: () => void;
}): React.JSX.Element {
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const [activeTab, setActiveTab] = useState<Tab>('config');
  const [startError, setStartError] = useState<string | null>(null);

  // Reset tab when switching agents
  useEffect(() => {
    setActiveTab('config');
    setStartError(null);
  }, [agent.id]);

  const { config } = agent;
  const isStopped = agent.runtimeStatus === 'stopped' || agent.runtimeStatus === 'error';
  const isRunning = agent.runtimeStatus === 'running';
  const isBusy =
    agent.runtimeStatus === 'starting' ||
    agent.runtimeStatus === 'awaiting_approval' ||
    agent.runtimeStatus === 'initializing' ||
    agent.runtimeStatus === 'greeting';

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4">
        {config.newio?.avatarUrl ? (
          <img src={config.newio.avatarUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            {config.type === 'kiro-cli' ? <Terminal size={20} /> : <Bot size={20} />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {config.newio?.displayName ?? agentTypeLabel(config.type)}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1 ${STATUS_CLASSES[agent.runtimeStatus] ?? 'text-muted-foreground'}`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_CLASSES[agent.runtimeStatus] ?? 'bg-muted-foreground'}`}
              />
              {STATUS_LABELS[agent.runtimeStatus] ?? agent.runtimeStatus}
            </span>
          </div>
        </div>

        {/* Start / Stop button */}
        <div className="flex gap-2">
          {isStopped && (
            <Button
              variant="success"
              onClick={() => {
                setStartError(null);
                startAgent(agent.id).catch((err: unknown) => {
                  setStartError(err instanceof Error ? err.message : String(err));
                });
              }}
            >
              <Play size={12} />
              Start
            </Button>
          )}
          {isRunning && (
            <Button variant="danger" onClick={() => void stopAgent(agent.id)}>
              <Square size={12} />
              Stop
            </Button>
          )}
          {isBusy && (
            <Button variant="danger" onClick={() => void stopAgent(agent.id)}>
              <Loader2 size={12} className="animate-spin" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Start error banner */}
      {startError && isStopped && (
        <div className="mx-6 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {startError}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border px-6">
        <button
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === 'config'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('config')}
        >
          Configuration
        </button>
        <button
          className={`px-3 py-2 text-xs font-medium transition-colors ${
            activeTab === 'env'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('env')}
        >
          Environment Variables
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'config' ? <ConfigTab agent={agent} onEdit={onEdit} /> : <EnvVarsTab agent={agent} />}
    </div>
  );
}
