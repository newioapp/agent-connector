/**
 * Cross-conversation messaging over the real daemon (shared session mode).
 *
 * The full-stack counterpart to `cross-conversation.e2e.test.ts`: same `send_dm` /
 * `send_message` routing in `shared` mode, but the connector runs as the real
 * `newio` daemon process configured through the CLI (`agent add --session-mode
 * shared`) rather than the embedded runtime — proving the shared-mode tool routing
 * survives the CLI/daemon/RPC plumbing the embedded harness skips.
 *
 *   1. `send_dm` — owner tells the puppet (in the owner DM) to DM a sibling agent;
 *      the message lands in a brand-new agent↔agent DM.
 *   2. `send_message` — owner tells the puppet to post into a Work Session it
 *      belongs to; the message lands in that group, visible to the owner.
 *
 * Run with: `pnpm --filter @newio/e2e test:e2e` — requires NEWIO_API_URL /
 * NEWIO_WS_URL (see packages/e2e/.env.example).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { DaemonSandbox } from '../src/daemon-sandbox.js';
import { startPuppetAgent } from '../src/puppet-agent.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

describe('daemon cross-conversation messaging (shared mode)', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let sibling: AgentCredentials;
  let driver: PuppetDriver;
  let sandbox: DaemonSandbox;

  const suffix = Date.now().toString(36);
  const DM_TEXT = `daemon-cross-dm-${suffix}`;
  const GROUP_TEXT = `daemon-cross-group-${suffix}`;

  // Filled in before the relevant action so the puppet handler can close over them.
  let siblingUsername = '';
  let workSessionId = '';

  beforeAll(async () => {
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner, 'E2E Daemon Sender');
    // A second agent under the same owner — auto-friended sibling, reachable by
    // the default `owner_and_owner_agents` DM allowlist.
    sibling = await backend.createApprovedAgent(owner, 'E2E Daemon Sibling');
    siblingUsername = sibling.username;

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => {
      if (text.includes('SEND_DM_MARKER')) {
        return [
          { kind: 'tool', name: 'send_dm', args: { username: siblingUsername, text: DM_TEXT } },
          { kind: 'message', text: 'dm sent' },
        ];
      }
      if (text.includes('SEND_GROUP_MARKER')) {
        return [
          { kind: 'tool', name: 'send_message', args: { conversationId: workSessionId, text: GROUP_TEXT } },
          { kind: 'message', text: 'group message sent' },
        ];
      }
      return 'hello from puppet';
    });

    sandbox = await DaemonSandbox.start({ apiBaseUrl: urls.apiBaseUrl, wsUrl: urls.wsUrl });
    await startPuppetAgent(sandbox, { agent, driver, sessionMode: 'shared' });
  });

  afterAll(async () => {
    await sandbox?.stop();
    await driver?.stop();
  });

  /** The owner↔agent DM, created by the agent's startup greeting. */
  async function ownerDm(): Promise<string> {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    return dm!.conversationId;
  }

  it('delivers a send_dm to a sibling agent in a new agent↔agent DM', async () => {
    const conversationId = await ownerDm();
    await backend.sendMessage(owner.accessToken, conversationId, 'SEND_DM_MARKER ping the sibling');

    // The puppet's MCP tool call succeeded…
    const toolResult = await driver.waitForToolResult((r) => r.name === 'send_dm');
    expect(toolResult.isError).toBe(false);

    // …and the message is readable in the agent↔sibling DM (read with the agent's
    // own token, scanning its DMs for the one carrying our marker).
    const delivered = await waitForMessageInAnyDm(
      backend,
      agent.accessToken,
      (m) => m.senderId === agent.agentId && m.text === DM_TEXT,
    );
    expect(delivered.text).toBe(DM_TEXT);
  });

  it('delivers a send_message into a Work Session the agent belongs to', async () => {
    workSessionId = await backend.createWorkSession(owner, agent.agentId, 'E2E Daemon Cross Group');
    await backend.setAgentCanSend(owner, workSessionId, agent.agentId, true);

    const conversationId = await ownerDm();
    await backend.sendMessage(owner.accessToken, conversationId, 'SEND_GROUP_MARKER post to the group');

    const toolResult = await driver.waitForToolResult((r) => r.name === 'send_message');
    expect(toolResult.isError).toBe(false);

    // The owner is a member of the work session and sees the agent's post.
    const delivered = await backend.waitForMessage(
      owner.accessToken,
      workSessionId,
      (m) => m.senderId === agent.agentId && m.text === GROUP_TEXT,
    );
    expect(delivered.text).toBe(GROUP_TEXT);
  });
});

/**
 * Poll every DM visible to `token` until one carries a message matching
 * `predicate`. Used for `send_dm`, where the target DM is created lazily by the
 * tool call and its id isn't known up front.
 */
async function waitForMessageInAnyDm(
  backend: OwnerBackend,
  token: string,
  predicate: (m: { readonly senderId: string; readonly text: string }) => boolean,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<{ readonly senderId: string; readonly text: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dms = (await backend.listConversations(token)).filter((c) => c.type === 'dm');
    for (const dm of dms) {
      const messages = await backend.listMessages(token, dm.conversationId);
      const match = messages.find(predicate);
      if (match) {
        return match;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for a matching message in any DM');
}
