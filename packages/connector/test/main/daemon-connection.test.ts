import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonNotificationHandlers } from '@newio/cli';

const mocks = vi.hoisted(() => ({
  connect: vi.fn<(path: string, handlers: DaemonNotificationHandlers) => Promise<void>>(),
  handshake: vi.fn(),
  disconnect: vi.fn(),
  openExternal: vi.fn(),
  handlers: { current: undefined as DaemonNotificationHandlers | undefined },
}));

vi.mock('electron', () => ({ shell: { openExternal: mocks.openExternal } }));

vi.mock('@newio/cli', () => ({
  DaemonClient: class {},
  DaemonConnector: class {
    connect(path: string, handlers: DaemonNotificationHandlers): Promise<void> {
      mocks.handlers.current = handlers;
      return mocks.connect(path, handlers);
    }
    handshake(): unknown {
      return mocks.handshake();
    }
    disconnect(): void {
      mocks.disconnect();
    }
  },
  RPC_PROTOCOL_VERSION: 1,
  getDaemonPaths: () => ({ socketPath: '/tmp/x.sock', dataDir: '/tmp', pidPath: '/tmp/p', logPath: '/tmp/l' }),
}));

import { DaemonConnection } from '../../src/main/daemon-connection';

function makeWindows() {
  return { send: vi.fn() } as unknown as ConstructorParameters<typeof DaemonConnection>[1];
}

const HANDSHAKE_OK = { protocolVersion: 1, version: '1.2.3', stage: 'dev', apiBaseUrl: 'https://api.dev' };

describe('DaemonConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.current = undefined;
  });

  it('reports connected and forwards the handshake details', async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.handshake.mockResolvedValue(HANDSHAKE_OK);
    const windows = makeWindows();
    const conn = new DaemonConnection('dev', windows);

    await conn.connect();

    expect(conn.getStatus()).toEqual({
      kind: 'connected',
      daemonVersion: '1.2.3',
      stage: 'dev',
      apiBaseUrl: 'https://api.dev',
    });
    expect(windows.send).toHaveBeenCalledWith('daemon-connection-changed', conn.getStatus());
  });

  it('forwards agent notifications to the renderer and opens approval URLs', async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.handshake.mockResolvedValue(HANDSHAKE_OK);
    const windows = makeWindows();
    await new DaemonConnection('dev', windows).connect();

    const handlers = mocks.handlers.current!;
    handlers.onStatusChanged?.('a1', 'running', undefined);
    expect(windows.send).toHaveBeenCalledWith('agent-status-changed', {
      agentId: 'a1',
      status: 'running',
      error: undefined,
    });

    handlers.onApprovalUrl?.('a1', 'https://approve');
    expect(windows.send).toHaveBeenCalledWith('agent-approval-url', { agentId: 'a1', approvalUrl: 'https://approve' });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://approve');
  });

  it('reports unreachable when the socket connect fails', async () => {
    mocks.connect.mockRejectedValue(new Error('ENOENT'));
    const conn = new DaemonConnection('dev', makeWindows());
    await conn.connect();
    expect(conn.getStatus()).toEqual({ kind: 'unreachable' });
  });

  it('reports a protocol mismatch and disconnects', async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.handshake.mockResolvedValue({ ...HANDSHAKE_OK, protocolVersion: 2 });
    const conn = new DaemonConnection('dev', makeWindows());
    await conn.connect();
    expect(conn.getStatus()).toEqual({ kind: 'protocol-mismatch', daemonProtocol: 2, clientProtocol: 1 });
    expect(mocks.disconnect).toHaveBeenCalled();
  });

  it('marks unreachable when the connection drops after connecting', async () => {
    mocks.connect.mockResolvedValue(undefined);
    mocks.handshake.mockResolvedValue(HANDSHAKE_OK);
    const conn = new DaemonConnection('dev', makeWindows());
    await conn.connect();

    mocks.handlers.current!.onDisconnect?.();
    expect(conn.getStatus()).toEqual({ kind: 'unreachable' });
  });

  it('ignores an overlapping connect() while one is in flight', async () => {
    let resolveConnect: () => void = () => {};
    mocks.connect.mockReturnValue(new Promise<void>((r) => (resolveConnect = r)));
    mocks.handshake.mockResolvedValue(HANDSHAKE_OK);
    const conn = new DaemonConnection('dev', makeWindows());

    const first = conn.connect(); // starts; blocks on the pending connect
    await conn.connect(); // overlapping — must return immediately without a second attempt
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    resolveConnect();
    await first;
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(conn.getStatus().kind).toBe('connected');
  });
});
