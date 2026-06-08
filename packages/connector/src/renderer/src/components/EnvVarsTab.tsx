/**
 * Environment variables tab — manage env vars passed to agent processes.
 *
 * Syncs from this app's own environment (basic essentials, or all) and supports
 * manual editing. Auto-saves with debounce on every change. Empty entries are
 * pruned on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, RefreshCw, Loader2, ChevronDown } from 'lucide-react';
import type { AgentStatusInfo, EnvSyncMode } from '../../../shared/types';
import { ENV_SYNC_MODES } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Hint } from './ui';

interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

const MODE_LABELS: Record<EnvSyncMode, string> = {
  basic: 'basic — essentials only',
  all: 'all — entire environment',
};

function entriesToRecord(entries: readonly EnvEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of entries) {
    const trimmed = key.trim();
    if (trimmed) {
      result[trimmed] = value;
    }
  }
  return result;
}

function hasContent(entry: EnvEntry): boolean {
  return entry.key.trim().length > 0 || entry.value.trim().length > 0;
}

export function EnvVarsTab({ agent }: { readonly agent: AgentStatusInfo }): React.JSX.Element {
  const updateConfig = useAgentStore((s) => s.updateConfig);
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [mode, setMode] = useState<EnvSyncMode>('basic');
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const disabled = agent.runtimeStatus !== 'stopped' && agent.runtimeStatus !== 'error';
  const agentIdRef = useRef(agent.id);
  const initialLoadRef = useRef(true);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;

  // Load from config on agent change only (not on config updates from our own saves)
  useEffect(() => {
    agentIdRef.current = agent.id;
    initialLoadRef.current = true;
    const envVars = agent.config.envVars;
    setEntries(Object.entries(envVars).map(([key, value]) => ({ key, value })));
  }, [agent.id]);

  // Prune empty entries and save on unmount
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      const pruned = entriesRef.current.filter(hasContent);
      const envVars = entriesToRecord(pruned);
      void window.api.updateAgentEnvVars(agentIdRef.current, envVars).then((updated) => {
        updateConfigRef.current(agentIdRef.current, updated);
      });
    };
  }, []);

  // Debounced auto-save
  useEffect(() => {
    clearTimeout(debounceRef.current);

    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }

    debounceRef.current = setTimeout(() => {
      const envVars = entriesToRecord(entries);
      void window.api.updateAgentEnvVars(agentIdRef.current, envVars).then((updated) => {
        updateConfigRef.current(agentIdRef.current, updated);
      });
    }, 800);

    return () => clearTimeout(debounceRef.current);
  }, [entries]);

  const handleSync = useCallback(async (syncMode: EnvSyncMode) => {
    setImporting(true);
    try {
      const captured = await window.api.captureEnv(syncMode);
      // Overlay captured vars onto existing ones (preserves manually-added keys).
      const merged = new Map(entriesRef.current.filter(hasContent).map((e) => [e.key.trim(), e.value]));
      for (const [key, value] of Object.entries(captured)) {
        merged.set(key, value);
      }
      const next = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }));
      setEntries(next);
      // Persist immediately so a "Start agent" right after Sync uses the new env —
      // don't leave it to the debounced autosave (which would leave a stale window).
      const updated = await window.api.updateAgentEnvVars(agentIdRef.current, entriesToRecord(next));
      updateConfigRef.current(agentIdRef.current, updated);
    } finally {
      setImporting(false);
    }
  }, []);

  const handleAdd = useCallback(() => {
    setEntries((prev) => [...prev, { key: '', value: '' }]);
  }, []);

  const handleRemove = useCallback((index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleChange = useCallback((index: number, field: 'key' | 'value', val: string) => {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: val } : e)));
  }, []);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-6 py-3">
        {/* Sync button + mode selector */}
        <div className="relative flex items-stretch">
          <button
            className="flex items-center gap-1.5 rounded-l-md border border-input px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
            disabled={disabled || importing}
            onClick={() => void handleSync(mode)}
          >
            {importing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Sync ({mode})
          </button>
          <button
            className="flex items-center rounded-r-md border border-l-0 border-input px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
            disabled={disabled || importing}
            onClick={() => setModeDropdownOpen((o) => !o)}
          >
            <ChevronDown size={12} className={modeDropdownOpen ? 'rotate-180' : ''} />
          </button>
          {modeDropdownOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 min-w-[200px] rounded-md border border-border bg-card py-1 shadow-md">
              {ENV_SYNC_MODES.map((m) => (
                <button
                  key={m}
                  className={`flex w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                    m === mode ? 'text-primary font-medium' : 'text-foreground'
                  }`}
                  onClick={() => {
                    setMode(m);
                    setModeDropdownOpen(false);
                  }}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />
      </div>

      {/* Hint */}
      <Hint className="mx-6 mt-1 mb-2">
        Agent processes need environment variables to find executables (PATH) and reach the system keychain (USER). Sync
        captures them from this app&apos;s environment — &quot;basic&quot; takes just the essentials, &quot;all&quot;
        takes everything. You can override or add variables manually. All environment variables are stored locally on
        this device only — they are never sent to the cloud.
      </Hint>

      {/* Table */}
      <div className="flex-1 overflow-y-auto px-6 py-3">
        {entries.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No environment variables configured.
            <br />
            Click &quot;Sync&quot; to populate from this app&apos;s environment, or &quot;Add Variable&quot; to create
            manually.
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* Header */}
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground px-1">
              <div className="w-[200px] shrink-0">Variable</div>
              <div className="flex-1">Value</div>
              <div className="w-8" />
            </div>
            {entries.map((entry, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="w-[200px] shrink-0 rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  placeholder="KEY"
                  value={entry.key}
                  disabled={disabled}
                  onChange={(e) => handleChange(i, 'key', e.target.value)}
                />
                <input
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  placeholder="value"
                  value={entry.value}
                  disabled={disabled}
                  onChange={(e) => handleChange(i, 'value', e.target.value)}
                />
                <button
                  className="flex h-7 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-40"
                  disabled={disabled}
                  onClick={() => handleRemove(i)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add button at bottom */}
        <div className="mt-2">
          <Button variant="outline" disabled={disabled} onClick={handleAdd}>
            <Plus size={12} />
            Add Variable
          </Button>
        </div>
      </div>

      {disabled && (
        <div className="px-6 py-3 text-xs text-muted-foreground">Stop the agent to edit environment variables.</div>
      )}
    </div>
  );
}
