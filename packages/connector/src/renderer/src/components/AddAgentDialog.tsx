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

  // Claude config
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-20250514');

  // Kiro CLI config
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
        ...(type === 'claude' ? { claude: { apiKey: apiKey.trim(), model: model.trim() } } : {}),
        ...(type === 'kiro-cli' ? { kiroCli: { agentName: agentName.trim() } } : {}),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div
        className="w-full max-w-md rounded-lg p-6 shadow-xl"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            Add Agent
          </h2>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Name */}
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Name
          </span>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm outline-none"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            placeholder="My Agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {/* Type selector */}
        <div className="mb-3">
          <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Type
          </span>
          <div className="flex gap-2">
            {(['claude', 'kiro-cli'] as const).map((t) => (
              <button
                key={t}
                className="flex-1 rounded-md border px-3 py-2 text-sm transition-colors"
                style={{
                  background: type === t ? 'var(--accent)' : 'var(--bg)',
                  borderColor: type === t ? 'var(--accent)' : 'var(--border)',
                  color: type === t ? '#fff' : 'var(--text)',
                }}
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
              <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                API Key
              </span>
              <input
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Model
              </span>
              <input
                className="w-full rounded-md border px-3 py-2 text-sm outline-none"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
          </>
        )}

        {type === 'kiro-cli' && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Agent Name
            </span>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              placeholder="my-agent"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <span className="mt-1 block text-xs" style={{ color: 'var(--text-muted)' }}>
              Runs: kiro-cli chat --agent {agentName || '<name>'}
            </span>
          </label>
        )}

        {/* Submit */}
        <button
          className="mt-2 w-full rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          style={{ background: 'var(--accent)', color: '#fff' }}
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Adding...' : 'Add Agent'}
        </button>
      </div>
    </div>
  );
}
