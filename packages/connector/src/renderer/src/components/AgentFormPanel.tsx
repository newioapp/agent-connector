/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useState } from 'react';
import type { AgentType, AgentConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Input, Textarea, Dropdown, Label, Hint } from './ui';

const AGENT_TYPE_OPTIONS: readonly { value: AgentType; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'kiro-cli', label: 'Kiro CLI' },
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
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [userPrompt, setUserPrompt] = useState('');
  const [nodePath, setNodePath] = useState('');
  const [claudeCodeCliPath, setClaudeCodeCliPath] = useState('');
  const [cwd, setCwd] = useState('');
  const [agentName, setAgentName] = useState('');
  const [kiroModel, setKiroModel] = useState('');
  const [kiroCliPath, setKiroCliPath] = useState('');
  const [kiroCwd, setKiroCwd] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Populate fields when editing
  useEffect(() => {
    if (!editAgent) {
      return;
    }
    setName(editAgent.name);
    setType(editAgent.type);
    setNewioUsername(editAgent.newioUsername ?? '');
    if (editAgent.claude) {
      setApiKey(editAgent.claude.apiKey);
      setModel(editAgent.claude.model);
      setUserPrompt(editAgent.claude.userPrompt ?? '');
      setNodePath(editAgent.claude.nodePath ?? '');
      setClaudeCodeCliPath(editAgent.claude.claudeCodeCliPath ?? '');
      setCwd(editAgent.claude.cwd ?? '');
    }
    if (editAgent.kiroCli) {
      setAgentName(editAgent.kiroCli.agentName ?? '');
      setKiroModel(editAgent.kiroCli.model ?? '');
      setKiroCliPath(editAgent.kiroCli.kiroCliPath ?? '');
      setKiroCwd(editAgent.kiroCli.cwd ?? '');
    }
  }, [editAgent]);

  const canSubmit = name.trim().length > 0 && (type === 'claude-code' ? apiKey.trim().length > 0 : true);

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const claudeConfig =
        type === 'claude-code'
          ? {
              apiKey: apiKey.trim(),
              model: model.trim(),
              ...(userPrompt.trim() ? { userPrompt: userPrompt.trim() } : {}),
              ...(nodePath.trim() ? { nodePath: nodePath.trim() } : {}),
              ...(claudeCodeCliPath.trim() ? { claudeCodeCliPath: claudeCodeCliPath.trim() } : {}),
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
            }
          : undefined;
      const kiroCliConfig =
        type === 'kiro-cli'
          ? {
              ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
              ...(kiroModel.trim() ? { model: kiroModel.trim() } : {}),
              ...(kiroCliPath.trim() ? { kiroCliPath: kiroCliPath.trim() } : {}),
              ...(kiroCwd.trim() ? { cwd: kiroCwd.trim() } : {}),
            }
          : undefined;

      if (isEdit) {
        await updateAgent(editAgent.id, {
          name: name.trim(),
          newioUsername: newioUsername.trim(),
          ...(claudeConfig ? { claude: claudeConfig } : {}),
          ...(kiroCliConfig ? { kiroCli: kiroCliConfig } : {}),
        });
      } else {
        await addAgent({
          name: name.trim(),
          type,
          ...(newioUsername.trim() ? { newioUsername: newioUsername.trim() } : {}),
          ...(claudeConfig ? { claude: claudeConfig } : {}),
          ...(kiroCliConfig ? { kiroCli: kiroCliConfig } : {}),
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
        {type === 'claude-code' && (
          <Hint className="mb-4">
            Powered by the Claude Agent SDK — the same agent that runs Claude Code CLI. Requires an Anthropic API key
            (pay-per-use). Get one at{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => void window.api.openExternal('https://console.anthropic.com/')}
            >
              console.anthropic.com
            </button>
            .
          </Hint>
        )}
        {type === 'kiro-cli' && (
          <Hint className="mb-4">
            Runs a Kiro CLI agent as a child process via{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => void window.api.openExternal('https://agentclientprotocol.com/get-started/introduction')}
            >
              ACP (Agent Client Protocol)
            </button>
            . Requires <span className="font-medium text-foreground">kiro-cli</span> installed and configured on your
            system.
          </Hint>
        )}

        {/* Name */}
        <Label text="Name">
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

        {/* Claude config */}
        {type === 'claude-code' && (
          <>
            <Label text="API Key">
              <Input type="text" placeholder="sk-ant-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Label>
            <Label text="Model">
              <Input value={model} onChange={(e) => setModel(e.target.value)} />
            </Label>
            <Label text="Custom Instructions (optional)">
              <Textarea
                rows={3}
                placeholder="Additional instructions for the agent..."
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
              />
            </Label>
            <Label
              text="Node.js Path (optional)"
              hint="Defaults to the Electron runtime. Override if Claude Code needs a specific Node.js."
            >
              <Input
                placeholder="e.g. /usr/local/bin/node"
                value={nodePath}
                onChange={(e) => setNodePath(e.target.value)}
              />
            </Label>
            <Label
              text="Claude Code CLI Path (optional)"
              hint="Defaults to the CLI bundled with @anthropic-ai/claude-agent-sdk."
            >
              <Input
                placeholder="e.g. /path/to/cli.js"
                value={claudeCodeCliPath}
                onChange={(e) => setClaudeCodeCliPath(e.target.value)}
              />
            </Label>
            <Label
              text="Working Directory (optional)"
              hint="Working directory for Claude Code sessions. Defaults to the app's process directory."
            >
              <Input placeholder="e.g. /Users/me/projects" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </Label>
          </>
        )}

        {/* Kiro CLI config */}
        {type === 'kiro-cli' && (
          <>
            <Label text="Kiro Agent Name" hint={`Runs: kiro-cli acp --agent ${agentName || '<name>'}`}>
              <Input placeholder="my-agent" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
            </Label>
            <Label text="Model (optional)">
              <Input placeholder="auto" value={kiroModel} onChange={(e) => setKiroModel(e.target.value)} />
            </Label>
            <Label text="Kiro CLI Path (optional)" hint="Override if kiro-cli is not on your PATH.">
              <Input
                placeholder="e.g. /Users/me/.local/bin/kiro-cli"
                value={kiroCliPath}
                onChange={(e) => setKiroCliPath(e.target.value)}
              />
            </Label>
            <Label
              text="Working Directory (optional)"
              hint="Working directory for the Kiro CLI agent. Defaults to the app's process directory."
            >
              <Input
                placeholder="e.g. /Users/me/projects"
                value={kiroCwd}
                onChange={(e) => setKiroCwd(e.target.value)}
              />
            </Label>
          </>
        )}
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
