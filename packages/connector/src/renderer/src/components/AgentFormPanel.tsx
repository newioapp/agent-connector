/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useState } from 'react';
import type { AgentType, AgentConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Input, Dropdown, Label, Textarea } from './ui';
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
  const [newioUsername, setNewioUsername] = useState('');
  const [cwd, setCwd] = useState('');
  const [command, setCommand] = useState('');
  // One argument per line — kept path-safe (each line is passed verbatim), mirroring
  // the CLI's repeatable --arg.
  const [argsText, setArgsText] = useState('');
  const [trustAllTools, setTrustAllTools] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Populate fields when editing
  useEffect(() => {
    if (!editAgent) {
      return;
    }
    setType(editAgent.type);
    setNewioUsername(editAgent.newio?.username ?? '');
    setCwd(editAgent.acp?.cwd ?? '');
    if (editAgent.acp) {
      // Prefer the structured command/args. Migrate a legacy executablePath off the
      // deprecated field by whitespace-splitting it (first token = command, rest = args).
      if (editAgent.acp.command !== undefined) {
        setCommand(editAgent.acp.command);
        setArgsText((editAgent.acp.args ?? []).join('\n'));
      } else if (editAgent.acp.executablePath) {
        const parts = editAgent.acp.executablePath.trim().split(/\s+/).filter(Boolean);
        setCommand(parts[0] ?? '');
        setArgsText(parts.slice(1).join('\n'));
      }
      setTrustAllTools(editAgent.acp.kiroCliTrustAllTools !== false);
    }
  }, [editAgent]);

  // A custom agent needs a launch command; built-in types may override their default binary.
  const hasLaunch = command.trim().length > 0;
  const canSubmit = newioUsername.trim().length > 0 && cwd.trim().length > 0 && (type !== 'custom' || hasLaunch);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const trimmedCommand = command.trim();
      const args = argsText
        .split('\n')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const acpConfig = {
        cwd: cwd.trim(),
        ...(type === 'kiro-cli' ? { kiroCliTrustAllTools: trustAllTools } : {}),
        // Path-safe launch override: a command plus its verbatim args. Omitted for a
        // built-in type with no override, so the engine uses the type's default binary.
        ...(trimmedCommand ? { command: trimmedCommand, args } : {}),
      };

      if (isEdit) {
        await updateAgent(editAgent.id, {
          newioUsername: newioUsername.trim(),
          acp: acpConfig,
        });
      } else {
        await addAgent({
          type,
          newioUsername: newioUsername.trim(),
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

        {/* Launch command */}
        <Label
          text={type === 'custom' ? 'Command' : 'Command (optional)'}
          hint={
            type === 'custom' ? (
              <>
                Executable to start the agent in ACP mode.{' '}
                <button
                  className="text-primary hover:underline"
                  onClick={() => void window.api.openExternal('https://agentclientprotocol.com/get-started/agents')}
                >
                  See supported agents
                </button>
                .
              </>
            ) : (
              'Override the default binary if the agent CLI is not on your PATH.'
            )
          }
        >
          <Input
            placeholder={type === 'custom' ? 'e.g. /usr/local/bin/my-agent' : 'e.g. /usr/local/bin/agent-cli'}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </Label>

        {/* Launch arguments */}
        <Label text="Arguments (optional)" hint="Passed to the command. One argument per line.">
          <Textarea
            rows={3}
            placeholder={'e.g.\n--model\nclaude-sonnet-4'}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
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
