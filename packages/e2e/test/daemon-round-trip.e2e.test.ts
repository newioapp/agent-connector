/**
 * Full shipped-stack e2e: the same owner → backend → connector → puppet → back
 * round-trip as `round-trip.e2e.test.ts`, but the connector runs as the *real*
 * `newio` daemon process driven over its RPC socket — covering the CLI entry,
 * daemon, `runDaemon` EngineConfig, and RPC transport that the embedded harness
 * skips.
 *
 * Gated behind RUN_E2E=1; needs the cli + puppet builds and the live dev backend.
 * Run with: `pnpm --filter @newio/e2e test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { DaemonHarness } from '../src/daemon-harness.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

const run = process.env.RUN_E2E === '1';

describe.runIf(run)('daemon round-trip (real CLI/daemon process)', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let harness: DaemonHarness;

  const REPLY = `daemon-reply-${Date.now().toString(36)}`;

  beforeAll(async () => {
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner);

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => (text.includes('PING_MARKER') ? REPLY : 'hello from puppet'));

    harness = await DaemonHarness.start({
      apiBaseUrl: urls.apiBaseUrl,
      wsUrl: urls.wsUrl,
      agent,
      driver,
    });
  });

  afterAll(async () => {
    await harness?.stop();
    await driver?.stop();
  });

  it('delivers a puppet reply back to the owner DM via the real daemon', async () => {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    const conversationId = dm!.conversationId;

    await backend.sendMessage(owner.accessToken, conversationId, 'PING_MARKER hello agent');

    const reply = await backend.waitForMessage(
      owner.accessToken,
      conversationId,
      (m) => m.senderId === agent.agentId && m.text === REPLY,
    );
    expect(reply.text).toBe(REPLY);
  });
});
