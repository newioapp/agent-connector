/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useState } from 'react';
import type { AgentType, AgentConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';
import { Button, Input, Textarea, Dropdown, Label, Hint } from './ui';
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
    <div className="flex gap-2">
      <Input className="flex-1" value={value} readOnly placeholder="No directory selected" />
      <Button variant="outline" onClick={() => void handleBrowse()}>
        <FolderOpen size={16} />
      </Button>
    </div>
  );
}

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
  const [kiroAgents, setKiroAgents] = useState<string[]>([]);
  const [kiroModels, setKiroModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Fetch available Kiro CLI agents and models when type is kiro-cli
  useEffect(() => {
    if (type !== 'kiro-cli') {
      return;
    }
    const path = kiroCliPath.trim() || undefined;
    const dir = cwd.trim() || undefined;
    void window.api.listKiroAgents(path, dir).then((agents) => {
      setKiroAgents(agents);
      if (agents.length > 0 && !agentName) {
        setAgentName(agents[0]);
      }
    });
    void window.api.listKiroModels(path, dir).then((models) => {
      setKiroModels(models);
      if (models.length > 0 && !kiroModel) {
        setKiroModel(models[0]);
      }
    });
  }, [type, kiroCliPath, cwd]);

  // Populate fields when editing
  useEffect(() => {
    if (!editAgent) {
      return;
    }
    setName(editAgent.newio?.displayName ?? '');
    setType(editAgent.type);
    setNewioUsername(editAgent.newio?.username ?? '');
    if (editAgent.claude) {
      setApiKey(editAgent.claude.apiKey);
      setModel(editAgent.claude.model);
      setUserPrompt(editAgent.claude.userPrompt ?? '');
      setNodePath(editAgent.claude.nodePath ?? '');
      setClaudeCodeCliPath(editAgent.claude.claudeCodeCliPath ?? '');
    }
    setCwd(editAgent.claude?.cwd ?? editAgent.kiroCli?.cwd ?? '');
    if (editAgent.kiroCli) {
      setAgentName(editAgent.kiroCli.agentName ?? '');
      setKiroModel(editAgent.kiroCli.model ?? '');
      setKiroCliPath(editAgent.kiroCli.kiroCliPath ?? '');
    }
  }, [editAgent]);

  const canSubmit =
    name.trim().length > 0 && cwd.trim().length > 0 && (type === 'claude-code' ? apiKey.trim().length > 0 : true);

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
              cwd: cwd.trim(),
              ...(userPrompt.trim() ? { userPrompt: userPrompt.trim() } : {}),
              ...(nodePath.trim() ? { nodePath: nodePath.trim() } : {}),
              ...(claudeCodeCliPath.trim() ? { claudeCodeCliPath: claudeCodeCliPath.trim() } : {}),
            }
          : undefined;
      const kiroCliConfig =
        type === 'kiro-cli'
          ? {
              cwd: cwd.trim(),
              ...(agentName.trim() ? { agentName: agentName.trim() } : {}),
              ...(kiroModel.trim() ? { model: kiroModel.trim() } : {}),
              ...(kiroCliPath.trim() ? { kiroCliPath: kiroCliPath.trim() } : {}),
            }
          : undefined;

      if (isEdit) {
        await updateAgent(editAgent.id, {
          displayName: name.trim(),
          newioUsername: newioUsername.trim(),
          ...(claudeConfig ? { claude: claudeConfig } : {}),
          ...(kiroCliConfig ? { kiroCli: kiroCliConfig } : {}),
        });
      } else {
        await addAgent({
          displayName: name.trim(),
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

        {/* Working Directory */}
        <Label text="Working Directory" hint="Working directory for agent sessions.">
          <DirectoryPicker value={cwd} onChange={setCwd} />
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
          </>
        )}

        {/* Kiro CLI config */}
        {type === 'kiro-cli' && (
          <>
            <Label
              text="Kiro Agent Name (optional)"
              hint={`Runs: kiro-cli acp --agent ${agentName || '<name>'}${kiroModel ? ` --model ${kiroModel}` : ''}`}
            >
              {kiroAgents.length > 0 ? (
                <Dropdown
                  options={kiroAgents.map((a) => ({ value: a, label: a }))}
                  value={agentName}
                  onChange={setAgentName}
                />
              ) : (
                <Input placeholder="my-agent" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
              )}
            </Label>
            <Label text="Model (optional)">
              {kiroModels.length > 0 ? (
                <Dropdown
                  options={kiroModels.map((m) => ({ value: m, label: m }))}
                  value={kiroModel}
                  onChange={setKiroModel}
                />
              ) : (
                <Input placeholder="auto" value={kiroModel} onChange={(e) => setKiroModel(e.target.value)} />
              )}
            </Label>
            <Label text="Kiro CLI Path (optional)" hint="Override if kiro-cli is not on your PATH.">
              <Input
                placeholder="e.g. /Users/me/.local/bin/kiro-cli"
                value={kiroCliPath}
                onChange={(e) => setKiroCliPath(e.target.value)}
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
