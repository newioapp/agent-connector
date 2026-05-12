import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgentInstance } from '../../src/base-agent-instance';
import type { AgentSession } from '../../src/agent-session';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { AgentInstanceListener } from '../../src/agent-instance';
import type { AgentConfig, AgentInfo } from '../../src/types';
import type { CronStore } from '../../src/cron-store';
import type { EngineConfig } from '../../src/engine-config';
import type { NewioApp, NewioAppStore, ActionRequest, MemberRecord, ConversationListItem } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Minimal concrete subclass to expose the private permission handler
// ---------------------------------------------------------------------------

class TestAgentInstance extends BaseAgentInstance {
  protected async createSession(): Promise<AgentSession> {
    throw new Error('Not implemented');
  }
  protected async resumeSession(): Promise<AgentSession> {
    throw new Error('Not implemented');
  }
  getAgentInfo(): AgentInfo | undefined {
    return undefined;
  }
  protected onConnected(): void {}
  protected onStopped(): void {}

  /**
   * Expose the private handlePermissionRequest for testing by calling it
   * through the same onPermissionRequest callback shape.
   */
  async testPermissionRequest(
    title: string,
    options: ReadonlyArray<{ optionId: string; name: string }>,
    conversationId?: string,
  ): Promise<string> {
    return (this as unknown as Record<string, Function>)['handlePermissionRequest']!(title, options, conversationId);
  }

  /** Inject a mock NewioApp. */
  setApp(app: unknown): void {
    (this as unknown as Record<string, unknown>)['_app'] = app;
  }

  /** Inject the owner DM conversation ID. */
  setOwnerDmConversationId(id: string): void {
    (this as unknown as Record<string, unknown>)['_ownerDmConversationId'] = id;
  }
}

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
): Partial<NewioApp> {
  const store = {
    getMembers: vi.fn((conversationId: string) => members.get(conversationId)),
    getConversation: vi.fn((conversationId: string) => conversations?.get(conversationId)),
  } as unknown as NewioAppStore;

  const sendActionRequest = vi.fn().mockResolvedValue({ requestId: 'req-1', selectedOptionId: 'allow_once' });

  return {
    identity: { userId: 'agent-1', username: 'test-agent', displayName: 'Test Agent', ownerId },
    store,
    sendActionRequest,
  };
}

function createInstance(): TestAgentInstance {
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
  } as EngineConfig;
  const listener = {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
  } satisfies AgentInstanceListener;

  return new TestAgentInstance(config, configManager, cronStore, listener, engineConfig);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BaseAgentInstance — permission request routing', () => {
  const ownerId = 'owner-1';
  const ownerDmConvId = 'dm-owner-agent';
  const friendConvId = 'conv-friend';
  const options = [
    { optionId: 'allow_once', name: 'Allow once' },
    { optionId: 'reject_once', name: 'Reject once' },
  ];

  let instance: TestAgentInstance;

  beforeEach(() => {
    instance = createInstance();
    instance.setOwnerDmConversationId(ownerDmConvId);
  });

  it('routes to the active conversation when the owner is a member (no text)', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        [ownerId, makeMemberRecord(ownerId)],
        ['agent-1', makeMemberRecord('agent-1')],
      ]),
    );

    const mockApp = createMockApp(ownerId, members);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool X?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      friendConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool X?' }),
      undefined,
      [ownerId],
    );
  });

  it('falls back to owner DM for a named group conversation', async () => {
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
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool Y?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool Y?' }),
      'Requesting permission for Project Chat conversation',
      [ownerId],
    );
  });

  it('falls back to owner DM for a DM conversation with friend display name', async () => {
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
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission' }),
      'Requesting permission for a DM conversation with Alice',
      [ownerId],
    );
  });

  it('uses conversationId as fallback when conversation is not cached', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        ['agent-1', makeMemberRecord('agent-1')],
        ['friend-1', makeMemberRecord('friend-1')],
      ]),
    );

    const mockApp = createMockApp(ownerId, members);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission' }),
      `Requesting permission for ${friendConvId} conversation`,
      [ownerId],
    );
  });

  it('falls back to owner DM when no conversationId is provided (no text)', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp(ownerId, members);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool W?', options, undefined);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool W?' }),
      undefined,
      [ownerId],
    );
  });

  it('throws when the agent has no owner', async () => {
    const mockApp = createMockApp(undefined as unknown as string, new Map());
    (mockApp as Record<string, unknown>).identity = {
      userId: 'agent-1',
      username: 'test-agent',
      displayName: 'Test Agent',
    };
    instance.setApp(mockApp);

    await expect(instance.testPermissionRequest('Use tool?', options, friendConvId)).rejects.toThrow(
      'Cannot route permission request — agent has no owner',
    );
  });
});
