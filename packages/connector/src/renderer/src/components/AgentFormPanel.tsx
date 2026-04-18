/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useState } from 'react';
import type { AgentType, AgentConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Input, Dropdown, Label, Hint } from './ui';
import { FolderOpen } from 'lucide-react';

function DirectoryPicker({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
}): React.JSX.Element {
  async function handleBrowse(): Promise<void> {
    const dir = await window.api.selectDirectory();
    if (dir) {
      onChange(dir);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" className="px-8" onClick={() => void handleBrowse()}>
        <FolderOpen size={16} />
      </Button>
      <span className="text-sm text-muted-foreground truncate select-text">{value || 'No directory selected'}</span>
    </div>
  );
}

const AGENT_TYPE_OPTIONS: readonly { value: AgentType; label: string }[] = [
  { value: 'claude-code', label: "Claude Code (via Zed's adapter)" },
  { value: 'kiro-cli', label: 'Kiro CLI' },
  { value: 'custom', label: 'Custom ACP Agent' },
];

export function AgentFormPanel({
  editAgent,
  onDone,
}: {
  /** If provided, the form is in edit mode with pre-populated values. */
  readonly editAgent?: AgentConfig;
  /** Called after successful add/save to navigate away. */
  readonly onDone?: () => void;
}): React.JSX.Element {
  const addAgent = useAgentStore((s) => s.addAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);

  const isEdit = !!editAgent;

  const [name, setName] = useState('');
  const [type, setType] = useState<AgentType>('claude-code');
  const [newioUsername, setNewioUsername] = useState('');
  const [cwd, setCwd] = useState('');
  const [agentName, setAgentName] = useState('');
  const [model, setModel] = useState('');
  const [executablePath, setExecutablePath] = useState('');
  const [trustAllTools, setTrustAllTools] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Populate fields when editing
  useEffect(() => {
    if (!editAgent) {
      return;
    }
    setName(editAgent.newio?.displayName ?? '');
    setType(editAgent.type);
    setNewioUsername(editAgent.newio?.username ?? '');
    setCwd(editAgent.acp?.cwd ?? '');
    if (editAgent.acp) {
      setAgentName(editAgent.acp.defaultMode ?? '');
      setModel(editAgent.acp.defaultModel ?? '');
      setExecutablePath(editAgent.acp.executablePath ?? '');
      setTrustAllTools(editAgent.acp.trustAllTools !== false);
    }
  }, [editAgent]);

  const canSubmit =
    name.trim().length > 0 && cwd.trim().length > 0 && (type !== 'custom' || executablePath.trim().length > 0);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const acpConfig = {
        cwd: cwd.trim(),
        trustAllTools,
        ...(agentName.trim() ? { defaultMode: agentName.trim() } : {}),
        ...(model.trim() ? { defaultModel: model.trim() } : {}),
        ...(executablePath.trim() ? { executablePath: executablePath.trim() } : {}),
      };

      if (isEdit) {
        await updateAgent(editAgent.id, {
          displayName: name.trim(),
          newioUsername: newioUsername.trim(),
          acp: acpConfig,
        });
      } else {
        await addAgent({
          displayName: name.trim(),
          type,
          ...(newioUsername.trim() ? { newioUsername: newioUsername.trim() } : {}),
          acp: acpConfig,
        });
      }
      onDone?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">{isEdit ? 'Edit Agent' : 'Add Agent'}</h2>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Type selector */}
        <Label text="Type">
          <Dropdown options={AGENT_TYPE_OPTIONS} value={type} onChange={setType} disabled={isEdit} />
        </Label>

        {/* Type description */}
        <Hint className="mb-4">
          {type === 'claude-code' && (
            <>
              Claude Code is supported via{' '}
              <button
                className="text-primary hover:underline"
                onClick={() =>
                  void window.api.openExternal('https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp')
                }
              >
                @agentclientprotocol/claude-agent-acp
              </button>
              . Install with{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                npm i -g @agentclientprotocol/claude-agent-acp
              </code>{' '}
              and login with Claude subscription{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">claude-agent-acp --cli auth login --claudeai</code>{' '}
              or Anthropic Console (API usage billing){' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">claude-agent-acp --cli auth login --console</code>.
            </>
          )}
          {type === 'kiro-cli' && (
            <>
              Requires{' '}
              <button
                className="text-primary hover:underline"
                onClick={() => void window.api.openExternal('https://kiro.dev/cli/')}
              >
                kiro-cli
              </button>{' '}
              installed and logged in on your system.
            </>
          )}
          {type === 'custom' && (
            <>
              Connect any{' '}
              <button
                className="text-primary hover:underline"
                onClick={() => void window.api.openExternal('https://agentclientprotocol.com/get-started/introduction')}
              >
                ACP-compatible
              </button>{' '}
              agent by providing its CLI executable below. Ensure the agent is authenticated and logged in before
              starting.
            </>
          )}
        </Hint>

        <Label
          text={type === 'custom' ? 'Executable Path' : 'Executable Path (optional)'}
          hint={
            type === 'custom' ? (
              <>
                Command to start the agent in ACP mode.{' '}
                <button
                  className="text-primary hover:underline"
                  onClick={() => void window.api.openExternal('https://agentclientprotocol.com/get-started/agents')}
                >
                  See supported agents
                </button>
                .
              </>
            ) : (
              'Override if the agent CLI is not on your PATH.'
            )
          }
        >
          <Input
            placeholder={type === 'custom' ? 'e.g. /usr/local/bin/my-agent' : 'e.g. /usr/local/bin/agent-cli'}
            value={executablePath}
            onChange={(e) => setExecutablePath(e.target.value)}
          />
        </Label>

        {type === 'kiro-cli' && (
          <label className="flex items-center gap-2.5 mb-4 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={trustAllTools}
              onChange={(e) => setTrustAllTools(e.target.checked)}
              className="custom-check"
            />
            <div>
              <span className="text-sm text-foreground">Trust all tools</span>
              <p className="text-xs text-muted-foreground">Skip permission prompts</p>
            </div>
          </label>
        )}

        {/* Working Directory */}
        <Label text="Working Directory" hint="Working directory for agent sessions.">
          <DirectoryPicker value={cwd} onChange={setCwd} />
        </Label>

        {/* Display Name */}
        <Label text="Display Name">
          <Input placeholder="My Agent" value={name} onChange={(e) => setName(e.target.value)} />
        </Label>

        {/* Newio username */}
        <Label
          text="Newio Username (optional)"
          hint={
            isEdit
              ? 'Changing this will clear the stored Newio identity and tokens.'
              : 'Enter an existing agent username to login. Leave blank to register a new agent.'
          }
        >
          <Input placeholder="myagent" value={newioUsername} onChange={(e) => setNewioUsername(e.target.value)} />
        </Label>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
        {isEdit && (
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
        )}
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
          {submitting ? (isEdit ? 'Saving...' : 'Adding...') : isEdit ? 'Save' : 'Add Agent'}
        </Button>
      </div>
    </div>
  );
}
