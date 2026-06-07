import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DaemonClient } from '../src/client';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  path: string;
  /** Most recent server-side connection, so a test can drop it. */
  lastSocket: () => Socket | undefined;
  /** Destroy all server-side sockets and close the server (never hangs). */
  close: () => Promise<void>;
}

function startServer(): Promise<Harness> {
  const path = join(tmpdir(), `newio-recon-${randomUUID()}.sock`);
  const server: Server = createServer();
  const sockets: Socket[] = [];
  let last: Socket | undefined;
  server.on('connection', (s) => {
    last = s;
    sockets.push(s);
  });
  return new Promise((resolve) =>
    server.listen(path, () =>
      resolve({
        path,
        lastSocket: () => last,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    ),
  );
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
      () => h.close(),
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
    cleanups.push(() => h.close());

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
      () => h.close(),
    );

    await client.connect(h.path, { onDisconnect });
    await delay(10);
    h.lastSocket()?.destroy();
    await delay(40);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects in-flight requests on an explicit disconnect (no hang)', async () => {
    const h = await startServer(); // accepts but never responds to RPC
    const client = new DaemonClient();
    cleanups.push(() => h.close());

    await client.connect(h.path);
    const inflight = client.call('daemon.ping');
    // Attach the rejection handler before triggering it.
    const assertion = expect(inflight).rejects.toThrow(/connection closed/i);
    client.disconnect();
    await assertion;
  });

  it('rejects in-flight requests when reconnecting (no hang)', async () => {
    const h = await startServer();
    const client = new DaemonClient();
    cleanups.push(
      () => client.disconnect(),
      () => h.close(),
    );

    await client.connect(h.path);
    const inflight = client.call('daemon.ping');
    const assertion = expect(inflight).rejects.toThrow(/connection closed/i);
    await client.connect(h.path); // reconnect tears down the old socket
    await assertion;
  });

  it('rejects a call made while not connected', async () => {
    const client = new DaemonClient();
    await expect(client.call('daemon.ping')).rejects.toThrow(/not connected/i);
  });
});
