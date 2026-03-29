import { Bot, Plus, Settings } from 'lucide-react';

export function App(): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen">
      {/* Sidebar */}
      <div
        className="flex w-60 flex-col border-r"
        style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border)' }}
      >
        {/* Drag region for macOS title bar */}
        <div className="h-10 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3">
          <h1 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            Agents
          </h1>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:opacity-80"
            style={{ background: 'var(--accent)', color: '#fff' }}
            title="Add agent"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Agent list (empty state) */}
        <div className="flex flex-1 flex-col items-center justify-center px-4" style={{ color: 'var(--text-muted)' }}>
          <Bot size={32} className="mb-2 opacity-40" />
          <p className="text-center text-xs">No agents yet. Click + to connect your first agent.</p>
        </div>

        {/* Footer */}
        <div className="flex items-center border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <button
            className="flex items-center gap-2 text-xs transition-colors hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
          >
            <Settings size={14} />
            Settings
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col" style={{ background: 'var(--bg)' }}>
        {/* Drag region */}
        <div className="h-10 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        {/* Empty state */}
        <div className="flex flex-1 flex-col items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          <Bot size={48} className="mb-3 opacity-30" />
          <p className="text-sm">Select an agent or add a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}
