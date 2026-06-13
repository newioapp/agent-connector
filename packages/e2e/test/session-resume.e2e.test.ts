/**
 * Session resume across a connector restart (isolated mode).
 *
 * The connector persists a `sessionType/externalReferenceId → correlationId`
 * mapping to disk (`agents/<id>/sessions.json`). After the agent process is torn
 * down, the next event for that key resumes the prior session via ACP
 * `session/load` instead of opening a fresh one — restoring the agent's own
 * in-context history. The same path covers idle teardown (1h, not test-friendly)
 * and a connector restart; we drive the restart, which is deterministic.
 *
 * Flow, against the REAL daemon (so the on-disk store + a true process restart
 * are exercised):
 *   1. Agent greets → owner↔agent DM exists.
 *   2. Owner sends msg #1; the reply round-trips. This guarantees the owner-DM
 *      *conversation* session was created and its correlationId persisted.
 *   3. `newio agent restart` — the agent process dies and respawns, reading the
 *      persisted session store back off disk.
 *   4. Owner sends msg #2 → the connector resumes the DM's session via
 *      `session/load` (the puppet reports a `load` lifecycle event), and the
 *      reply still round-trips.
 *
 * The puppet reconnects to the same long-lived PuppetDriver socket after the
 * restart, so its `session/load` is observable. Gated behind RUN_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { DaemonHarness } from '../src/daemon-harness.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

const run = process.env.RUN_E2E === '1';

describe.runIf(run)('session resume across connector restart (isolated mode)', () => {
  let backend: OwnerBackend;
  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let harness: DaemonHarness;

  const suffix = Date.now().toString(36);
  const REPLY_1 = `resume-reply-1-${suffix}`;
  const REPLY_2 = `resume-reply-2-${suffix}`;

  beforeAll(async () => {
    const urls = resolveBackendUrls();
    backend = new OwnerBackend(urls.apiBaseUrl);
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner, 'E2E Resume');

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => {
      if (text.includes('RESUME_PING_1')) {
        return REPLY_1;
      }
      if (text.includes('RESUME_PING_2')) {
        return REPLY_2;
      }
      return 'hello from puppet';
    });

    harness = await DaemonHarness.start({ apiBaseUrl: urls.apiBaseUrl, wsUrl: urls.wsUrl, agent, driver });
  });

  afterAll(async () => {
    await harness?.stop();
    await driver?.stop();
  });

  it('resumes the conversation session via session/load after a restart', async () => {
    const conversationId = await ownerDmId();

    // 1. Establish the conversation session and persist its correlationId. Pin
    // the session id from the prompt the puppet actually answered.
    await backend.sendMessage(owner.accessToken, conversationId, 'RESUME_PING_1 first');
    await backend.waitForMessage(
      owner.accessToken,
      conversationId,
      (m) => m.senderId === agent.agentId && m.text === REPLY_1,
    );
    const before = promptSessionId('RESUME_PING_1');

    // 2. Restart the agent process — the in-memory session is gone, but the
    // on-disk mapping survives.
    const restarted = await harness.runCli(['agent', 'restart', harness.agentConfigId], 90_000);
    const statuses = restarted.stdout.split('\n').map((line) => line.trim());
    expect(statuses, `restart did not reach running:\n${restarted.stdout}`).toContain('running');

    // 3. The next message must be served by the SAME session id — only possible
    // via session/load, since a fresh session would get a new id. We assert on
    // the session that handled THIS message (not a bare `load` event), because
    // the restart's startup greeting may have already resumed the session before
    // this point, so an early `load` event proves nothing about RESUME_PING_2.
    await backend.sendMessage(owner.accessToken, conversationId, 'RESUME_PING_2 second');
    const reply2 = await backend.waitForMessage(
      owner.accessToken,
      conversationId,
      (m) => m.senderId === agent.agentId && m.text === REPLY_2,
    );
    expect(reply2.text).toBe(REPLY_2);

    const after = promptSessionId('RESUME_PING_2');
    expect(after, 'second message should run on the resumed (same) session').toBe(before);

    // And that session was brought back via session/load after the restart — a
    // fresh process can only hold this id by loading it.
    const wasLoaded = driver.sessionEvents.some((e) => e.kind === 'load' && e.sessionId === before);
    expect(wasLoaded, 'resumed session should have been loaded after the restart').toBe(true);
  });

  /** The sessionId the puppet saw for the prompt containing `marker`. */
  function promptSessionId(marker: string): string {
    const prompt = driver.prompts.find((p) => p.text.includes(marker));
    expect(prompt, `expected a recorded prompt containing "${marker}"`).toBeDefined();
    return prompt!.sessionId;
  }

  /** The owner↔agent DM, created by the agent's startup greeting. */
  async function ownerDmId(): Promise<string> {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    return dm!.conversationId;
  }
});
