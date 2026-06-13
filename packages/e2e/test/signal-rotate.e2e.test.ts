/**
 * Owner-triggered session rotation via the `rotate_session` signal (isolated mode).
 *
 * The owner can force the agent to end the current conversation session and start
 * a fresh one (a clean context window). The owner sends a `rotate_session` signal
 * (`POST /signals`, delivered to the agent's WebSocket); the connector runs the
 * session-end prompt on the old session and launches a replacement with resume
 * DISABLED. We prove it deterministically: a message handled *after* the rotation
 * lands on a DIFFERENT ACP session than the one before it — and that new session
 * was opened fresh (`session/new`), not resumed.
 *
 * Each prompt the puppet answers carries its `sessionId`, so comparing the
 * pre- and post-rotation prompt sessions is a direct check of the rotation.
 * Gated behind RUN_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { ConnectorHarness } from '../src/connector-harness.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

const run = process.env.RUN_E2E === '1';

describe.runIf(run)('rotate_session signal (isolated mode)', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let harness: ConnectorHarness;

  const suffix = Date.now().toString(36);
  const REPLY_1 = `rotate-reply-1-${suffix}`;
  const REPLY_2 = `rotate-reply-2-${suffix}`;

  beforeAll(async () => {
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner, 'E2E Rotate');

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => {
      if (text.includes('ROTATE_PING_1')) {
        return REPLY_1;
      }
      if (text.includes('ROTATE_PING_2')) {
        return REPLY_2;
      }
      // Greeting and the session-end prompt (sent to the old session during
      // rotation) fall through to a benign reply.
      return 'hello from puppet';
    });

    harness = await ConnectorHarness.start({
      apiBaseUrl: urls.apiBaseUrl,
      wsUrl: urls.wsUrl,
      stage: urls.stage,
      agent,
      driver,
    });
  });

  afterAll(async () => {
    await harness?.stop();
    await driver?.stop();
  });

  it('starts a fresh session for the next message after a rotate_session signal', async () => {
    const conversationId = await ownerDmId();

    // 1. Establish the conversation session.
    await backend.sendMessage(owner.accessToken, conversationId, 'ROTATE_PING_1 first');
    await backend.waitForMessage(
      owner.accessToken,
      conversationId,
      (m) => m.senderId === agent.agentId && m.text === REPLY_1,
    );
    const before = promptSessionId(driver, 'ROTATE_PING_1');

    // 2. Owner forces a rotation of that conversation's session.
    await backend.sendSignal(owner.accessToken, agent.agentId, 'rotate_session', {
      sessionType: 'conversation',
      externalReferenceId: conversationId,
    });

    // 3. The next message is served by a DIFFERENT session (fresh context window).
    await backend.sendMessage(owner.accessToken, conversationId, 'ROTATE_PING_2 second');
    const reply2 = await backend.waitForMessage(
      owner.accessToken,
      conversationId,
      (m) => m.senderId === agent.agentId && m.text === REPLY_2,
    );
    expect(reply2.text).toBe(REPLY_2);

    const after = promptSessionId(driver, 'ROTATE_PING_2');
    expect(after, 'post-rotation message should run on a different session').not.toBe(before);

    // 4. Rotation disables resume — the replacement session was opened fresh.
    const opened = driver.sessionEvents.find((e) => e.sessionId === after);
    expect(opened?.kind, 'rotated session must be new, not resumed').toBe('new');
  });

  /** The sessionId the puppet saw for the prompt containing `marker`. */
  function promptSessionId(d: PuppetDriver, marker: string): string {
    const prompt = d.prompts.find((p) => p.text.includes(marker));
    expect(prompt, `expected a recorded prompt containing "${marker}"`).toBeDefined();
    return prompt!.sessionId;
  }

  async function ownerDmId(): Promise<string> {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    return dm!.conversationId;
  }
});
