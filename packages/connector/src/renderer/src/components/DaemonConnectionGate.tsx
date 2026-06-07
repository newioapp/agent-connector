/**
 * Full-window overlay shown while the desktop isn't connected to the daemon —
 * the daemon isn't running, the connection dropped, or the RPC protocol versions
 * don't match. Offers a retry.
 */
import { Loader2, PlugZap, RefreshCw } from 'lucide-react';
import type { DaemonConnectionStatus } from '../../../shared/ipc-events';

export function DaemonConnectionGate({
  status,
  onRetry,
}: {
  readonly status: DaemonConnectionStatus;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center text-foreground">
      {status.kind === 'connecting' ? (
        <>
          <Loader2 size={40} className="animate-spin opacity-50" />
          <p className="text-sm text-muted-foreground">Connecting to the Newio daemon…</p>
        </>
      ) : status.kind === 'protocol-mismatch' ? (
        <>
          <PlugZap size={40} className="opacity-50" />
          <div className="max-w-sm space-y-1">
            <h2 className="text-base font-semibold">Daemon version mismatch</h2>
            <p className="text-sm text-muted-foreground">
              The daemon speaks protocol v{status.daemonProtocol} but this app expects v{status.clientProtocol}. Update
              whichever is older (the desktop app, or <code>npm i -g @newio/cli</code>) so they match.
            </p>
          </div>
          <RetryButton onRetry={onRetry} />
        </>
      ) : (
        <>
          <PlugZap size={40} className="opacity-50" />
          <div className="max-w-sm space-y-1">
            <h2 className="text-base font-semibold">Daemon not running</h2>
            <p className="text-sm text-muted-foreground">
              Start it with <code>newio daemon start</code>, then retry.
            </p>
          </div>
          <RetryButton onRetry={onRetry} />
        </>
      )}
    </div>
  );
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }): React.JSX.Element {
  return (
    <button
      className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-80"
      onClick={onRetry}
    >
      <RefreshCw size={14} />
      Retry
    </button>
  );
}
