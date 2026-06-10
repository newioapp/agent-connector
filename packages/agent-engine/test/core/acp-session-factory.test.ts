import { describe, it, expect, vi } from 'vitest';
import { AcpSessionFactory } from '../../src/acp-session-factory';
import type { AgentConfig } from '../../src/types';

/**
 * White-box tests for the shutdown-safety guard in `destroySession`. A foreground
 * Ctrl-C delivers SIGINT to the whole process group, so the ACP child can already
 * be dead when sessions are torn down — the graceful `session/close` RPC must be
 * skipped in that case, or it blocks forever waiting for a reply that never comes.
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
}

function inject(factory: AcpSessionFactory, correlationId: string, session: FakeSession, child: unknown): void {
  const internals = factory as unknown as FactoryInternals;
  internals.acpSessions.set(correlationId, session);
  internals.childProcess = child;
}

function makeSession(disposable = true): FakeSession {
  return { disposable, dispose: vi.fn().mockResolvedValue(undefined) };
}

describe('AcpSessionFactory.destroySession', () => {
  it('skips session/close when the child was killed by a signal', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { exitCode: null, signalCode: 'SIGINT' });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('skips session/close when the child exited with a code', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { exitCode: 0, signalCode: null });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('skips session/close when there is no child process', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, undefined);

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('disposes the session when the child is still alive', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { exitCode: null, signalCode: null });

    await factory.destroySession('sess-1');

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not dispose a non-disposable session even when the child is alive', async () => {
    const factory = createFactory();
    const session = makeSession(false);
    inject(factory, 'sess-1', session, { exitCode: null, signalCode: null });

    await factory.destroySession('sess-1');

    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('removes the session from the registry even when dispose is skipped', async () => {
    const factory = createFactory();
    const session = makeSession();
    inject(factory, 'sess-1', session, { exitCode: 0, signalCode: null });

    await factory.destroySession('sess-1');

    const internals = factory as unknown as FactoryInternals;
    expect(internals.acpSessions.has('sess-1')).toBe(false);
  });
});
