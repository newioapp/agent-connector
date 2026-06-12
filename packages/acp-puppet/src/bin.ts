/**
 * Puppet executable entry point. The connector spawns this as a `custom` ACP
 * agent: it speaks ACP over stdio and, if `PUPPET_CONTROL_SOCKET` is set,
 * connects back to the test's PuppetDriver to take live per-turn instructions.
 *
 * Spawn form (from the connector's `custom` agent `executablePath`):
 *   `<node> <dist/bin.js>`   with env `PUPPET_CONTROL_SOCKET=<driver socket>`
 */
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { PuppetAgent } from './agent.js';
import { DefaultControl, SocketControl, type PuppetControl } from './control.js';

async function main(): Promise<void> {
  const socketPath = process.env.PUPPET_CONTROL_SOCKET;

  let control: PuppetControl;
  if (socketPath) {
    const socketControl = new SocketControl(socketPath);
    try {
      await socketControl.connect();
      control = socketControl;
    } catch {
      // Driver not reachable — fall back to standalone behavior so the agent
      // still initializes (surfaces connector-side wiring bugs rather than a
      // dead process).
      control = new DefaultControl();
    }
  } else {
    control = new DefaultControl();
  }

  // Mirror the ACP example agent exactly: first arg is the writable (our
  // outgoing = stdout), second is the readable (our incoming = stdin).
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = ndJsonStream(input, output);

  let agentRef: PuppetAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    agentRef = new PuppetAgent(conn, control);
    return agentRef;
  }, stream);
  void connection;

  const shutdown = (): void => {
    agentRef?.dispose();
    control.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
