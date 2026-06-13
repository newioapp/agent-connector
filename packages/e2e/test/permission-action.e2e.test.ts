/**
 * Permission / action-message flow end to end.
 *
 * When the agent issues an ACP `session/request_permission`, the connector turns
 * it into an interactive ActionRequest message addressed to the owner (visibleTo
 * the owner), blocks the agent's turn until the owner answers, then resolves the
 * ACP request with the chosen option. This proves the full loop:
 *
 *   agent → request_permission → connector → ActionRequest message to owner
 *         → owner picks an option (response message) → connector correlates by
 *         requestId → agent's request_permission resolves with that option.
 *
 * The puppet issues the request via a `permission` turn action and reports the
 * resolved outcome back over the control channel, which is what we assert on.
 * Gated behind RUN_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PuppetDriver } from '@newio/acp-puppet';
import { ConnectorHarness } from '../src/connector-harness.js';
import { OwnerBackend, type AgentCredentials, type OwnerTokens } from '../src/backend.js';
import { resolveBackendUrls } from '../src/config.js';

const run = process.env.RUN_E2E === '1';

describe.runIf(run)('permission / action-message flow', () => {
  const urls = resolveBackendUrls();
  const backend = new OwnerBackend(urls.apiBaseUrl);

  let owner: OwnerTokens & { readonly username: string };
  let agent: AgentCredentials;
  let driver: PuppetDriver;
  let harness: ConnectorHarness;

  const PERMISSION_TITLE = `Run the build? (${Date.now().toString(36)})`;

  beforeAll(async () => {
    owner = await backend.createOwner();
    agent = await backend.createApprovedAgent(owner, 'E2E Permission');

    driver = await PuppetDriver.start();
    driver.onPrompt(({ text }) => {
      if (text.includes('PERMISSION_MARKER')) {
        return {
          actions: [
            {
              kind: 'permission',
              title: PERMISSION_TITLE,
              options: [
                { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          ],
        };
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

  it('routes a permission request to the owner and returns their choice to the agent', async () => {
    const conversations = await backend.listConversations(owner.accessToken);
    const dm = conversations.find((c) => c.type === 'dm');
    expect(dm, 'expected an owner↔agent DM to exist after greeting').toBeDefined();
    const conversationId = dm!.conversationId;

    // Trigger the agent's permission request.
    await backend.sendMessage(owner.accessToken, conversationId, 'PERMISSION_MARKER please confirm');

    // The owner receives an interactive permission ActionRequest with both options.
    const request = await backend.waitForActionRequest(
      owner.accessToken,
      conversationId,
      (a) => a.type === 'permission' && a.title === PERMISSION_TITLE,
    );
    expect(request.senderId).toBe(agent.agentId);
    expect(request.options.map((o) => o.optionId)).toEqual(['approve', 'deny']);

    // The owner approves.
    await backend.sendActionResponse(owner.accessToken, conversationId, request.requestId, 'approve');

    // The agent's request_permission resolves with the owner's selection.
    const result = await driver.waitForPermissionResult((r) => r.outcome === 'selected');
    expect(result).toEqual({ outcome: 'selected', optionId: 'approve' });
  });
});
