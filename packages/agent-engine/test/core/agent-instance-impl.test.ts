import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentInstanceImpl } from '../../src/agent-instance-impl';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { AgentInstanceListener } from '../../src/agent-instance';
import type { AgentConfig } from '../../src/types';
import type { CronStore } from '../../src/cron-store';
import type { EngineConfig } from '../../src/engine-config';
import type { MemberRecord, ConversationListItem } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemberRecord(userId: string, overrides?: Partial<MemberRecord>): MemberRecord {
  return {
    userId,
    displayName: 'Test User',
    accountType: 'human',
    role: 'member',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockApp(
  ownerId: string,
  members: Map<string, Map<string, MemberRecord>>,
  conversations?: Map<string, Partial<ConversationListItem>>,
) {
  const sendActionRequest = vi.fn().mockResolvedValue({ requestId: 'req-1', selectedOptionId: 'allow_once' });

  return {
    identity: { userId: 'agent-1', username: 'test_agent', displayName: 'Test Agent', ownerId },
    sendActionRequest,
    getConversationInfo: vi.fn((conversationId: string) => {
      const conv = conversations?.get(conversationId);
      if (!conv?.type) {
        return Promise.resolve({ type: 'dm' });
      }
      return Promise.resolve({ type: conv.type, name: conv.name });
    }),
    isConversationMember: vi.fn((conversationId: string, userId: string) => {
      const m = members.get(conversationId);
      return Promise.resolve(m?.has(userId) ?? false);
    }),
    getConversationMemberIds: vi.fn((conversationId: string) => {
      const m = members.get(conversationId);
      return Promise.resolve(m ? [...m.keys()] : []);
    }),
    getMemberInfo: vi.fn((conversationId: string, userId: string) => {
      const m = members.get(conversationId)?.get(userId);
      if (!m) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({ username: m.username, displayName: m.displayName });
    }),
  };
}

function createInstance(): AgentInstanceImpl {
  const config: AgentConfig = { id: 'agent-1', type: 'kiro-cli', envVars: {} };
  const configManager = {} as AgentConfigManager;
  const cronStore = {} as CronStore;
  const engineConfig = {
    apiBaseUrl: '',
    wsUrl: '',
    stage: 'dev',
    appDisplayName: 'Test',
    appVersion: '0.0.1',
    dataDir: '/tmp',
    mcpBridgeCommand: 'node',
    mcpBridgeArgsPrefix: ['/tmp/bridge.js'],
  } as EngineConfig;
  const listener = {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
  } satisfies AgentInstanceListener;

  return new AgentInstanceImpl(config, configManager, cronStore, listener, engineConfig);
}

/** Inject a mock NewioApp into the instance (via private field). */
function setApp(instance: AgentInstanceImpl, app: unknown): void {
  (instance as unknown as Record<string, unknown>)['_app'] = app;
}

/** Inject the owner DM conversation ID. */
function setOwnerDmConversationId(instance: AgentInstanceImpl, id: string): void {
  (instance as unknown as Record<string, unknown>)['_ownerDmConversationId'] = id;
}

/** Call the private handlePermissionRequest method. */
async function callPermissionRequest(
  instance: AgentInstanceImpl,
  title: string,
  options: ReadonlyArray<{ optionId: string; name: string; kind?: string }>,
  conversationId?: string,
): Promise<string> {
  const fn = (instance as unknown as Record<string, Function>)['handlePermissionRequest']!;
  return fn.call(instance, title, options, conversationId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentInstanceImpl — permission request routing', () => {
  const ownerId = 'owner-1';
  const ownerDmConvId = 'dm-owner-agent';
  const friendConvId = 'conv-friend';
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow' },
    { optionId: 'reject_once', name: 'Reject once', kind: 'reject' },
  ];

  let instance: AgentInstanceImpl;

  beforeEach(() => {
    instance = createInstance();
    setOwnerDmConversationId(instance, ownerDmConvId);
  });

  it('routes to the active conversation when the owner is a member', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        [ownerId, makeMemberRecord(ownerId)],
        ['agent-1', makeMemberRecord('agent-1')],
      ]),
    );

    const mockApp = createMockApp(ownerId, members);
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool X?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      friendConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool X?' }),
      undefined,
      [ownerId],
    );
  });

  it('falls back to owner DM when owner is not in the conversation', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        ['agent-1', makeMemberRecord('agent-1')],
        ['friend-1', makeMemberRecord('friend-1')],
      ]),
    );
    const conversations = new Map<string, Partial<ConversationListItem>>();
    conversations.set(friendConvId, { type: 'group', name: 'Project Chat' });

    const mockApp = createMockApp(ownerId, members, conversations);
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool Y?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool Y?' }),
      'Requesting permission for Project Chat conversation',
      [ownerId],
    );
  });

  it('includes friend name for DM conversations', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        ['agent-1', makeMemberRecord('agent-1')],
        ['friend-1', makeMemberRecord('friend-1', { displayName: 'Alice' })],
      ]),
    );
    const conversations = new Map<string, Partial<ConversationListItem>>();
    conversations.set(friendConvId, { type: 'dm' });

    const mockApp = createMockApp(ownerId, members, conversations);
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission' }),
      'Requesting permission for a DM conversation with Alice',
      [ownerId],
    );
  });

  it('falls back to generic DM text when no member info found', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(friendConvId, new Map([['agent-1', makeMemberRecord('agent-1')]]));
    const conversations = new Map<string, Partial<ConversationListItem>>();
    conversations.set(friendConvId, { type: 'dm' });

    const mockApp = createMockApp(ownerId, members, conversations);
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission' }),
      'Requesting permission for a DM conversation',
      [ownerId],
    );
  });

  it('routes to owner DM when no conversationId provided', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp(ownerId, members);
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Global permission?', options);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Global permission?' }),
      undefined,
      [ownerId],
    );
  });
});

describe('AgentInstanceImpl — intentional teardown ordering', () => {
  // Regression guard: the deliberate stop paths (stop() and the start() failure
  // path) must mark the factory as stopping BEFORE cleanup tears down the
  // session manager — which closes the ACP child. If the order flips, the
  // child's exit is seen with stopping===false, misclassified as abnormal, and
  // fires a re-entrant cleanup that deadlocks.
  function injectTeardownSpies(instance: AgentInstanceImpl): string[] {
    const order: string[] = [];
    const rec = instance as unknown as Record<string, unknown>;
    rec['_sessionFactory'] = {
      markStopping: vi.fn(() => order.push('markStopping')),
      terminate: vi.fn(() => {
        order.push('factory.terminate');
        return Promise.resolve();
      }),
    };
    rec['_sessionManager'] = {
      terminate: vi.fn(() => {
        order.push('sessionManager.terminate');
        return Promise.resolve();
      }),
    };
    return order;
  }

  it('marks stopping before session-manager teardown, then terminates (stop)', async () => {
    const instance = createInstance();
    const order = injectTeardownSpies(instance);

    await instance.stop();

    expect(order).toEqual(['markStopping', 'sessionManager.terminate', 'factory.terminate']);
  });

  it('uses the same ordering on the shared teardown() helper', async () => {
    const instance = createInstance();
    const order = injectTeardownSpies(instance);

    await (instance as unknown as Record<string, () => Promise<void>>)['teardown']!.call(instance);

    expect(order).toEqual(['markStopping', 'sessionManager.terminate', 'factory.terminate']);
  });
});
