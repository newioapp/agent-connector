/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useState } from 'react';
import type { AgentType, AgentConfig, SessionMode } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Input, Dropdown, Label } from './ui';
import { AgentTypeHint } from './AgentTypeHint';
import { CreateAccountSection } from './CreateAccountSection';
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
  { value: 'codex', label: "Codex (via Zed's adapter)" },
  { value: 'cursor', label: 'Cursor' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'kiro-cli', label: 'Kiro CLI' },
  { value: 'custom', label: 'Custom ACP Agent' },
];

const SESSION_MODE_OPTIONS: readonly { value: SessionMode; label: string; description: string }[] = [
  {
    value: 'isolated',
    label: 'Isolated',
    description: 'One session per conversation. Best for agents with specific tasks, e.g. individual contributor role.',
  },
  {
    value: 'shared',
    label: 'Shared',
    description:
      'Single session across all conversations. Best for agents that carry context between conversations, e.g. manager role.',
  },
  {
    value: 'chat-shared',
    label: 'Chat-shared',
    description:
      'DMs, group chats, and contact events share one session; each work session and cron job gets its own. Balances continuous chat context with focused task execution.',
  },
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

  const [type, setType] = useState<AgentType>('claude-code');
  const [sessionMode, setSessionMode] = useState<SessionMode>('isolated');
  const [newioUsername, setNewioUsername] = useState('');
  const [cwd, setCwd] = useState('');
  const [executablePath, setExecutablePath] = useState('');
  const [trustAllTools, setTrustAllTools] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Populate fields when editing
  useEffect(() => {
    if (!editAgent) {
      return;
    }
    setType(editAgent.type);
    setSessionMode(editAgent.sessionMode ?? 'isolated');
    setNewioUsername(editAgent.newio?.username ?? '');
    setCwd(editAgent.acp?.cwd ?? '');
    if (editAgent.acp) {
      setExecutablePath(editAgent.acp.executablePath ?? '');
      setTrustAllTools(editAgent.acp.kiroCliTrustAllTools !== false);
    }
  }, [editAgent]);

  // A custom agent needs a launch override: the executablePath field, OR a
  // structured command set via the CLI that this form preserves but doesn't edit.
  const hasLaunch = executablePath.trim().length > 0 || editAgent?.acp?.command !== undefined;
  const canSubmit = newioUsername.trim().length > 0 && cwd.trim().length > 0 && (type !== 'custom' || hasLaunch);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const execTrimmed = executablePath.trim();
      const acpConfig = {
        cwd: cwd.trim(),
        ...(type === 'kiro-cli' ? { kiroCliTrustAllTools: trustAllTools } : {}),
        // An entered executable path is a legacy override. Otherwise preserve a
        // structured command/args set via the CLI — this form doesn't edit them,
        // and acp is replaced wholesale, so they'd be lost without this.
        ...(execTrimmed
          ? { executablePath: execTrimmed }
          : {
              ...(editAgent?.acp?.command !== undefined ? { command: editAgent.acp.command } : {}),
              ...(editAgent?.acp?.args !== undefined ? { args: editAgent.acp.args } : {}),
            }),
      };

      if (isEdit) {
        await updateAgent(editAgent.id, {
          newioUsername: newioUsername.trim(),
          sessionMode,
          acp: acpConfig,
        });
      } else {
        await addAgent({
          type,
          newioUsername: newioUsername.trim(),
          sessionMode,
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
        <AgentTypeHint type={type} className="mb-4" />

        {/* Session mode */}
        <Label text="Session Mode">
          <Dropdown<SessionMode> options={SESSION_MODE_OPTIONS} value={sessionMode} onChange={setSessionMode} />
        </Label>

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

        {/* Create a new account (add mode only) */}
        {!isEdit && <CreateAccountSection onCreated={setNewioUsername} />}

        {/* Newio username */}
        <Label
          text="Newio Username"
          hint={
            isEdit
              ? 'Changing this will clear the stored Newio identity and tokens.'
              : 'The existing agent account to log in as. Display name is synced from the account.'
          }
        >
          <Input placeholder="my_agent" value={newioUsername} onChange={(e) => setNewioUsername(e.target.value)} />
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
