/**
 * Sidebar agent list item.
 */
import { Bot, Terminal } from 'lucide-react';
import type { AgentStatusInfo } from '../../../shared/types';

const STATUS_COLORS: Record<string, string> = {
  stopped: 'var(--text-muted)',
  starting: 'var(--warning)',
  awaiting_approval: 'var(--warning)',
  running: 'var(--success)',
  error: 'var(--danger)',
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
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors"
      style={{
        background: selected ? 'var(--accent)' : 'transparent',
        color: selected ? '#fff' : 'var(--text)',
      }}
      onClick={onClick}
    >
      <AgentTypeIcon type={agent.config.type} size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{agent.config.name}</div>
        <div className="truncate text-xs" style={{ color: selected ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
          {agent.config.type === 'kiro-cli' ? 'Kiro CLI' : 'Claude'}
        </div>
      </div>
      <div
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: STATUS_COLORS[agent.runtimeStatus] ?? 'var(--text-muted)' }}
        title={agent.runtimeStatus}
      />
    </button>
  );
}
