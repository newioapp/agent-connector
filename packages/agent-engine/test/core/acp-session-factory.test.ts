import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { AcpSessionFactory } from '../../src/acp-session-factory';
import type { AgentConfig } from '../../src/types';

/**
 * White-box tests for the shutdown-safety guards in `destroySession` and
 * `killProcess`. A foreground Ctrl-C delivers SIGINT to the whole process group,
 * so the ACP child is usually dead — a tick before teardown observes it — by the
 * time sessions are torn down. The graceful `session/close` RPC must be skipped
 * (or raced against the child exiting), and `killProcess` must not wait out its
 * 5s timeout for a process that is already gone.
 */

function createFactory(): AcpSessionFactory {
  const config = {
    id: 'agent-1',
    type: 'custom',
    sessionMode: 'isolated',
    acp: { cwd: '/tmp' },
  } as unknown as AgentConfig;
  return new AcpSessionFactory(config, 'TestApp', '1.0.0', '[test]', false);
}

interface FakeSession {
  readonly disposable: boolean;
  readonly dispose: ReturnType<typeof vi.fn>;
}

interface FactoryInternals {
  acpSessions: Map<string, unknown>;
  childProcess: unknown;
  childExited: boolean;
  childExitPromise: Promise<void>;
  resolveChildExit: () => void;
}

function internals(factory: AcpSessionFactory): FactoryInternals {
  return factory as unknown as FactoryInternals;
}

interface InjectOpts {
  readonly child?: unknown;
  readonly childExited?: boolean;
  /** When true, arm a pending exit promise and return its resolver. */
  readonly pendingExit?: boolean;
}

function inject(factory: AcpSessionFactory, correlationId: string, session: FakeSession, opts: InjectOpts): () => void {
  const f = internals(factory);
  f.acpSessions.set(correlationId, session);
  f.childProcess = opts.child;
  f.childExited = opts.childExited ?? false;
  if (opts.pendingExit) {
    let resolve!: () => void;
    f.childExitPromise = new Promise<void>((r) => {
      resolve = r;
    });
    f.resolveChildExit = resolve;
    return resolve;
  }
  return () => {};
}

function makeSession(disposable = true): FakeSession {
  return { disposable, dispose: vi.fn().mockResolvedValue(undefined) };
}

describe('AcpSessionFactory.destroySession', () => {
  it('skips session/close when the child was killed by a signal', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: { exitCode: null, signalCode: 'SIGINT' } });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('skips session/close when the child exited with a code', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: { exitCode: 0, signalCode: null } });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('skips session/close when the childExited flag is set even if codes look alive', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: { exitCode: null, signalCode: null }, childExited: true });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('skips session/close when there is no child process', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: undefined });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('disposes the session when the child is still alive', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: { exitCode: null, signalCode: null }, pendingExit: true });

    await factory.destroySession('sess-1');

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a non-disposable session even when the child is alive', async () => {
    const factory = createFactory();
    const session = makeSession(false);
    inject(factory, 'sess-1', session, { child: { exitCode: null, signalCode: null }, pendingExit: true });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('completes via the child-exit race when dispose stalls on a dying child', async () => {
    const factory = createFactory();
    // dispose never settles — models session/close awaiting a now-dead child.
    const session: FakeSession = { disposable: true, dispose: vi.fn().mockReturnValue(new Promise<void>(() => {})) };
    const resolveExit = inject(factory, 'sess-1', session, {
      child: { exitCode: null, signalCode: null },
      pendingExit: true,
    });

    const destroyed = factory.destroySession('sess-1');
    let done = false;
    void destroyed.then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false); // still waiting — dispose stalled, child not yet exited

    resolveExit(); // child exits mid-dispose
    await destroyed;
    expect(done).toBe(true);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('removes the session from the registry even when dispose is skipped', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { child: { exitCode: 0, signalCode: null } });

    await factory.destroySession('sess-1');

    expect(internals(factory).acpSessions.has('sess-1')).toBe(false);
  });
});

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: string | null;
  stdin: { destroyed: boolean; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(opts: { exitCode?: number | null; signalCode?: string | null }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = opts.exitCode ?? null;
  child.signalCode = opts.signalCode ?? null;
  child.stdin = { destroyed: true, end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe('AcpSessionFactory.killProcess', () => {
  function killProcess(factory: AcpSessionFactory): Promise<void> {
    return (factory as unknown as { killProcess: () => Promise<void> }).killProcess();
  }

  it('returns immediately without SIGKILL when the child already exited via signal', async () => {
    const factory = createFactory();
    const child = makeChild({ exitCode: null, signalCode: 'SIGINT' });
    const f = internals(factory);
    f.childProcess = child;
    f.childExited = true;

    await killProcess(factory);

    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('resolves as soon as a live child emits exit (no SIGKILL)', async () => {
    const factory = createFactory();
    const child = makeChild({ exitCode: null, signalCode: null });
    child.stdin.destroyed = false;
    const f = internals(factory);
    f.childProcess = child;
    f.childExited = false;

    const done = killProcess(factory);
    // The factory's own exit handler isn't wired here, so emit + flip the flag
    // the way the real handler would.
    f.childExited = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await done;

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('SIGKILLs a live child that never exits within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const factory = createFactory();
      const child = makeChild({ exitCode: null, signalCode: null });
      child.stdin.destroyed = false;
      const f = internals(factory);
      f.childProcess = child;
      f.childExited = false;

      const done = killProcess(factory);
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
