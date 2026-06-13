/**
 * First full-vertical platform e2e: owner → backend → connector → puppet → back.
 *
 * Proves the plumbing end to end with a deterministic agent:
 *   1. Create an owner and an approved agent (via REST).
 *   2. Boot the real connector runtime wired to the puppet.
 *   3. Owner sends a DM containing a unique marker.
 *   4. The puppet (driven by the test) replies; the connector auto-delivers it.
 *   5. Assert the reply lands back in the conversation, from the agent.
 *
 * Gated behind RUN_E2E=1 because it talks to the live dev backend and spawns a
 * subprocess. Run with: `pnpm --filter @newio/e2e test:e2e`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { ConnectorHarness } from '../src/connector-harness.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

const run = process.env.RUN_E2E === '1';

describe.runIf(run)('connector round-trip', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let harness: ConnectorHarness;

  const REPLY = `puppet-reply-${Date.now().toString(36)}`;
  const MEMORY_FACT = `The owner's favourite test token is ${Date.now().toString(36)}.`;

  beforeAll(async () => {
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner);

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => {
      // MEMORY_MARKER → write a global memory fact via the add_memory MCP tool, then reply.
      if (text.includes('MEMORY_MARKER')) {
        return [
          { kind: 'tool', name: 'add_memory', args: { text: MEMORY_FACT } },
          { kind: 'message', text: 'noted' },
        ];
      }
      // PING_MARKER → the asserted reply. Greeting and anything else → a benign reply.
      if (text.includes('PING_MARKER')) {
        return REPLY;
      }
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

  it('delivers a puppet reply back to the owner DM', async () => {
    // The agent's startup greeting created the owner↔agent DM. Find it.
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

    // And the puppet actually saw the owner's marked prompt.
    const sawPing = driver.prompts.some((p) => p.text.includes('PING_MARKER'));
    expect(sawPing).toBe(true);
  });

  it('writes agent memory via the add_memory MCP tool', async () => {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    const conversationId = dm!.conversationId;

    await backend.sendMessage(owner.accessToken, conversationId, 'MEMORY_MARKER please remember this');

    // The puppet's tool call succeeded (reported back over the control channel)…
    const toolResult = await driver.waitForToolResult((r) => r.name === 'add_memory');
    expect(toolResult.isError).toBe(false);

    // …and the fact is durably stored, readable by the owner via the backend.
    const fact = await backend.waitForMemoryFact(owner.accessToken, agent.agentId, (t) => t === MEMORY_FACT);
    expect(fact).toBe(MEMORY_FACT);
  });
});
