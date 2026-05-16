import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IsolatedSessionAgentInstance } from '../../src/isolated-session-agent-instance';
import type { AgentSession } from '../../src/agent-session';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { AgentInstanceListener } from '../../src/agent-instance';
import type { AgentConfig, AgentInfo } from '../../src/types';
import type { CronStore } from '../../src/cron-store';
import type { EngineConfig } from '../../src/engine-config';
import type { NewioApp, NewioAppStore, ActionRequest, MemberRecord, ConversationListItem } from '@newio/agent-sdk';

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

function createInstance(): IsolatedSessionAgentInstance {
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

  return new IsolatedSessionAgentInstance(config, configManager, cronStore, listener, engineConfig);
}

/** Inject a mock NewioApp into the instance. */
function setApp(instance: IsolatedSessionAgentInstance, app: unknown): void {
  (instance as unknown as Record<string, unknown>)['_app'] = app;
}

/** Inject the owner DM conversation ID. */
function setOwnerDmConversationId(instance: IsolatedSessionAgentInstance, id: string): void {
  (instance as unknown as Record<string, unknown>)['_ownerDmConversationId'] = id;
}

/** Inject a conversation slot with a mock session for testing. */
function injectConversationSlot(
  instance: IsolatedSessionAgentInstance,
  conversationId: string,
  session: Partial<AgentSession>,
): void {
  const slots = (instance as unknown as Record<string, unknown>)['conversationSlots'] as Map<string, unknown>;
  slots.set(conversationId, {
    type: 'conversation',
    externalReferenceId: conversationId,
    session,
    lastActivityAt: Date.now(),
    inFlight: null,
  });
}

/** Call the private handlePermissionRequest method. */
async function callPermissionRequest(
  instance: IsolatedSessionAgentInstance,
  title: string,
  options: ReadonlyArray<{ optionId: string; name: string }>,
  conversationId?: string,
): Promise<string> {
  return (instance as unknown as Record<string, Function>)['handlePermissionRequest']!(title, options, conversationId);
}

/** Simulate a conversation.member_updated event routing through the handler. */
function simulateMemberUpdated(
  instance: IsolatedSessionAgentInstance,
  event: { conversationId: string; userId: string; updatedBy?: string; changes: Record<string, unknown> },
): void {
  const { conversationId, userId, updatedBy, changes } = event;
  const app = instance.app;
  if (userId !== app.identity.userId) {
    return;
  }
  if (updatedBy === app.identity.userId) {
    return;
  }
  if (changes.acpModel !== undefined || changes.acpMode !== undefined) {
    const handler = (instance as unknown as Record<string, Function>)['applySessionConfigChange']!;
    void handler.call(instance, conversationId, {
      acpModel: changes.acpModel,
      acpMode: changes.acpMode,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IsolatedSessionAgentInstance — permission request routing', () => {
  const ownerId = 'owner-1';
  const ownerDmConvId = 'dm-owner-agent';
  const friendConvId = 'conv-friend';
  const options = [
    { optionId: 'allow_once', name: 'Allow once' },
    { optionId: 'reject_once', name: 'Reject once' },
  ];

  let instance: IsolatedSessionAgentInstance;

  beforeEach(() => {
    instance = createInstance();
    setOwnerDmConversationId(instance, ownerDmConvId);
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
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool X?', options, friendConvId);

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
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool Y?', options, friendConvId);

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
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool?', options, friendConvId);

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
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool?', options, friendConvId);

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
    setApp(instance, mockApp);

    await callPermissionRequest(instance, 'Use tool W?', options, undefined);

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
    setApp(instance, mockApp);

    await expect(callPermissionRequest(instance, 'Use tool?', options, friendConvId)).rejects.toThrow(
      'Cannot route permission request — agent has no owner',
    );
  });
});

describe('IsolatedSessionAgentInstance — acpModel/acpMode routing via conversation.member_updated', () => {
  const ownerId = 'owner-1';
  const convId = 'conv-123';
  let instance: IsolatedSessionAgentInstance;
  let mockSession: { applySessionConfig: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    instance = createInstance();
    setOwnerDmConversationId(instance, 'dm-owner');
    mockSession = { applySessionConfig: vi.fn().mockResolvedValue(undefined) };

    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp(ownerId, members);
    setApp(instance, mockApp);
    injectConversationSlot(instance, convId, mockSession as unknown as AgentSession);
  });

  it('applies acpModel/acpMode to the active session', () => {
    simulateMemberUpdated(instance, {
      conversationId: convId,
      userId: 'agent-1',
      updatedBy: ownerId,
      changes: { acpModel: 'claude-4-sonnet', acpMode: 'plan' },
    });

    expect(mockSession.applySessionConfig).toHaveBeenCalledWith({
      acpModel: 'claude-4-sonnet',
      acpMode: 'plan',
    });
  });

  it('applies only acpModel when acpMode is undefined', () => {
    simulateMemberUpdated(instance, {
      conversationId: convId,
      userId: 'agent-1',
      updatedBy: ownerId,
      changes: { acpModel: 'gpt-5' },
    });

    expect(mockSession.applySessionConfig).toHaveBeenCalledWith({
      acpModel: 'gpt-5',
      acpMode: undefined,
    });
  });

  it('ignores self-updates (updatedBy === agent itself)', () => {
    simulateMemberUpdated(instance, {
      conversationId: convId,
      userId: 'agent-1',
      updatedBy: 'agent-1',
      changes: { acpModel: 'claude-4-sonnet' },
    });

    expect(mockSession.applySessionConfig).not.toHaveBeenCalled();
  });

  it('ignores updates for a different user', () => {
    simulateMemberUpdated(instance, {
      conversationId: convId,
      userId: 'other-agent',
      updatedBy: ownerId,
      changes: { acpModel: 'claude-4-sonnet' },
    });

    expect(mockSession.applySessionConfig).not.toHaveBeenCalled();
  });

  it('does nothing when no active session for the conversation', () => {
    simulateMemberUpdated(instance, {
      conversationId: 'conv-nonexistent',
      userId: 'agent-1',
      updatedBy: ownerId,
      changes: { acpModel: 'claude-4-sonnet' },
    });

    expect(mockSession.applySessionConfig).not.toHaveBeenCalled();
  });

  it('does nothing when changes have no acpModel or acpMode', () => {
    simulateMemberUpdated(instance, {
      conversationId: convId,
      userId: 'agent-1',
      updatedBy: ownerId,
      changes: { showToolCalls: true },
    });

    expect(mockSession.applySessionConfig).not.toHaveBeenCalled();
  });
});
