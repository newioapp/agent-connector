/**
 * Agent type hint — displays setup instructions for each agent type.
 * Shared between AgentFormPanel and ConfigTab.
 */
import type { AgentType } from '../../../shared/types';
import { Hint } from './ui';

export function AgentTypeHint({
  type,
  className,
}: {
  readonly type: AgentType;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <Hint className={className}>
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
          <code className="text-xs bg-muted px-1 py-0.5 rounded">npm i -g @agentclientprotocol/claude-agent-acp</code>{' '}
          and login with Claude subscription{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">claude-agent-acp --cli auth login --claudeai</code> or
          Anthropic Console (API usage billing){' '}
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
            Kiro CLI
          </button>{' '}
          installed and authenticated.
        </>
      )}
      {type === 'codex' && (
        <>
          Requires{' '}
          <button
            className="text-primary hover:underline"
            onClick={() => void window.api.openExternal('https://www.npmjs.com/package/@zed-industries/codex-acp')}
          >
            @zed-industries/codex-acp
          </button>
          . Install with{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">npm i -g @zed-industries/codex-acp</code> and
          authenticate with a ChatGPT subscription,{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">CODEX_API_KEY</code>, or{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">OPENAI_API_KEY</code>.
        </>
      )}
      {type === 'cursor' && (
        <>
          Requires{' '}
          <button
            className="text-primary hover:underline"
            onClick={() => void window.api.openExternal('https://cursor.com/cli')}
          >
            Cursor CLI
          </button>{' '}
          installed and authenticated.
        </>
      )}
      {type === 'gemini' && (
        <>
          Requires{' '}
          <button
            className="text-primary hover:underline"
            onClick={() => void window.api.openExternal('https://www.npmjs.com/package/@google/gemini-cli')}
          >
            Gemini CLI
          </button>{' '}
          installed and authenticated.
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
          agent by providing its CLI executable below. Ensure the agent is authenticated and logged in before starting.
        </>
      )}
    </Hint>
  );
}
