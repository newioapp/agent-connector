import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatSharedSessionManager } from '../../src/chat-shared-session-manager';
import type { AgentSession } from '../../src/agent-session';
import type { SessionEventProcessor, NewioAppForSession, SessionType } from '../../src/types';
import type { PromptManager } from '../../src/prompt-manager';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '../../src/app/index.js';
import type { ConversationType } from '@newio/agent-sdk';
import { SHARED_SESSION_ID } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSession(
  type: SessionType = 'conversation',
  externalReferenceId: string = SHARED_SESSION_ID,
  resumed = false,
): AgentSession {
  return {
    correlationId: `session-${type}-${externalReferenceId}`,
    type,
    externalReferenceId,
    promptFormatterVersion: '1.0.0',
    resumed,
    currentConversationId: undefined as string | undefined,
    prompt: vi.fn(async function* () {
      yield { type: 'agent_message_chunk' as const, text: '' };
    }),
    applySessionConfig: vi.fn().mockResolvedValue(undefined),
    handleCompactSession: vi.fn().mockResolvedValue({ success: true }),
    handleCancelSession: vi.fn().mockResolvedValue({ success: true }),
    getLiveSessionInfo: vi.fn().mockReturnValue({
      sessionType: type,
      externalReferenceId,
      isLive: true,
      availableModels: [],
      availableModes: [],
      canCancel: true,
      canCompact: true,
    }),
    onStatus: vi.fn(),
    onPermissionRequest: vi.fn(),
    onContextPressure: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

function createMockEventProcessor(): SessionEventProcessor {
  return { processEvent: vi.fn().mockResolvedValue(undefined) };
}

function createMockApp(): NewioAppForSession {
  return {
    handlePermissionRequest: vi.fn().mockResolvedValue('allow'),
    loadMemoryForSession: vi.fn().mockResolvedValue({
      global: { summary: null, facts: [] },
      participants: {},
      conversation: { summary: null, facts: [] },
      topUsers: [],
      topConversations: [],
    }),
    getHandoffNote: vi.fn().mockResolvedValue(null),
    putHandoffNote: vi.fn().mockResolvedValue(undefined),
    getConversationControls: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn(),
    getConversationInfo: vi.fn().mockResolvedValue({ type: 'dm' }),
    getMemoryScope: vi.fn().mockResolvedValue({ summary: null, facts: [] }),
    getConversationMemberIds: vi.fn().mockResolvedValue([]),
    getMemberInfo: vi.fn().mockResolvedValue(undefined),
    agentUserId: 'agent-1',
    loadSharedInjectionState: vi.fn().mockReturnValue({ conversationIds: [], userIds: [] }),
    persistSharedInjectionState: vi.fn(),
  };
}

function createMockPromptManager(): PromptManager {
  return {
    defaultVersion: '1.0.0',
    buildNewioInstruction: vi.fn().mockReturnValue({ version: '1.0.0', prompt: 'instruction' }),
    buildGreetingPrompt: vi.fn().mockReturnValue('greeting'),
    buildSessionEndPrompt: vi.fn().mockReturnValue('session end'),
    buildMemoryUpdatePrompt: vi.fn().mockReturnValue('memory update'),
    buildInitiateConversationPrompt: vi.fn().mockReturnValue('initiate'),
    formatMemoryContext: vi.fn().mockReturnValue('memory context'),
    formatMessagePrompt: vi.fn().mockReturnValue('message prompt'),
    formatContactPrompt: vi.fn().mockReturnValue('contact prompt'),
    formatCronPrompt: vi.fn().mockReturnValue('cron prompt'),
    extractHandoff: vi.fn().mockReturnValue(undefined),
    isSkip: vi.fn().mockReturnValue(false),
    skipToken: vi.fn().mockReturnValue('_skip'),
  } as unknown as PromptManager;
}

function makeMessage(
  conversationId: string,
  conversationType: ConversationType = 'dm',
  senderId = 'user-1',
): IncomingMessage {
  return {
    messageId: 'msg-1',
    conversationId,
    conversationType,
    senderUserId: senderId,
    senderUsername: 'user1',
    senderDisplayName: 'User 1',
    senderAccountType: 'human',
    relationship: 'in-contact',
    isOwnMessage: false,
    text: 'Hello',
    timestamp: new Date().toISOString(),
    status: 'new',
  };
}

function makeContactEvent(): ContactEvent {
  return {
    type: 'contact.request_received',
    username: 'new-friend',
    displayName: 'New Friend',
    accountType: 'human',
    timestamp: new Date().toISOString(),
  };
}

function makeCronEvent(cronId = 'cron-1'): CronTriggerEvent {
  return { cronId, label: 'Daily check', triggeredAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatSharedSessionManager', () => {
  let manager: ChatSharedSessionManager;
  let eventProcessor: SessionEventProcessor;
  let newSessionFn: ReturnType<typeof vi.fn>;
  let endSessionFn: ReturnType<typeof vi.fn>;
  let app: NewioAppForSession;

  beforeEach(() => {
    eventProcessor = createMockEventProcessor();
    // Return a session whose type/externalReferenceId reflect the launch request.
    newSessionFn = vi
      .fn()
      .mockImplementation((type: SessionType, extRef: string) =>
        Promise.resolve(createMockSession(type, extRef, false)),
      );
    endSessionFn = vi.fn().mockResolvedValue(undefined);
    const promptManager = createMockPromptManager();
    app = createMockApp();

    manager = new ChatSharedSessionManager(
      '[test]',
      eventProcessor,
      newSessionFn,
      endSessionFn,
      promptManager,
      app,
      'owner-dm-conv',
    );
  });

  afterEach(() => {
    void manager.terminate();
  });

  describe('routeInboundEvent', () => {
    it('routes a DM message to the chat session (SHARED_SESSION_ID)', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-dm', 'dm') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });

    it('routes a group message to the chat session (SHARED_SESSION_ID)', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-group', 'group') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });

    it('shares one chat session across DM and group messages', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-dm', 'dm') });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-group', 'group') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalled());
      // Only the chat slot was created — exactly one launch with SHARED_SESSION_ID.
      const sharedLaunches = newSessionFn.mock.calls.filter((c) => c[1] === SHARED_SESSION_ID);
      expect(sharedLaunches).toHaveLength(1);
    });

    it('routes a work-session (temp_group) message to its own session', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('work-1', 'temp_group') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', 'work-1', true));
    });

    it('gives each work session its own separate session', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('work-1', 'temp_group') });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('work-2', 'temp_group') });
      await vi.waitFor(() => {
        expect(newSessionFn).toHaveBeenCalledWith('conversation', 'work-1', true);
        expect(newSessionFn).toHaveBeenCalledWith('conversation', 'work-2', true);
      });
    });

    it('routes contact events to the chat session', async () => {
      manager.routeInboundEvent({ type: 'contact', event: makeContactEvent() });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });

    it('routes cron events to their own cron session', async () => {
      manager.routeInboundEvent({ type: 'cron', event: makeCronEvent('cron-x') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('cron', 'cron-x', true));
    });
  });

  describe('share_context routing', () => {
    it('routes share_context for a DM/group target to the chat session', async () => {
      (app.getConversationInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'group' });
      manager.routeInboundEvent({ type: 'share_context', conversationId: 'conv-group', context: 'ctx' });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
      // It did NOT create a per-conversation slot for the group.
      expect(newSessionFn).not.toHaveBeenCalledWith('conversation', 'conv-group', true);
    });

    it('routes share_context for a work-session target to that work session', async () => {
      (app.getConversationInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ type: 'temp_group' });
      manager.routeInboundEvent({ type: 'share_context', conversationId: 'work-9', context: 'ctx' });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', 'work-9', true));
    });
  });

  describe('getDmSession', () => {
    it('returns the chat session for any DM (including the owner DM)', async () => {
      const session = await manager.getDmSession('owner-dm-conv');
      expect(session.externalReferenceId).toBe(SHARED_SESSION_ID);
      expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true);
    });
  });

  describe('owner-op routing (getLiveSessionInfo)', () => {
    it('routes SHARED_SESSION_ID to the chat session', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-dm', 'dm') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));

      const info = manager.getLiveSessionInfo({ sessionType: 'conversation', externalReferenceId: SHARED_SESSION_ID });
      expect(info.isLive).toBe(true);
      expect(info.externalReferenceId).toBe(SHARED_SESSION_ID);
      // The chat slot's config lives on the owner DM, not the synthetic SHARED_SESSION_ID.
      expect(info.sessionReference).toEqual({ sessionType: 'conversation', externalReferenceId: 'owner-dm-conv' });
    });

    it('routes a work-session conversationId to its focused session', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('work-7', 'temp_group') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', 'work-7', true));

      const info = manager.getLiveSessionInfo({ sessionType: 'conversation', externalReferenceId: 'work-7' });
      expect(info.isLive).toBe(true);
      expect(info.externalReferenceId).toBe('work-7');
      // A focused work session owns its conversation, so config lives on that conversation itself.
      expect(info.sessionReference).toEqual({ sessionType: 'conversation', externalReferenceId: 'work-7' });
    });

    it('routes a cronId to its cron session', async () => {
      manager.routeInboundEvent({ type: 'cron', event: makeCronEvent('cron-7') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('cron', 'cron-7', true));

      const info = manager.getLiveSessionInfo({ sessionType: 'cron', externalReferenceId: 'cron-7' });
      expect(info.isLive).toBe(true);
      expect(info.externalReferenceId).toBe('cron-7');
      // Cron sessions have no model/mode config home.
      expect(info.sessionReference).toBeUndefined();
    });

    it('reports not-live (and no sessionReference) for an unknown session', () => {
      const info = manager.getLiveSessionInfo({ sessionType: 'cron', externalReferenceId: 'nope' });
      expect(info.isLive).toBe(false);
      expect(info.sessionReference).toBeUndefined();
    });
  });

  describe('terminate', () => {
    it('ends sessions across all three slot collections', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-dm', 'dm') });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('work-1', 'temp_group') });
      manager.routeInboundEvent({ type: 'cron', event: makeCronEvent('cron-1') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledTimes(3));

      await manager.terminate();
      expect(endSessionFn).toHaveBeenCalledTimes(3);
    });
  });
});
