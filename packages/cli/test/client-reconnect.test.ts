import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonClient } from '../src/client';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  server: Server;
  path: string;
  /** Most recent server-side connection, so a test can drop it. */
  lastSocket: () => Socket | undefined;
}

function startServer(): Promise<Harness> {
  const path = join(tmpdir(), `newio-recon-${randomUUID()}.sock`);
  const server = createServer();
  let socket: Socket | undefined;
  server.on('connection', (s) => {
    socket = s;
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, path, lastSocket: () => socket })));
}

describe('DaemonClient reconnect / disconnect', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  it('does not fire onDisconnect when reconnecting (a superseded socket close is inert)', async () => {
    const h = await startServer();
    const client = new DaemonClient();
    const onDisconnect = vi.fn();
    cleanups.push(
      () => client.disconnect(),
      () => new Promise<void>((r) => h.server.close(() => r())),
    );

    await client.connect(h.path, { onDisconnect });
    // Reconnect: connect() tears down the first socket; its late close must not
    // null out the new socket or report a disconnect.
    await client.connect(h.path, { onDisconnect });
    await delay(40);

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('does not fire onDisconnect on an explicit disconnect()', async () => {
    const h = await startServer();
    const client = new DaemonClient();
    const onDisconnect = vi.fn();
    cleanups.push(() => new Promise<void>((r) => h.server.close(() => r())));

    await client.connect(h.path, { onDisconnect });
    client.disconnect();
    await delay(40);

    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('fires onDisconnect once when the daemon drops the connection', async () => {
    const h = await startServer();
    const client = new DaemonClient();
    const onDisconnect = vi.fn();
    cleanups.push(
      () => client.disconnect(),
      () => new Promise<void>((r) => h.server.close(() => r())),
    );

    await client.connect(h.path, { onDisconnect });
    await delay(10);
    h.lastSocket()?.destroy();
    await delay(40);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
