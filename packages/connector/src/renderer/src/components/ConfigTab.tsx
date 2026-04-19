/**
 * Configuration tab — displays agent config fields, approval banner, and edit/delete actions.
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2, ExternalLink, RefreshCw, Pencil, Info, X, Check, Minus } from 'lucide-react';
import type { AgentStatusInfo, AgentInfo, AgentSessionConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { agentTypeLabel } from '../lib/agent-type-label';
import { Button, Dropdown } from './ui';
import { AgentTypeHint } from './AgentTypeHint';

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

function CapBadge({ label, enabled }: { readonly label: string; readonly enabled: boolean }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
        enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
      }`}
    >
      {enabled ? <Check size={10} /> : <Minus size={10} />}
      {label}
    </span>
  );
}

const AUTH_TYPE_LABELS: Record<string, string> = {
  env_var: 'env var',
  terminal: 'terminal',
  agent: 'agent',
};

function AgentInfoModal({
  info,
  onClose,
}: {
  readonly info: AgentInfo;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[80vh] w-[400px] overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Agent Information</h3>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Agent info */}
        {(info.agentTitle ?? info.agentName) && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Agent</div>
            <div className="rounded-md bg-muted p-3 text-sm">
              <div className="font-medium">{info.agentTitle ?? info.agentName}</div>
              {info.agentVersion && <div className="mt-0.5 text-xs text-muted-foreground">v{info.agentVersion}</div>}
            </div>
          </div>
        )}

        <Field label="Protocol" value={`${info.protocol.toUpperCase()} ${info.protocolVersion}`} />

        {/* Capabilities */}
        {info.capabilities.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Capabilities</div>
            <div className="flex flex-wrap gap-1.5">
              {info.capabilities.map((cap) => (
                <CapBadge key={cap.name} label={cap.name} enabled={cap.enabled} />
              ))}
            </div>
          </div>
        )}

        {/* Auth Methods */}
        {info.authMethods && info.authMethods.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Authentication Methods</div>
            <div className="space-y-2">
              {info.authMethods.map((method) => (
                <div key={method.id} className="rounded-md bg-muted p-3">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">{method.name}</div>
                    {method.type && (
                      <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {AUTH_TYPE_LABELS[method.type] ?? method.type}
                      </span>
                    )}
                  </div>
                  {method.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{method.description}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
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
  const sessionConfigs = useAgentStore((s) => s.sessionConfigs);
  const agentInfo = useAgentStore((s) => s.agentInfos[agent.id]);
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

  // Sync from store when push events arrive
  useEffect(() => {
    const entry = sessionConfigs[agent.id] as { models?: AgentSessionConfig; modes?: AgentSessionConfig } | undefined;
    if (entry?.models) {
      setModels(entry.models);
    }
    if (entry?.modes) {
      setModes(entry.modes);
    }
  }, [agent.id, sessionConfigs]);

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

        <AgentTypeHint type={config.type} className="mb-3" />

        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1">
            <div className="mb-0.5 text-xs font-medium text-muted-foreground">Type</div>
            <div className="text-sm text-foreground">{agentTypeLabel(config.type)}</div>
          </div>
          {agentInfo && (
            <button
              className="text-muted-foreground hover:text-primary transition-colors"
              title="ACP Agent Info"
              onClick={() => setShowInfo(true)}
            >
              <Info size={14} />
            </button>
          )}
        </div>

        {showInfo && agentInfo && <AgentInfoModal info={agentInfo} onClose={() => setShowInfo(false)} />}

        {config.acp?.cwd && <Field label="Working Directory" value={config.acp.cwd} />}
        {config.newio?.displayName && <Field label="Display Name" value={config.newio.displayName} />}
        <div className="mb-3">
          <div className="mb-0.5 text-xs font-medium text-muted-foreground">Newio Username</div>
          {config.newio?.username ? (
            <div className="text-sm text-foreground">@{config.newio.username}</div>
          ) : (
            <div className="text-sm text-muted-foreground italic">Set during first launch</div>
          )}
        </div>
        {config.newio?.agentId && <Field label="Newio Agent ID" value={config.newio.agentId} />}

        {config.acp && (
          <>
            {/* Model/Mode dropdowns when running */}
            {config.acp.executablePath && <Field label="Executable Path" value={config.acp.executablePath} />}
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
