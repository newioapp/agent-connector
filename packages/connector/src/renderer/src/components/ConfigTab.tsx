/**
 * Configuration tab — displays agent config fields, approval banner, and edit/delete actions.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2, ExternalLink, RefreshCw, Pencil, Info, X } from 'lucide-react';
import type { AgentStatusInfo, AcpAgentInfo, AgentSessionConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { agentTypeLabel } from '../lib/agent-type-label';
import { Button, Dropdown } from './ui';

const APPROVAL_TIMEOUT_S = 600;

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function AcpInfoModal({
  info,
  onClose,
}: {
  readonly info: AcpAgentInfo;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-80 rounded-lg border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">ACP Agent Info</h3>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="space-y-2 text-xs">
          {(info.agentTitle ?? info.agentName) && (
            <Field label="Agent" value={info.agentTitle ?? info.agentName ?? ''} />
          )}
          {info.agentVersion && <Field label="Version" value={info.agentVersion} />}
          <Field label="Protocol Version" value={info.protocolVersion} />
          <Field label="Load Session" value={info.loadSession ? 'Supported' : 'Not supported'} />
        </div>
      </div>
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
  const [showInfo, setShowInfo] = useState(false);
  const [models, setModels] = useState<AgentSessionConfig | undefined>();
  const [modes, setModes] = useState<AgentSessionConfig | undefined>();
  const [configError, setConfigError] = useState<string | undefined>();

  // Fetch available models/modes when agent is running
  useEffect(() => {
    if (agent.runtimeStatus !== 'running') {
      setModels(undefined);
      setModes(undefined);
      return;
    }
    void window.api.listAgentModels(agent.id).then(setModels);
    void window.api.listAgentModes(agent.id).then(setModes);
  }, [agent.id, agent.runtimeStatus]);

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

        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1">
            <div className="mb-0.5 text-xs font-medium text-muted-foreground">Type</div>
            <div className="text-sm text-foreground">{agentTypeLabel(config.type)}</div>
          </div>
          {config.acpAgentInfo && (
            <button
              className="text-muted-foreground hover:text-primary transition-colors"
              title="ACP Agent Info"
              onClick={() => setShowInfo(true)}
            >
              <Info size={14} />
            </button>
          )}
        </div>

        {showInfo && config.acpAgentInfo && (
          <AcpInfoModal info={config.acpAgentInfo} onClose={() => setShowInfo(false)} />
        )}

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

        {config.acp && (
          <>
            {/* Model/Mode dropdowns when running */}
            {config.acp.executablePath && <Field label="Executable Path" value={config.acp.executablePath} />}
            {config.acp.cwd && <Field label="Working Directory" value={config.acp.cwd} />}
            {config.type === 'kiro-cli' && (
              <Field label="Trust All Tools" value={config.acp.kiroCliTrustAllTools !== false ? 'Yes' : 'No'} />
            )}
            {agent.runtimeStatus === 'running' && models && models.options.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Model</div>
                <Dropdown
                  options={models.options.map((m) => ({ value: m.id, label: m.name }))}
                  value={models.selectedId}
                  onChange={(modelId) => {
                    const prev = models.selectedId;
                    setModels((p) => (p ? { ...p, selectedId: modelId } : p));
                    setConfigError(undefined);
                    window.api.configureAgent(agent.id, modelId, undefined).catch((err: unknown) => {
                      setModels((p) => (p ? { ...p, selectedId: prev } : p));
                      setConfigError(extractErrorMessage(err));
                    });
                  }}
                />
              </div>
            )}
            {agent.runtimeStatus === 'running' && modes && modes.options.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {config.type === 'kiro-cli' ? 'Custom Agent (ACP Mode)' : 'Mode'}
                </div>
                <Dropdown
                  options={modes.options.map((m) => ({ value: m.id, label: m.name }))}
                  value={modes.selectedId}
                  onChange={(modeId) => {
                    const prev = modes.selectedId;
                    setModes((p) => (p ? { ...p, selectedId: modeId } : p));
                    setConfigError(undefined);
                    window.api.configureAgent(agent.id, undefined, modeId).catch((err: unknown) => {
                      setModes((p) => (p ? { ...p, selectedId: prev } : p));
                      setConfigError(extractErrorMessage(err));
                    });
                  }}
                />
              </div>
            )}
            {configError && <div className="mb-3 select-text cursor-text text-xs text-destructive">{configError}</div>}
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
