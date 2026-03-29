/**
 * Sidebar agent list item.
 */
import { Bot, Terminal } from 'lucide-react';
import type { AgentStatusInfo, AgentRuntimeStatus } from '../../../shared/types';

const STATUS_COLORS: Record<AgentRuntimeStatus, string> = {
  stopped: 'bg-muted-foreground',
  starting: 'bg-warning',
  awaiting_approval: 'bg-warning',
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
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        selected ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent'
      }`}
      onClick={onClick}
    >
      <AgentTypeIcon type={agent.config.type} size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{agent.config.name}</div>
        <div className={`truncate text-xs ${selected ? 'opacity-70' : 'text-muted-foreground'}`}>
          {agent.config.type === 'kiro-cli' ? 'Kiro CLI' : 'Claude'}
        </div>
      </div>
      <div
        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[agent.runtimeStatus]}`}
        title={agent.runtimeStatus}
      />
    </button>
  );
}
