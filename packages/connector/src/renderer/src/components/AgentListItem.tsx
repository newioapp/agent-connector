/**
 * Sidebar agent list item.
 */
import { Bot, Terminal } from 'lucide-react';
import type { AgentStatusInfo, AgentRuntimeStatus } from '../../../shared/types';
import { agentTypeLabel } from '../lib/agent-type-label';

const STATUS_COLORS: Record<AgentRuntimeStatus, string> = {
  stopped: 'bg-muted-foreground',
  stopping: 'bg-warning',
  starting: 'bg-warning',
  awaiting_approval: 'bg-warning',
  initializing: 'bg-warning',
  greeting: 'bg-warning',
  running: 'bg-success',
  error: 'bg-destructive',
};

function AgentTypeIcon({ type, size }: { readonly type: string; readonly size: number }): React.JSX.Element {
  if (type === 'kiro-cli') {
    return <Terminal size={size} />;
  }
  return <Bot size={size} />;
}

export function AgentListItem({
  agent,
  selected,
  onClick,
}: {
  readonly agent: AgentStatusInfo;
  readonly selected: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        selected ? 'bg-sidebar-active text-sidebar-active-foreground' : 'text-sidebar-foreground hover:bg-white/10'
      }`}
      onClick={onClick}
    >
      {agent.config.newio?.avatarUrl ? (
        <img src={agent.config.newio.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover shrink-0" />
      ) : (
        <AgentTypeIcon type={agent.config.type} size={18} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {agent.config.newio?.displayName ?? agentTypeLabel(agent.config.type)}
        </div>
        <div className={`truncate text-xs ${selected ? 'opacity-80' : 'opacity-60'}`}>
          {agentTypeLabel(agent.config.type)}
        </div>
      </div>
      <div
        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[agent.runtimeStatus]}`}
        title={agent.runtimeStatus}
      />
    </button>
  );
}
