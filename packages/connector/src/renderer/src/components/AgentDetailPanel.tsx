/**
 * Agent detail panel — shows config, status, and lifecycle actions.
 */
import { useState } from 'react';
import { Bot, Terminal, Trash2, Play, Square, ExternalLink, Loader2 } from 'lucide-react';
import type { AgentStatusInfo } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';

const STATUS_LABELS: Record<string, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  awaiting_approval: 'Awaiting approval',
  connected: 'Connected',
  running: 'Running',
  error: 'Error',
};

const STATUS_CLASSES: Record<string, string> = {
  stopped: 'text-muted-foreground',
  starting: 'text-warning',
  awaiting_approval: 'text-warning',
  connected: 'text-success',
  running: 'text-success',
  error: 'text-destructive',
};

const DOT_CLASSES: Record<string, string> = {
  stopped: 'bg-muted-foreground',
  starting: 'bg-warning',
  awaiting_approval: 'bg-warning',
  connected: 'bg-success',
  running: 'bg-success',
  error: 'bg-destructive',
};

function Field({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

export function AgentDetailPanel({ agent }: { readonly agent: AgentStatusInfo }): React.JSX.Element {
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const startAgent = useAgentStore((s) => s.startAgent);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const approvalUrl = useAgentStore((s) => s.approvalUrls[agent.id]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { config } = agent;
  const isStopped = agent.runtimeStatus === 'stopped' || agent.runtimeStatus === 'error';
  const isRunning = agent.runtimeStatus === 'running';
  const isBusy =
    agent.runtimeStatus === 'starting' ||
    agent.runtimeStatus === 'awaiting_approval' ||
    agent.runtimeStatus === 'connected';

  function handleDelete(): void {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    void removeAgent(agent.id);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          {config.type === 'kiro-cli' ? <Terminal size={20} /> : <Bot size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">{config.name}</div>
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
            <button
              className="flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-80"
              onClick={() => void startAgent(agent.id)}
            >
              <Play size={12} />
              Start
            </button>
          )}
          {isRunning && (
            <button
              className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:opacity-80"
              onClick={() => void stopAgent(agent.id)}
            >
              <Square size={12} />
              Stop
            </button>
          )}
          {isBusy && (
            <button
              className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:opacity-80"
              onClick={() => void stopAgent(agent.id)}
            >
              <Loader2 size={12} className="animate-spin" />
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Approval URL banner */}
        {agent.runtimeStatus === 'awaiting_approval' && approvalUrl && (
          <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-3">
            <div className="mb-1 text-xs font-medium text-warning">Owner approval required</div>
            <div className="mb-2 text-xs text-muted-foreground">
              Open the link below to approve this agent. The owner must enter a username and approve.
            </div>
            <button
              className="flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:opacity-80"
              onClick={() => void window.api.openExternal(approvalUrl)}
            >
              <ExternalLink size={12} />
              Open approval page
            </button>
          </div>
        )}

        <Field label="Type" value={config.type === 'kiro-cli' ? 'Kiro CLI' : 'Claude'} />

        {config.newioUsername && <Field label="Newio Username" value={`@${config.newioUsername}`} />}
        {config.newioDisplayName && <Field label="Display Name" value={config.newioDisplayName} />}
        {config.newioAgentId && <Field label="Newio Agent ID" value={config.newioAgentId} />}
        {!config.newioAgentId && (
          <div className="mb-3 text-xs text-muted-foreground">
            Not registered with Newio yet. Start the agent to register.
          </div>
        )}

        {config.claude && (
          <>
            <Field label="Model" value={config.claude.model} />
            <Field label="API Key" value={'•'.repeat(12) + config.claude.apiKey.slice(-4)} />
            {config.claude.systemPrompt && <Field label="System Prompt" value={config.claude.systemPrompt} />}
          </>
        )}

        {config.kiroCli && <Field label="Agent Name" value={config.kiroCli.agentName} />}

        {agent.error && (
          <div className="mt-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
            {agent.error}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
        <button
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors hover:opacity-80 disabled:opacity-40 ${
            confirmDelete
              ? 'border-transparent bg-destructive text-destructive-foreground'
              : 'border-destructive text-destructive'
          }`}
          disabled={!isStopped}
          onClick={handleDelete}
          onBlur={() => setConfirmDelete(false)}
        >
          <Trash2 size={12} />
          {confirmDelete ? 'Confirm Delete' : 'Delete'}
        </button>
      </div>
    </div>
  );
}
