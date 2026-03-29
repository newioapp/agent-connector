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
  running: 'Running',
  error: 'Error',
};

const STATUS_COLORS: Record<string, string> = {
  stopped: 'var(--text-muted)',
  starting: 'var(--warning)',
  awaiting_approval: 'var(--warning)',
  running: 'var(--success)',
  error: 'var(--danger)',
};

function Field({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div className="text-sm" style={{ color: 'var(--text)' }}>
        {value}
      </div>
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
  const isBusy = agent.runtimeStatus === 'starting' || agent.runtimeStatus === 'awaiting_approval';

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
      <div className="flex items-center gap-3 border-b px-6 py-4" style={{ borderColor: 'var(--border)' }}>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {config.type === 'kiro-cli' ? <Terminal size={20} /> : <Bot size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold" style={{ color: 'var(--text)' }}>
            {config.name}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className="inline-flex items-center gap-1"
              style={{ color: STATUS_COLORS[agent.runtimeStatus] ?? 'var(--text-muted)' }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: STATUS_COLORS[agent.runtimeStatus] ?? 'var(--text-muted)' }}
              />
              {STATUS_LABELS[agent.runtimeStatus] ?? agent.runtimeStatus}
            </span>
          </div>
        </div>

        {/* Start / Stop button */}
        <div className="flex gap-2">
          {isStopped && (
            <button
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
              style={{ background: 'var(--success)', color: '#fff' }}
              onClick={() => void startAgent(agent.id)}
            >
              <Play size={12} />
              Start
            </button>
          )}
          {isRunning && (
            <button
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
              style={{ background: 'var(--danger)', color: '#fff' }}
              onClick={() => void stopAgent(agent.id)}
            >
              <Square size={12} />
              Stop
            </button>
          )}
          {isBusy && (
            <button
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
              style={{ background: 'var(--danger)', color: '#fff' }}
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
          <div
            className="mb-4 rounded-md border px-4 py-3"
            style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
          >
            <div className="mb-1 text-xs font-medium" style={{ color: 'var(--warning)' }}>
              Owner approval required
            </div>
            <div className="mb-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              Open the link below to approve this agent. The owner must enter a username and approve.
            </div>
            <button
              className="flex items-center gap-1.5 text-xs font-medium transition-colors hover:opacity-80"
              style={{ color: 'var(--accent)' }}
              onClick={() => void window.api.openExternal(approvalUrl)}
            >
              <ExternalLink size={12} />
              Open approval page
            </button>
          </div>
        )}

        <Field label="Type" value={config.type === 'kiro-cli' ? 'Kiro CLI' : 'Claude'} />

        {config.newioUsername && <Field label="Newio Username" value={`@${config.newioUsername}`} />}
        {config.newioAgentId && <Field label="Newio Agent ID" value={config.newioAgentId} />}
        {!config.newioAgentId && (
          <div className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
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
          <div
            className="mt-2 rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
          >
            {agent.error}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t px-6 py-3" style={{ borderColor: 'var(--border)' }}>
        <button
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors hover:opacity-80"
          style={{
            background: confirmDelete ? 'var(--danger)' : 'transparent',
            color: confirmDelete ? '#fff' : 'var(--danger)',
            border: confirmDelete ? 'none' : '1px solid var(--danger)',
          }}
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
