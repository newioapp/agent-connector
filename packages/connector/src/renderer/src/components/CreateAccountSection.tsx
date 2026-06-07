/**
 * Inline "create a new Newio account" flow for the Add Agent form. Registers a
 * brand-new account against the connected daemon's backend (the desktop opens the
 * approval URL in the browser), then hands the assigned username back so the
 * caller can prefill the login field.
 */
import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button, Input } from './ui';

type Status =
  | { kind: 'idle' }
  | { kind: 'registering' }
  | { kind: 'awaiting'; url?: string }
  | { kind: 'error'; message: string };

export function CreateAccountSection({
  onCreated,
}: {
  readonly onCreated: (username: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // Surface the approval URL (also opened in the browser) so it stays clickable.
  useEffect(() => {
    return window.api.onAccountApprovalUrl(({ url }) => {
      setStatus((s) => (s.kind === 'registering' || s.kind === 'awaiting' ? { kind: 'awaiting', url } : s));
    });
  }, []);

  const busy = status.kind === 'registering' || status.kind === 'awaiting';

  async function handleCreate(): Promise<void> {
    if (!name.trim() || busy) {
      return;
    }
    setStatus({ kind: 'registering' });
    try {
      const { username } = await window.api.createAccount(name.trim());
      setStatus({ kind: 'idle' });
      setOpen(false);
      setName('');
      onCreated(username);
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!open) {
    return (
      <button
        className="mb-4 flex items-center gap-1.5 text-xs text-primary transition-opacity hover:opacity-80"
        onClick={() => setOpen(true)}
      >
        <UserPlus size={13} />
        Create a new account
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-md border border-border bg-secondary/40 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Register a new agent account. You&apos;ll approve it in your browser and choose its username there.
      </p>
      <div className="flex items-center gap-2">
        <Input
          placeholder="Display name"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
        />
        <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void handleCreate()}>
          {status.kind === 'registering' || status.kind === 'awaiting' ? 'Waiting…' : 'Create'}
        </Button>
      </div>
      {status.kind === 'awaiting' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Waiting for approval in your browser…{' '}
          {status.url && (
            <button
              className="text-primary hover:underline"
              onClick={() => {
                if (status.url) {
                  void window.api.openExternal(status.url);
                }
              }}
            >
              reopen link
            </button>
          )}
        </p>
      )}
      {status.kind === 'error' && <p className="mt-2 text-xs text-destructive">{status.message}</p>}
    </div>
  );
}
