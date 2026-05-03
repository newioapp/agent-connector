import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgentInstance } from '../../src/core/base-agent-instance';
import type { AgentSession } from '../../src/core/agent-session';
import type { AgentConfigManager } from '../../src/core/agent-config-manager';
import type { AgentInstanceListener, AgentSessionConfig, ConfigureAgentInput } from '../../src/core/agent-instance';
import type { AgentConfig, AgentInfo } from '../../src/core/types';
import type { SessionStore } from '../../src/core/session-store';
import type { NewioApp, NewioAppStore, ActionRequest, MemberRecord } from '@newio/agent-sdk';

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
  listModels(): AgentSessionConfig | undefined {
    return undefined;
  }
  listModes(): AgentSessionConfig | undefined {
    return undefined;
  }
  async configureAgent(_input: ConfigureAgentInput): Promise<void> {}

  /**
   * Expose the private handlePermissionRequest for testing by calling it
   * through the same onPermissionRequest callback shape.
   */
  async testPermissionRequest(
    title: string,
    options: ReadonlyArray<{ optionId: string; name: string }>,
    conversationId?: string,
  ): Promise<string> {
    // Access the private method via bracket notation
    return (this as unknown as Record<string, Function>)['handlePermissionRequest'](title, options, conversationId);
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

function makeMemberRecord(userId: string): MemberRecord {
  return {
    userId,
    displayName: 'Test User',
    accountType: 'human',
    role: 'member',
    joinedAt: '2026-01-01T00:00:00Z',
  };
}

function createMockApp(
  ownerId: string,
  members: Map<string, Map<string, MemberRecord>>,
  conversations?: Map<string, { name?: string }>,
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
  const config: AgentConfig = { id: 'agent-1', type: 'kiro-cli' };
  const configManager = {} as AgentConfigManager;
  const sessionStore = {} as SessionStore;
  const listener = {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
    onAgentSessionConfigUpdated: vi.fn(),
  } satisfies AgentInstanceListener;

  return new TestAgentInstance(config, configManager, sessionStore, listener);
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
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool X?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      friendConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool X?' }),
      [ownerId],
      undefined,
      undefined,
    );
  });

  it('falls back to owner DM when the owner is NOT a member of the active conversation', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      friendConvId,
      new Map([
        ['agent-1', makeMemberRecord('agent-1')],
        ['friend-1', makeMemberRecord('friend-1')],
      ]),
    );
    const conversations = new Map<string, { name?: string }>();
    conversations.set(friendConvId, { name: 'Project Chat' });

    const mockApp = createMockApp(ownerId, members, conversations);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool Y?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool Y?' }),
      [ownerId],
      undefined,
      'From conversation: Project Chat',
    );
  });

  it('uses conversationId as fallback label when conversation name is not available', async () => {
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
      [ownerId],
      undefined,
      `From conversation: ${friendConvId}`,
    );
  });

  it('falls back to owner DM when members are not cached for the conversation', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp(ownerId, members);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool Z?', options, friendConvId);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool Z?' }),
      [ownerId],
      undefined,
      `From conversation: ${friendConvId}`,
    );
  });

  it('falls back to owner DM when no conversationId is provided', async () => {
    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp(ownerId, members);
    instance.setApp(mockApp);

    await instance.testPermissionRequest('Use tool W?', options, undefined);

    expect(mockApp.sendActionRequest).toHaveBeenCalledWith(
      ownerDmConvId,
      expect.objectContaining({ type: 'permission', title: 'Use tool W?' }),
      [ownerId],
      undefined,
      undefined,
    );
  });

  it('throws when the agent has no owner', async () => {
    const mockApp = createMockApp(undefined as unknown as string, new Map());
    // Override identity to have no ownerId
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
