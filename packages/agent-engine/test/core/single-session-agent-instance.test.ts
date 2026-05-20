import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SingleSessionAgentInstance } from '../../src/single-session-agent-instance';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { AgentInstanceListener } from '../../src/agent-instance';
import type { AgentConfig } from '../../src/types';
import type { CronStore } from '../../src/cron-store';
import type { EngineConfig } from '../../src/engine-config';
import type { NewioApp, MemberRecord, ConversationListItem } from '@newio/agent-sdk';

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
  const sendActionRequest = vi.fn().mockResolvedValue({ requestId: 'req-1', selectedOptionId: 'allow_once' });

  return {
    identity: { userId: 'agent-1', username: 'test-agent', displayName: 'Test Agent', ownerId },
    sendActionRequest,
    getCachedConversationInfo: vi.fn((conversationId: string) => {
      const conv = conversations?.get(conversationId);
      if (!conv?.type) {
        return undefined;
      }
      return { type: conv.type, name: conv.name };
    }),
    isConversationMember: vi.fn((conversationId: string, userId: string) => {
      const m = members.get(conversationId);
      return m?.has(userId) ?? false;
    }),
    getConversationMemberIds: vi.fn((conversationId: string) => {
      const m = members.get(conversationId);
      return m ? [...m.keys()] : undefined;
    }),
    getMemberDisplayInfo: vi.fn((conversationId: string, userId: string) => {
      const m = members.get(conversationId)?.get(userId);
      if (!m) {
        return undefined;
      }
      return { username: m.username, displayName: m.displayName };
    }),
    getMemoryScope: vi.fn().mockResolvedValue({ summary: null, facts: [] }),
  } as unknown as Partial<NewioApp>;
}

function createInstance(): SingleSessionAgentInstance {
  const config: AgentConfig = { id: 'agent-1', type: 'kiro-cli', sessionMode: 'shared', envVars: {} };
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

  return new SingleSessionAgentInstance(config, configManager, cronStore, listener, engineConfig);
}

function setApp(instance: SingleSessionAgentInstance, app: unknown): void {
  (instance as unknown as Record<string, unknown>)['_app'] = app;
}

function setOwnerDmConversationId(instance: SingleSessionAgentInstance, id: string): void {
  (instance as unknown as Record<string, unknown>)['_ownerDmConversationId'] = id;
}

/** Access the injectedConversationIds set. */
function getInjectedConversationIds(instance: SingleSessionAgentInstance): Set<string> {
  return (instance as unknown as Record<string, unknown>)['injectedConversationIds'] as Set<string>;
}

/** Access the injectedUserIds set. */
function getInjectedUserIds(instance: SingleSessionAgentInstance): Set<string> {
  return (instance as unknown as Record<string, unknown>)['injectedUserIds'] as Set<string>;
}

/** Call the private injectConversationContextIfNeeded method. */
async function callInjectContext(
  instance: SingleSessionAgentInstance,
  conversationId: string,
  session: unknown,
): Promise<void> {
  return (instance as unknown as Record<string, Function>)['injectConversationContextIfNeeded']!(
    conversationId,
    session,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SingleSessionAgentInstance — lazy memory injection', () => {
  const ownerId = 'owner-1';
  const convId = 'conv-123';
  let instance: SingleSessionAgentInstance;
  let mockApp: Partial<NewioApp>;
  let mockSession: { prompt: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    instance = createInstance();
    setOwnerDmConversationId(instance, 'dm-owner');

    const members = new Map<string, Map<string, MemberRecord>>();
    members.set(
      convId,
      new Map([
        ['agent-1', makeMemberRecord('agent-1', { accountType: 'agent' })],
        ['user-1', makeMemberRecord('user-1', { displayName: 'Alice' })],
        ['user-2', makeMemberRecord('user-2', { displayName: 'Bob' })],
      ]),
    );

    mockApp = createMockApp(ownerId, members);
    setApp(instance, mockApp);

    // Mock session.prompt to return an async generator that yields nothing
    mockSession = {
      prompt: vi.fn().mockReturnValue(
        (async function* () {
          /* empty */
        })(),
      ),
    };
  });

  it('fetches conversation and user memory on first encounter', async () => {
    await callInjectContext(instance, convId, mockSession);

    const app = mockApp as unknown as { getMemoryScope: ReturnType<typeof vi.fn> };
    // Should fetch conversation memory
    expect(app.getMemoryScope).toHaveBeenCalledWith('conversation', convId);
    // Should fetch user memory for user-1 and user-2 (not agent-1)
    expect(app.getMemoryScope).toHaveBeenCalledWith('user', 'user-1');
    expect(app.getMemoryScope).toHaveBeenCalledWith('user', 'user-2');
    expect(app.getMemoryScope).toHaveBeenCalledTimes(3);
  });

  it('does not re-fetch on subsequent calls for the same conversation', async () => {
    await callInjectContext(instance, convId, mockSession);

    const app = mockApp as unknown as { getMemoryScope: ReturnType<typeof vi.fn> };
    app.getMemoryScope.mockClear();

    await callInjectContext(instance, convId, mockSession);

    expect(app.getMemoryScope).not.toHaveBeenCalled();
  });

  it('tracks injected conversation and user IDs', async () => {
    await callInjectContext(instance, convId, mockSession);

    expect(getInjectedConversationIds(instance).has(convId)).toBe(true);
    expect(getInjectedUserIds(instance).has('user-1')).toBe(true);
    expect(getInjectedUserIds(instance).has('user-2')).toBe(true);
    expect(getInjectedUserIds(instance).has('agent-1')).toBe(false);
  });

  it('fetches only new users when a previously-seen user appears in a new conversation', async () => {
    await callInjectContext(instance, convId, mockSession);

    const app = mockApp as unknown as {
      getMemoryScope: ReturnType<typeof vi.fn>;
      getConversationMemberIds: ReturnType<typeof vi.fn>;
    };
    app.getMemoryScope.mockClear();

    // Create a second conversation with user-1 (seen) and user-3 (new)
    const newConvId = 'conv-456';
    app.getConversationMemberIds.mockImplementation((id: string) => {
      if (id === newConvId) {
        return ['agent-1', 'user-1', 'user-3'];
      }
      return undefined;
    });
    (mockApp as unknown as { getMemberDisplayInfo: ReturnType<typeof vi.fn> }).getMemberDisplayInfo.mockImplementation(
      (cId: string, userId: string) => {
        if (cId === newConvId && userId === 'user-3') {
          return { username: 'user-3', displayName: 'Charlie' };
        }
        return undefined;
      },
    );

    await callInjectContext(instance, newConvId, mockSession);

    // Should fetch conv memory for new conversation + user-3 only (not user-1)
    expect(app.getMemoryScope).toHaveBeenCalledWith('conversation', newConvId);
    expect(app.getMemoryScope).toHaveBeenCalledWith('user', 'user-3');
    expect(app.getMemoryScope).not.toHaveBeenCalledWith('user', 'user-1');
  });

  it('injects context prompt into session when memory has content', async () => {
    const app = mockApp as unknown as { getMemoryScope: ReturnType<typeof vi.fn> };
    app.getMemoryScope.mockResolvedValueOnce({
      summary: { text: 'Project discussion channel' },
      facts: [{ text: 'Deadline is Friday' }],
    });

    // Reset the prompt mock to return a fresh generator each time
    mockSession.prompt.mockReturnValue(
      (async function* () {
        /* empty */
      })(),
    );

    await callInjectContext(instance, convId, mockSession);

    expect(mockSession.prompt).toHaveBeenCalledWith(
      expect.stringContaining('Additional context loaded for this conversation'),
      convId,
    );
  });

  it('does not inject prompt when no memory exists', async () => {
    // Default mock returns empty data — no sections to inject
    await callInjectContext(instance, convId, mockSession);

    expect(mockSession.prompt).not.toHaveBeenCalled();
  });

  it('gracefully handles getMemory failures', async () => {
    const app = mockApp as unknown as { getMemoryScope: ReturnType<typeof vi.fn> };
    app.getMemoryScope.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await expect(callInjectContext(instance, convId, mockSession)).resolves.toBeUndefined();

    // IDs should still be tracked (so we don't retry)
    expect(getInjectedConversationIds(instance).has(convId)).toBe(true);
  });
});

describe('SingleSessionAgentInstance — routing', () => {
  it('routes all event types to the same shared slot', () => {
    const instance = createInstance();
    const getSlot = (instance as unknown as Record<string, Function>)['getOrCreateSharedSessionSlot']!;

    const members = new Map<string, Map<string, MemberRecord>>();
    const mockApp = createMockApp('owner-1', members);
    setApp(instance, mockApp);

    // All calls should return the same slot
    const slot1 = getSlot.call(instance);
    const slot2 = getSlot.call(instance);
    expect(slot1).toBe(slot2);
  });
});
