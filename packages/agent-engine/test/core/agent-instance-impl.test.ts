import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentInstanceImpl } from '../../src/agent-instance-impl';
import type { AgentConfigManager } from '../../src/agent-config-manager';
import type { AgentInstanceListener } from '../../src/agent-instance';
import type { AgentConfig, SessionConfig } from '../../src/types';
import type { CronStore } from '../../src/cron-store';
import type { EngineConfig } from '../../src/engine-config';
import type { MemberRecord, ConversationListItem } from '@newio/agent-sdk';
import { SHARED_SESSION_ID } from '@newio/agent-sdk';

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

describe('AgentInstanceImpl — MCP bridge wiring rendezvous', () => {
  // The conversation-id getter must be wired regardless of whether the agent's
  // MCP bridge connects DURING `newSession` (kiro/claude) or AFTER it returns
  // (codex-acp). Launches are serialized by the session manager, so exactly one
  // wiring waiter is outstanding and the connection pairs with this launch.
  interface FakeMcpServer {
    setCurrentConversationIdGetter: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }

  function makeMcpServer(): FakeMcpServer {
    return { setCurrentConversationIdGetter: vi.fn(), connect: vi.fn().mockResolvedValue(undefined) };
  }

  function setupForLaunch(instance: AgentInstanceImpl, createSession: ReturnType<typeof vi.fn>): void {
    const rec = instance as unknown as Record<string, unknown>;
    rec['_app'] = { identity: { userId: 'agent-1', username: 'a', displayName: 'A', ownerId: 'owner-1' } };
    rec['_sessionFactory'] = { createSession };
    rec['_promptManager'] = { defaultVersion: 'v1', skipToken: () => '_skip' };
    rec['_mcpSocketPath'] = '/tmp/x.sock';
  }

  function getWiring(instance: AgentInstanceImpl): { resolve: (server: unknown) => void } | undefined {
    return (instance as unknown as Record<string, { resolve: (server: unknown) => void } | undefined>)[
      'pendingMcpWiring'
    ];
  }

  function callLaunch(instance: AgentInstanceImpl, type: string, ref: string): Promise<unknown> {
    const fn = (instance as unknown as Record<string, Function>)['launchSession']!;
    // resume=false → no store lookup; exercises the fresh-create MCP wiring path.
    return fn.call(instance, type, ref, false);
  }

  it('wires the conversation-id getter when the bridge connects during newSession', async () => {
    const instance = createInstance();
    const mcpServer = makeMcpServer();
    const session = { currentConversationId: 'conv-1' };
    // Connection-first: the bridge connects (resolving the waiter) before newSession returns.
    const createSession = vi.fn(() => {
      getWiring(instance)!.resolve(mcpServer);
      return Promise.resolve(session);
    });
    setupForLaunch(instance, createSession);

    const result = await callLaunch(instance, 'conversation', 'conv-1');

    expect(result).toBe(session);
    expect(mcpServer.setCurrentConversationIdGetter).toHaveBeenCalledTimes(1);
    const getter = mcpServer.setCurrentConversationIdGetter.mock.calls[0]![0] as () => string | undefined;
    expect(getter()).toBe('conv-1');
    expect(getWiring(instance)).toBeUndefined();
  });

  it('wires the getter when the bridge connects after newSession returns (codex-acp)', async () => {
    const instance = createInstance();
    const mcpServer = makeMcpServer();
    const session = { currentConversationId: 'conv-2' };
    // Session-first: newSession resolves before the bridge connects.
    const createSession = vi.fn().mockResolvedValue(session);
    setupForLaunch(instance, createSession);

    const launchPromise = callLaunch(instance, 'conversation', 'conv-2');
    // Let createSession resolve, then simulate the bridge connecting on a later tick.
    await Promise.resolve();
    getWiring(instance)!.resolve(mcpServer);

    const result = await launchPromise;

    expect(result).toBe(session);
    expect(mcpServer.setCurrentConversationIdGetter).toHaveBeenCalledTimes(1);
    const getter = mcpServer.setCurrentConversationIdGetter.mock.calls[0]![0] as () => string | undefined;
    expect(getter()).toBe('conv-2');
  });

  it('proceeds without wiring (and clears the waiter) if the bridge never connects', async () => {
    vi.useFakeTimers();
    try {
      const instance = createInstance();
      const session = { currentConversationId: 'conv-3' };
      const createSession = vi.fn().mockResolvedValue(session);
      setupForLaunch(instance, createSession);

      const launchPromise = callLaunch(instance, 'conversation', 'conv-3');
      // Never resolve the waiter; advance past the connect timeout.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await launchPromise;

      expect(result).toBe(session);
      // Waiter cleared so a late connection hits the no-waiter branch instead of
      // mis-binding to a subsequent launch.
      expect(getWiring(instance)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains before the fallback create after a failed resume', async () => {
    vi.useFakeTimers();
    try {
      const instance = createInstance();
      const mcpServer = makeMcpServer();
      const session = { currentConversationId: 'conv-1' };
      const resumeSession = vi.fn().mockRejectedValue(new Error('no such session'));
      const createSession = vi.fn(() => {
        getWiring(instance)!.resolve(mcpServer);
        return Promise.resolve(session);
      });
      const rec = instance as unknown as Record<string, unknown>;
      rec['_app'] = { identity: { userId: 'agent-1', username: 'a', displayName: 'A', ownerId: 'owner-1' } };
      rec['_sessionFactory'] = { resumeSession, createSession };
      rec['_promptManager'] = { defaultVersion: 'v1', skipToken: () => '_skip', assertPromptFormatterVersion: vi.fn() };
      rec['_mcpSocketPath'] = '/tmp/x.sock';
      rec['_sessionStore'] = { get: () => ({ correlationId: 'old', promptFormatterVersion: 'v1' }), set: vi.fn() };

      const fn = (instance as unknown as Record<string, Function>)['launchSession']!;
      const launchPromise = fn.call(instance, 'conversation', 'conv-1', true);

      // Resume fails immediately, but the fallback create must wait out the drain.
      await vi.advanceTimersByTimeAsync(100);
      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(createSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      const result = await launchPromise;
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(result).toBe(session);
    } finally {
      vi.useRealTimers();
    }
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

describe('AgentInstanceImpl — updateConfig persistence routing', () => {
  // Regression guard for #500: the shared singleton (shared mode) and the chat slot (chat-shared
  // mode) are addressed by SHARED_SESSION_ID, which is NOT a backend Conversation. Persisting
  // their corrected config must target the owner DM member record — never SHARED_SESSION_ID,
  // which 404s on the agent-settings endpoint.
  const ownerId = 'owner-1';
  const ownerDmConvId = 'dm-owner-agent';

  function setMcpSocketPath(instance: AgentInstanceImpl, path: string): void {
    (instance as unknown as Record<string, unknown>)['_mcpSocketPath'] = path;
  }

  function setPromptManager(instance: AgentInstanceImpl): void {
    (instance as unknown as Record<string, unknown>)['_promptManager'] = {
      skipToken: () => '__skip__',
    };
  }

  /** Build a session input and return its updateConfig callback plus the updateAgentMemberConfig spy. */
  function buildUpdateConfig(
    instance: AgentInstanceImpl,
    externalReferenceId: string,
  ): { updateConfig: (config: SessionConfig) => Promise<void>; updateAgentMemberConfig: ReturnType<typeof vi.fn> } {
    const updateAgentMemberConfig = vi.fn().mockResolvedValue(undefined);
    setApp(instance, { identity: { userId: 'agent-1', ownerId }, updateAgentMemberConfig });
    setMcpSocketPath(instance, '/tmp/mcp.sock');
    setPromptManager(instance);
    const input = (
      instance as unknown as Record<
        string,
        (t: string, e: string, v: string) => { updateConfig: (c: SessionConfig) => Promise<void> }
      >
    )['buildSessionInput']!.call(instance, 'conversation', externalReferenceId, 'v1');
    return { updateConfig: input.updateConfig, updateAgentMemberConfig };
  }

  let instance: AgentInstanceImpl;

  beforeEach(() => {
    instance = createInstance();
    setOwnerDmConversationId(instance, ownerDmConvId);
  });

  it('routes SHARED_SESSION_ID config writes to the owner DM, not the synthetic id', async () => {
    const { updateConfig, updateAgentMemberConfig } = buildUpdateConfig(instance, SHARED_SESSION_ID);

    await updateConfig({ acpModel: 'opus', acpMode: 'normal' });

    expect(updateAgentMemberConfig).toHaveBeenCalledTimes(1);
    expect(updateAgentMemberConfig).toHaveBeenCalledWith(ownerDmConvId, { acpModel: 'opus', acpMode: 'normal' });
    expect(updateAgentMemberConfig).not.toHaveBeenCalledWith(SHARED_SESSION_ID, expect.anything());
  });

  it('writes a real conversation slot config to its own conversation', async () => {
    const { updateConfig, updateAgentMemberConfig } = buildUpdateConfig(instance, 'conv-real');

    await updateConfig({ acpModel: 'sonnet', acpMode: null });

    expect(updateAgentMemberConfig).toHaveBeenCalledTimes(1);
    expect(updateAgentMemberConfig).toHaveBeenCalledWith('conv-real', { acpModel: 'sonnet', acpMode: null });
  });

  it('skips the write (no throw) when SHARED_SESSION_ID config has no resolved owner DM', async () => {
    setOwnerDmConversationId(instance, undefined as unknown as string);
    const { updateConfig, updateAgentMemberConfig } = buildUpdateConfig(instance, SHARED_SESSION_ID);

    await expect(updateConfig({ acpModel: 'opus', acpMode: null })).resolves.toBeUndefined();

    expect(updateAgentMemberConfig).not.toHaveBeenCalled();
  });
});
