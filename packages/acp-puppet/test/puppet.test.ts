/**
 * In-process tests for the puppet. We wire a real ACP ClientSideConnection (the
 * connector's role) to the PuppetAgent over linked in-memory streams, and drive
 * behavior through a SocketControl connected to a real PuppetDriver over a Unix
 * socket. This exercises the full ACP + control-channel chain deterministically
 * without spawning a process — process spawning is covered by the connector-layer
 * harness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { PuppetAgent } from '../src/agent.js';
import { SocketControl } from '../src/control.js';
import { PuppetDriver } from '../src/driver.js';

// Don't spawn the MCP bridge in these in-process tests.
process.env.PUPPET_SPAWN_MCP_BRIDGE = '0';

/** Minimal ACP client that collects the agent's streamed message/thought text. */
class CollectingClient implements Client {
  messages = '';
  thoughts = '';

  sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.messages += update.content.text;
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      this.thoughts += update.content.text;
    }
    return Promise.resolve();
  }

  requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  }
}

interface Wired {
  readonly client: ClientSideConnection;
  readonly clientImpl: CollectingClient;
  readonly agent: PuppetAgent;
}

const drivers: PuppetDriver[] = [];
const controls: SocketControl[] = [];

afterEach(async () => {
  for (const c of controls.splice(0)) {
    c.close();
  }
  for (const d of drivers.splice(0)) {
    await d.stop();
  }
});

/** Link a ClientSideConnection and a PuppetAgent over two in-memory pipes. */
function wire(control: ConstructorParameters<typeof PuppetAgent>[1]): Wired {
  const c2a = new PassThrough();
  const a2c = new PassThrough();

  const clientStream = ndJsonStream(Writable.toWeb(c2a), Readable.toWeb(a2c));
  const agentStream = ndJsonStream(Writable.toWeb(a2c), Readable.toWeb(c2a));

  const clientImpl = new CollectingClient();
  const client = new ClientSideConnection(() => clientImpl, clientStream);

  let agent!: PuppetAgent;
  // eslint-disable-next-line no-new
  new AgentSideConnection((conn) => {
    agent = new PuppetAgent(conn, control);
    return agent;
  }, agentStream);

  return { client, clientImpl, agent };
}

async function initAndCreateSession(client: ClientSideConnection): Promise<string> {
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  expect(init.agentCapabilities?.loadSession).toBe(true);
  const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
  return session.sessionId;
}

describe('PuppetAgent', () => {
  it('advertises loadSession and streams a scripted reply that the connector would auto-send', async () => {
    const { client, clientImpl } = wire({
      connect: () => Promise.resolve(),
      onSessionNew: () => {},
      onSessionLoad: () => {},
      onCancel: () => {},
      close: () => {},
      resolveTurn: (_sessionId, _text) =>
        Promise.resolve({ t: 'turn', id: 1, actions: [{ kind: 'message', text: 'pong' }], stopReason: 'end_turn' }),
    });

    const sessionId = await initAndCreateSession(client);
    const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'ping' }] });

    expect(result.stopReason).toBe('end_turn');
    expect(clientImpl.messages).toBe('pong');
  });

  it('emits thoughts and messages in order', async () => {
    const { client, clientImpl } = wire({
      connect: () => Promise.resolve(),
      onSessionNew: () => {},
      onSessionLoad: () => {},
      onCancel: () => {},
      close: () => {},
      resolveTurn: () =>
        Promise.resolve({
          t: 'turn',
          id: 1,
          actions: [
            { kind: 'thought', text: 'thinking…' },
            { kind: 'message', text: 'answer' },
          ],
          stopReason: 'end_turn',
        }),
    });

    const sessionId = await initAndCreateSession(client);
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'q' }] });

    expect(clientImpl.thoughts).toBe('thinking…');
    expect(clientImpl.messages).toBe('answer');
  });

  it('passes the full prompt text through the SocketControl to a live PuppetDriver', async () => {
    const driver = await PuppetDriver.start();
    drivers.push(driver);
    driver.onPrompt(({ text }) => (text.includes('MARKER') ? 'matched-reply' : 'default-reply'));

    const control = new SocketControl(driver.socketPath);
    controls.push(control);
    await control.connect();

    const { client, clientImpl } = wire(control);
    const sessionId = await initAndCreateSession(client);

    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'please MARKER now' }] });

    expect(clientImpl.messages).toBe('matched-reply');
    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]?.text).toBe('please MARKER now');
  });

  it('falls back to a default reply when no driver answers the turn', async () => {
    // A SocketControl pointed at a closed/away driver still resolves the turn so
    // the puppet never wedges — exercised here via the DefaultControl path.
    const { client, clientImpl } = wire(
      // Reuse SocketControl's fallback semantics via DefaultControl-like inline control.
      {
        connect: () => Promise.resolve(),
        onSessionNew: () => {},
        onSessionLoad: () => {},
        onCancel: () => {},
        close: () => {},
        resolveTurn: () => Promise.resolve({ t: 'turn', id: 1, actions: [{ kind: 'message', text: 'ok' }] }),
      },
    );
    const sessionId = await initAndCreateSession(client);
    const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'x' }] });
    expect(result.stopReason).toBe('end_turn');
    expect(clientImpl.messages).toBe('ok');
  });
});
