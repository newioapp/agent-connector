/**
 * In-process tests for the puppet. We wire a real ACP ClientSideConnection (the
 * connector's role) to the PuppetAgent over linked in-memory streams, and drive
 * behavior through a SocketControl connected to a real PuppetDriver over a Unix
 * socket. This exercises the full ACP + control-channel chain deterministically
 * without spawning a process — process spawning and the real MCP stdio path are
 * covered by the connector-layer e2e harness.
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
import { SocketControl, type PuppetControl } from '../src/control.js';
import { PuppetDriver } from '../src/driver.js';
import type { McpConnection, McpConnector } from '../src/mcp-connector.js';

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

/** A fake MCP connector that records tool calls instead of spawning a subprocess. */
class FakeMcpConnector implements McpConnector {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  closed = 0;

  connect(): Promise<McpConnection> {
    return Promise.resolve({
      callTool: (name, args) => {
        this.calls.push({ name, args });
        return Promise.resolve({ isError: false, text: `called ${name}` });
      },
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }
}

/** A control that always answers a turn the same way and ignores everything else. */
function staticControl(turn: Omit<import('../src/protocol.js').TurnInstruction, 't' | 'id'>): PuppetControl {
  return {
    connect: () => Promise.resolve(),
    onSessionNew: () => {},
    onSessionLoad: () => {},
    onCancel: () => {},
    reportToolResult: () => {},
    close: () => {},
    resolveTurn: () => Promise.resolve({ t: 'turn', id: 1, ...turn }),
  };
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
function wire(control: PuppetControl, mcpConnector?: McpConnector): Wired {
  const c2a = new PassThrough();
  const a2c = new PassThrough();

  const clientStream = ndJsonStream(Writable.toWeb(c2a), Readable.toWeb(a2c));
  const agentStream = ndJsonStream(Writable.toWeb(a2c), Readable.toWeb(c2a));

  const clientImpl = new CollectingClient();
  const client = new ClientSideConnection(() => clientImpl, clientStream);

  let agent!: PuppetAgent;
  // eslint-disable-next-line no-new
  new AgentSideConnection((conn) => {
    agent = new PuppetAgent(conn, control, mcpConnector);
    return agent;
  }, agentStream);

  return { client, clientImpl, agent };
}

async function initAndCreateSession(
  client: ClientSideConnection,
  mcpServers: Parameters<ClientSideConnection['newSession']>[0]['mcpServers'] = [],
): Promise<string> {
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  expect(init.agentCapabilities?.loadSession).toBe(true);
  expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();
  const session = await client.newSession({ cwd: process.cwd(), mcpServers });
  return session.sessionId;
}

describe('PuppetAgent', () => {
  it('advertises loadSession/close and streams a scripted reply', async () => {
    const { client, clientImpl } = wire(staticControl({ actions: [{ kind: 'message', text: 'pong' }] }));

    const sessionId = await initAndCreateSession(client);
    const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'ping' }] });

    expect(result.stopReason).toBe('end_turn');
    expect(clientImpl.messages).toBe('pong');
  });

  it('emits thoughts and messages in order', async () => {
    const { client, clientImpl } = wire(
      staticControl({
        actions: [
          { kind: 'thought', text: 'thinking…' },
          { kind: 'message', text: 'answer' },
        ],
      }),
    );

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

  it('calls an MCP tool for a `tool` action and reports the result to the driver', async () => {
    const driver = await PuppetDriver.start();
    drivers.push(driver);
    driver.onPrompt(() => [
      { kind: 'tool', name: 'add_memory', args: { text: 'a fact' } },
      { kind: 'message', text: 'noted' },
    ]);

    const control = new SocketControl(driver.socketPath);
    controls.push(control);
    await control.connect();

    const fake = new FakeMcpConnector();
    const { client, clientImpl } = wire(control, fake);

    // newSession WITH a server so the puppet connects via the fake connector.
    const sessionId = await initAndCreateSession(client, [{ name: 'newio', command: 'noop', args: [], env: [] }]);
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(fake.calls).toEqual([{ name: 'add_memory', args: { text: 'a fact' } }]);
    expect(clientImpl.messages).toBe('noted');
    // The tool result is reported over the control socket, so await it.
    const reported = await driver.waitForToolResult((r) => r.name === 'add_memory', 5_000);
    expect(reported).toEqual({ name: 'add_memory', isError: false, text: 'called add_memory' });
  });

  it('reports an error for a tool action when no MCP server is connected', async () => {
    const { client } = wire(staticControl({ actions: [{ kind: 'tool', name: 'send_dm', args: {} }] }));
    const sessionId = await initAndCreateSession(client); // no mcpServers
    const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(result.stopReason).toBe('end_turn');
    // No throw; the puppet surfaces the missing-connection as a (best-effort) error result.
  });

  it('closes the session MCP connection on session/close', async () => {
    const fake = new FakeMcpConnector();
    const { client } = wire(staticControl({ actions: [{ kind: 'message', text: 'ok' }] }), fake);
    const sessionId = await initAndCreateSession(client, [{ name: 'newio', command: 'noop', args: [], env: [] }]);
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    await client.unstable_closeSession({ sessionId });
    expect(fake.closed).toBe(1);
  });
});
