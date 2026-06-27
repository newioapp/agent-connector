/**
 * Cross-conversation messaging over the real daemon (chat-shared session mode).
 *
 * The full-stack counterpart to `cross-conversation.e2e.test.ts`: the same routes, but the connector
 * runs as the real `newio` daemon process configured through the CLI rather than the embedded runtime
 * — proving the tool routing survives the CLI/daemon/RPC plumbing the embedded harness skips. This
 * test passes no `--session-mode`, so the agent takes the default `chat-shared` mode: one chat hub
 * session for DMs/groups/contacts, plus a dedicated session per Work Session.
 *
 *   1. `create_dm` + `send_message` — owner tells the puppet (in the owner DM) to DM a sibling agent;
 *      the message lands in a brand-new agent↔agent DM.
 *   2. `share_context` → `send_message` — the chat hub can't post into a Work Session directly, so it
 *      hands context to the work session's own session, which surfaces it with its own send_message;
 *      the message lands in the group, visible to the owner.
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

describe('daemon cross-conversation messaging (chat-shared mode)', () => {
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
  let siblingDmId = '';
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
      // DM step 1: resolve (or create) the agent↔sibling DM to get its conversation id.
      if (text.includes('RESOLVE_DM_MARKER')) {
        return [
          { kind: 'tool', name: 'create_dm', args: { username: siblingUsername } },
          { kind: 'message', text: 'resolving dm' },
        ];
      }
      // DM step 2: the chat hub sends into the resolved DM (id seeded into scope by the test).
      if (text.includes('SEND_DM_MARKER')) {
        return [
          { kind: 'tool', name: 'send_message', args: { conversationId: siblingDmId, text: DM_TEXT } },
          { kind: 'message', text: 'dm sent' },
        ];
      }
      // Group: the hub hands the message to the work session's own session via share_context — it
      // can't post into a Work Session directly.
      if (text.includes('SEND_GROUP_MARKER')) {
        return [
          {
            kind: 'tool',
            name: 'share_context',
            args: { conversationId: workSessionId, context: `SPOKE_DELIVER ${GROUP_TEXT}` },
          },
          { kind: 'message', text: 'handed off to work session' },
        ];
      }
      // The work-session session surfaces the handed context into its own conversation. Its
      // send_message targets that conversation, so it takes no conversation id.
      if (text.includes('SPOKE_DELIVER')) {
        return [{ kind: 'tool', name: 'send_message', args: { text: GROUP_TEXT } }];
      }
      return 'hello from puppet';
    });

    sandbox = await DaemonSandbox.start({ apiBaseUrl: urls.apiBaseUrl, wsUrl: urls.wsUrl });
    await startPuppetAgent(sandbox, { agent, driver });
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

  it('delivers a DM to a sibling agent via create_dm + send_message', async () => {
    const conversationId = await ownerDm();

    // Step 1 — resolve the sibling DM and capture its id from the tool result.
    await backend.sendMessage(owner.accessToken, conversationId, 'RESOLVE_DM_MARKER resolve the sibling DM');
    const created = await driver.waitForToolResult((r) => r.name === 'create_dm');
    expect(created.isError).toBe(false);
    siblingDmId = (JSON.parse(created.text) as { conversationId: string }).conversationId;
    expect(siblingDmId).toBeTruthy();

    // Step 2 — send into that DM.
    await backend.sendMessage(owner.accessToken, conversationId, 'SEND_DM_MARKER ping the sibling');
    const sent = await driver.waitForToolResult((r) => r.name === 'send_message');
    expect(sent.isError).toBe(false);

    // …and the message is readable in the agent↔sibling DM (read with the agent's
    // own token, scanning its DMs for the one carrying our marker).
    const delivered = await waitForMessageInAnyDm(
      backend,
      agent.accessToken,
      (m) => m.senderId === agent.agentId && m.text === DM_TEXT,
    );
    expect(delivered.text).toBe(DM_TEXT);
  });

  it('delivers into a Work Session via share_context to the work session', async () => {
    workSessionId = await backend.createWorkSession(owner, agent.agentId, 'E2E Daemon Cross Group');
    await backend.setAgentCanSend(owner, workSessionId, agent.agentId, true);

    const conversationId = await ownerDm();
    await backend.sendMessage(owner.accessToken, conversationId, 'SEND_GROUP_MARKER post to the group');

    // The hub's hand-off succeeds…
    const handoff = await driver.waitForToolResult((r) => r.name === 'share_context');
    expect(handoff.isError).toBe(false);

    // …and the work session's own session surfaces the message, which the owner sees.
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
 * `predicate`. Used for the agent↔sibling DM, whose id isn't known to the
 * agent's own token up front.
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
