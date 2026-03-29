/**
 * Add Agent dialog — lets the user create a new agent configuration.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import type { AgentType } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';

export function AddAgentDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const addAgent = useAgentStore((s) => s.addAgent);
  const [name, setName] = useState('');
  const [type, setType] = useState<AgentType>('claude');
  const [newioUsername, setNewioUsername] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [agentName, setAgentName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    name.trim().length > 0 && (type === 'claude' ? apiKey.trim().length > 0 : agentName.trim().length > 0);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await addAgent({
        name: name.trim(),
        type,
        ...(newioUsername.trim() ? { newioUsername: newioUsername.trim() } : {}),
        ...(type === 'claude' ? { claude: { apiKey: apiKey.trim(), model: model.trim() } } : {}),
        ...(type === 'kiro-cli' ? { kiroCli: { agentName: agentName.trim() } } : {}),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-card-foreground">Add Agent</h2>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Name */}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            placeholder="My Agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {/* Newio username (optional — login to existing agent instead of registering) */}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Newio Username (optional)</span>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            placeholder="my-agent"
            value={newioUsername}
            onChange={(e) => setNewioUsername(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Enter an existing agent username to login. Leave blank to register a new agent.
          </span>
        </label>

        {/* Type selector */}
        <div className="mb-3">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Type</span>
          <div className="flex gap-2">
            {(['claude', 'kiro-cli'] as const).map((t) => (
              <button
                key={t}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  type === t
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-foreground hover:bg-accent'
                }`}
                onClick={() => setType(t)}
              >
                {t === 'claude' ? 'Claude' : 'Kiro CLI'}
              </button>
            ))}
          </div>
        </div>

        {/* Type-specific config */}
        {type === 'claude' && (
          <>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">API Key</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Model</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
          </>
        )}

        {type === 'kiro-cli' && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Agent Name</span>
            <input
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
              placeholder="my-agent"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Runs: kiro-cli chat --agent {agentName || '<name>'}
            </span>
          </label>
        )}

        {/* Submit */}
        <button
          className="mt-2 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Adding...' : 'Add Agent'}
        </button>
      </div>
    </div>
  );
}
