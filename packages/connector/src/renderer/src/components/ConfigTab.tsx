/**
 * Configuration tab — displays agent config fields, approval banner, and edit/delete actions.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2, ExternalLink, RefreshCw, Pencil } from 'lucide-react';
import type { AgentStatusInfo } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button } from './ui';

const APPROVAL_TIMEOUT_S = 600;

function useCountdown(active: boolean): number {
  const [remaining, setRemaining] = useState(APPROVAL_TIMEOUT_S);
  const startRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setRemaining(APPROVAL_TIMEOUT_S);
      return;
    }
    startRef.current = Date.now();
    setRemaining(APPROVAL_TIMEOUT_S);
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startRef.current) / 1000);
      const left = Math.max(0, APPROVAL_TIMEOUT_S - elapsed);
      setRemaining(left);
      if (left === 0) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return remaining;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function Field({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <div className="mb-0.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

export function ConfigTab({
  agent,
  onEdit,
}: {
  readonly agent: AgentStatusInfo;
  readonly onEdit: () => void;
}): React.JSX.Element {
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const approvalUrl = useAgentStore((s) => s.approvalUrls[agent.id]);
  const pollTimestamp = useAgentStore((s) => s.pollTimestamps[agent.id]);
  const [polling, setPolling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!pollTimestamp) {
      return;
    }
    setPolling(true);
    const id = setTimeout(() => setPolling(false), 800);
    return () => clearTimeout(id);
  }, [pollTimestamp]);

  const countdown = useCountdown(agent.runtimeStatus === 'awaiting_approval');
  const { config } = agent;
  const isStopped = agent.runtimeStatus === 'stopped' || agent.runtimeStatus === 'error';

  function handleDelete(): void {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    void removeAgent(agent.id);
  }

  return (
    <>
      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Error banner */}
        {agent.error && (
          <div className="mb-4 select-text rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive cursor-text whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">
            {agent.error}
          </div>
        )}

        {/* Approval URL banner */}
        {agent.runtimeStatus === 'awaiting_approval' && approvalUrl && (
          <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
                <RefreshCw size={12} className={polling ? 'animate-spin' : ''} />
                Owner approval required
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                Expires in {formatCountdown(countdown)}
              </span>
            </div>
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

        <Field label="Type" value={config.type === 'kiro-cli' ? 'Kiro CLI' : 'Claude Code'} />

        <div className="mb-3">
          <div className="mb-0.5 text-xs font-medium text-muted-foreground">Newio Username</div>
          {config.newio?.username ? (
            <div className="text-sm text-foreground">@{config.newio.username}</div>
          ) : (
            <div className="text-sm text-muted-foreground italic">Set during first launch</div>
          )}
        </div>
        {config.newio?.displayName && <Field label="Display Name" value={config.newio.displayName} />}
        {config.newio?.agentId && <Field label="Newio Agent ID" value={config.newio.agentId} />}

        {config.claude && (
          <>
            <Field label="Model" value={config.claude.model} />
            <Field label="API Key" value={'•'.repeat(12) + config.claude.apiKey.slice(-4)} />
            {config.claude.userPrompt && <Field label="User Prompt" value={config.claude.userPrompt} />}
            {config.claude.nodePath && <Field label="Node.js Path" value={config.claude.nodePath} />}
            {config.claude.claudeCodeCliPath && <Field label="CLI Path" value={config.claude.claudeCodeCliPath} />}
            {config.claude.cwd && <Field label="Working Directory" value={config.claude.cwd} />}
          </>
        )}

        {config.kiroCli && (
          <>
            {config.kiroCli.agentName && <Field label="Kiro Agent Name" value={config.kiroCli.agentName} />}
            {config.kiroCli.model && <Field label="Model" value={config.kiroCli.model} />}
            {config.kiroCli.kiroCliPath && <Field label="Kiro CLI Path" value={config.kiroCli.kiroCliPath} />}
            {config.kiroCli.cwd && <Field label="Working Directory" value={config.kiroCli.cwd} />}
            <Field label="Trust All Tools" value={config.kiroCli.trustAllTools !== false ? 'Yes' : 'No'} />
          </>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
        {!isStopped && <span className="mr-auto text-xs text-muted-foreground">Stop the agent to edit or delete.</span>}
        <Button variant="outline" disabled={!isStopped} onClick={onEdit}>
          <Pencil size={12} />
          Edit
        </Button>
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
    </>
  );
}
