import { describe, it, expect, vi } from 'vitest';
import { AcpAgentSession } from '../../src/acp-agent-session';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';

/**
 * `dispose()` issues a best-effort `session/close` RPC. If the ACP child is alive
 * but unresponsive the RPC must not block teardown forever — it is bounded by a
 * 3s timeout, after which dispose resolves anyway.
 */

function createSession(connection: ClientSideConnection, disposable: boolean): AcpAgentSession {
  const sessionResponse = { sessionId: 'sess-1' } as unknown as NewSessionResponse;
  return new AcpAgentSession({
    type: 'conversation',
    externalReferenceId: 'conv-1',
    promptFormatterVersion: '1.0.0',
    correlationId: 'sess-1',
    connection,
    sessionResponse,
    disposable,
    resumed: false,
    skipToken: '_skip',
    updateConfig: vi.fn().mockResolvedValue(undefined),
    reportContextWindow: vi.fn().mockResolvedValue(undefined),
  });
}

describe('AcpAgentSession.dispose', () => {
  it('resolves once the close RPC returns', async () => {
    const closeSession = vi.fn().mockResolvedValue({});
    const connection = { unstable_closeSession: closeSession } as unknown as ClientSideConnection;
    const session = createSession(connection, true);

    await session.dispose();

    expect(closeSession).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('does not call the close RPC for a non-disposable session', async () => {
    const closeSession = vi.fn().mockResolvedValue({});
    const connection = { unstable_closeSession: closeSession } as unknown as ClientSideConnection;
    const session = createSession(connection, false);

    await session.dispose();

    expect(closeSession).not.toHaveBeenCalled();
  });

  it('resolves via timeout when the close RPC never settles', async () => {
    vi.useFakeTimers();
    try {
      const closeSession = vi.fn().mockReturnValue(
        new Promise<never>(() => {
          /* never settles — models an unresponsive ACP child */
        }),
      );
      const connection = { unstable_closeSession: closeSession } as unknown as ClientSideConnection;
      const session = createSession(connection, true);

      let resolved = false;
      const disposed = session.dispose().then(() => {
        resolved = true;
      });

      // Before the timeout elapses, dispose is still pending.
      await vi.advanceTimersByTimeAsync(2999);
      expect(resolved).toBe(false);

      // Once the 3s bound elapses, the swallowed timeout lets dispose resolve.
      await vi.advanceTimersByTimeAsync(1);
      await disposed;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
