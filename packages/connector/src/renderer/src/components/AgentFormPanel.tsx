/**
 * Agent form panel — used for both adding and editing agents.
 * Renders in the detail panel area (right side) instead of a modal.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentType, AgentConfig } from '../../../shared/types';
import { useAgentStore } from '../stores/agent-store';

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'kiro-cli': 'Kiro CLI',
};

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
  const [typeOpen, setTypeOpen] = useState(false);
  const typeRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (typeRef.current && !typeRef.current.contains(e.target as Node)) {
        setTypeOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

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
        <div className="mb-4">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Type</span>
          <div className="relative" ref={typeRef}>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              disabled={isEdit}
              onClick={() => setTypeOpen((o) => !o)}
            >
              {AGENT_TYPE_LABELS[type]}
              <ChevronDown
                size={14}
                className={`text-muted-foreground transition-transform ${typeOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {typeOpen && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card py-1 shadow-md">
                {(Object.keys(AGENT_TYPE_LABELS) as AgentType[]).map((t) => (
                  <button
                    key={t}
                    className={`flex w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                      type === t ? 'text-primary font-medium' : 'text-foreground'
                    }`}
                    onClick={() => {
                      setType(t);
                      setTypeOpen(false);
                    }}
                  >
                    {AGENT_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Type description */}
        {type === 'claude-code' && (
          <div className="mb-4 rounded-md bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            Powered by the Claude Agent SDK — the same agent that runs Claude Code CLI. Requires an Anthropic API key
            (pay-per-use). Get one at{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => void window.api.openExternal('https://console.anthropic.com/')}
            >
              console.anthropic.com
            </button>
            .
          </div>
        )}
        {type === 'kiro-cli' && (
          <div className="mb-4 rounded-md bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            Runs a Kiro CLI agent as a child process via{' '}
            <button
              className="text-primary hover:underline"
              onClick={() => void window.api.openExternal('https://agentclientprotocol.com/get-started/introduction')}
            >
              ACP (Agent Client Protocol)
            </button>
            . Requires <span className="font-medium text-foreground">kiro-cli</span> installed and configured on your
            system.
          </div>
        )}

        {/* Name */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Name</span>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            placeholder="My Agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {/* Newio username */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Newio Username (optional)</span>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            placeholder="myagent"
            value={newioUsername}
            onChange={(e) => setNewioUsername(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {isEdit
              ? 'Changing this will clear the stored Newio identity and tokens.'
              : 'Enter an existing agent username to login. Leave blank to register a new agent.'}
          </span>
        </label>

        {/* Claude config */}
        {type === 'claude-code' && (
          <>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">API Key</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                type="text"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Model</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Custom Instructions (optional)
              </span>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                rows={3}
                placeholder="Additional instructions for the agent..."
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Node.js Path (optional)</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. /usr/local/bin/node"
                value={nodePath}
                onChange={(e) => setNodePath(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Defaults to the Electron runtime. Override if Claude Code needs a specific Node.js.
              </span>
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Claude Code CLI Path (optional)
              </span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. /path/to/cli.js"
                value={claudeCodeCliPath}
                onChange={(e) => setClaudeCodeCliPath(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Defaults to the CLI bundled with @anthropic-ai/claude-agent-sdk.
              </span>
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Working Directory (optional)</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. /Users/me/projects"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Working directory for Claude Code sessions. Defaults to the app's process directory.
              </span>
            </label>
          </>
        )}

        {/* Kiro CLI config */}
        {type === 'kiro-cli' && (
          <>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Kiro Agent Name</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="my-agent"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Runs: kiro-cli acp --agent {agentName || '<name>'}
              </span>
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Model (optional)</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="auto"
                value={kiroModel}
                onChange={(e) => setKiroModel(e.target.value)}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Kiro CLI Path (optional)</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. /Users/me/.local/bin/kiro-cli"
                value={kiroCliPath}
                onChange={(e) => setKiroCliPath(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Override if kiro-cli is not on your PATH.
              </span>
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Working Directory (optional)</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                placeholder="e.g. /Users/me/projects"
                value={kiroCwd}
                onChange={(e) => setKiroCwd(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Working directory for the Kiro CLI agent. Defaults to the app's process directory.
              </span>
            </label>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
        {isEdit && (
          <button
            className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            onClick={onDone}
          >
            Cancel
          </button>
        )}
        <button
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? (isEdit ? 'Saving...' : 'Adding...') : isEdit ? 'Save' : 'Add Agent'}
        </button>
      </div>
    </div>
  );
}
