import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SharedSessionManager } from '../../src/shared-session-manager';
import type { AgentSession } from '../../src/agent-session';
import type { SessionEventProcessor, NewioAppForSession } from '../../src/types';
import type { PromptManager } from '../../src/prompt-manager';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '../../src/app/index.js';
import { SHARED_SESSION_ID } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSession(correlationId = 'session-1', resumed = false): AgentSession {
  return {
    correlationId,
    type: 'conversation',
    externalReferenceId: SHARED_SESSION_ID,
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
      sessionType: 'conversation',
      externalReferenceId: SHARED_SESSION_ID,
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
    isSkip: vi.fn().mockReturnValue(false),
    skipToken: vi.fn().mockReturnValue('_skip'),
  } as unknown as PromptManager;
}

function makeMessage(conversationId: string, senderId = 'user-1'): IncomingMessage {
  return {
    messageId: 'msg-1',
    conversationId,
    conversationType: 'dm',
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

function makeCronEvent(): CronTriggerEvent {
  return { cronId: 'cron-1', label: 'Daily check', triggeredAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedSessionManager', () => {
  let manager: SharedSessionManager;
  let eventProcessor: SessionEventProcessor;
  let mockSession: AgentSession;
  let newSessionFn: ReturnType<typeof vi.fn>;
  let endSessionFn: ReturnType<typeof vi.fn>;
  let app: NewioAppForSession;

  beforeEach(() => {
    eventProcessor = createMockEventProcessor();
    mockSession = createMockSession();
    newSessionFn = vi.fn().mockResolvedValue(mockSession);
    endSessionFn = vi.fn().mockResolvedValue(undefined);
    const promptManager = createMockPromptManager();
    app = createMockApp();

    manager = new SharedSessionManager(
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
    it('routes all messages to the single shared session with SHARED_SESSION_ID', async () => {
      const msg = makeMessage('conv-a');
      manager.routeInboundEvent({ type: 'message', msg });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });

    it('routes messages from different conversations to the same session', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-b') });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledTimes(1));
    });

    it('routes contact events to the shared session', async () => {
      manager.routeInboundEvent({ type: 'contact', event: makeContactEvent() });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });

    it('routes cron events to the shared session', async () => {
      manager.routeInboundEvent({ type: 'cron', event: makeCronEvent() });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', SHARED_SESSION_ID, true));
    });
  });

  describe('shared injection state', () => {
    it('persists the injected scopes after injecting a new conversation', async () => {
      (app.getConversationMemberIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-new') });

      await vi.waitFor(() => expect(app.persistSharedInjectionState).toHaveBeenCalledWith(['conv-new'], []));
    });

    it('hydrates injected sets from persisted state on resume and skips re-injection', async () => {
      // Persisted state says conv-x was already injected; the resumed session holds it.
      (app.loadSharedInjectionState as ReturnType<typeof vi.fn>).mockReturnValue({
        conversationIds: ['conv-x'],
        userIds: [],
      });
      newSessionFn.mockResolvedValue(createMockSession('resumed-1', true));

      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-x') });

      await vi.waitFor(() => expect(app.loadSharedInjectionState).toHaveBeenCalled());
      // conv-x was hydrated, so its memory is never re-fetched/injected.
      expect(app.getMemoryScope).not.toHaveBeenCalledWith('conversation', 'conv-x');
    });
  });

  describe('getLiveSessionInfo', () => {
    it('returns not live when no session exists', () => {
      const info = manager.getLiveSessionInfo({ sessionType: 'conversation', externalReferenceId: 'conv-a' });
      expect(info.isLive).toBe(false);
      expect(info.externalReferenceId).toBe(SHARED_SESSION_ID);
    });

    it('returns session info with SHARED_SESSION_ID regardless of requested conversation', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalled());

      const info = manager.getLiveSessionInfo({ sessionType: 'conversation', externalReferenceId: 'conv-b' });
      expect(info.isLive).toBe(true);
      expect(info.externalReferenceId).toBe(SHARED_SESSION_ID);
      // The shared singleton's model/mode config lives on the owner DM, not SHARED_SESSION_ID.
      expect(info.originSessionReference).toEqual({
        sessionType: 'conversation',
        externalReferenceId: 'owner-dm-conv',
      });
    });
  });

  describe('handleCancelSession — conversation-aware', () => {
    it('returns session_not_live when no session exists', async () => {
      const result = await manager.handleCancelSession({ sessionType: 'conversation', externalReferenceId: 'conv-a' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('session_not_live');
    });

    it('returns not_active_for_conversation when session is idle', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(eventProcessor.processEvent).toHaveBeenCalled());

      // After processing completes, session is idle
      const result = await manager.handleCancelSession({ sessionType: 'conversation', externalReferenceId: 'conv-a' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('not_active_for_conversation');
    });

    it('returns not_active_for_conversation when session is processing a different conversation', async () => {
      // Make processEvent block so we can test mid-processing
      let resolveProcessing: (() => void) | undefined;
      (eventProcessor.processEvent as ReturnType<typeof vi.fn>).mockImplementation(
        (_event: unknown, session: AgentSession) =>
          new Promise<void>((resolve) => {
            // Simulate the session tracking the active conversation
            (session as unknown as { currentConversationId: string | undefined }).currentConversationId = 'conv-a';
            resolveProcessing = () => {
              (session as unknown as { currentConversationId: string | undefined }).currentConversationId = undefined;
              resolve();
            };
          }),
      );

      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(eventProcessor.processEvent).toHaveBeenCalled());

      // Session is now processing conv-a, try to cancel conv-b
      const result = await manager.handleCancelSession({ sessionType: 'conversation', externalReferenceId: 'conv-b' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('not_active_for_conversation');

      resolveProcessing?.();
    });

    it('cancels successfully when session is processing the target conversation', async () => {
      let resolveProcessing: (() => void) | undefined;
      (eventProcessor.processEvent as ReturnType<typeof vi.fn>).mockImplementation(
        (_event: unknown, session: AgentSession) =>
          new Promise<void>((resolve) => {
            (session as unknown as { currentConversationId: string | undefined }).currentConversationId = 'conv-a';
            resolveProcessing = () => {
              (session as unknown as { currentConversationId: string | undefined }).currentConversationId = undefined;
              resolve();
            };
          }),
      );

      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(eventProcessor.processEvent).toHaveBeenCalled());

      // Session is processing conv-a, cancel conv-a
      const result = await manager.handleCancelSession({ sessionType: 'conversation', externalReferenceId: 'conv-a' });
      expect(result.success).toBe(true);

      resolveProcessing?.();
    });
  });

  describe('handoff notes', () => {
    it('loads handoff from SHARED_SESSION_ID at launch', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(app.getHandoffNote).toHaveBeenCalledWith(SHARED_SESSION_ID));
    });
  });

  describe('config loading', () => {
    it('loads session config from owner DM at launch', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(app.getConversationControls).toHaveBeenCalledWith('owner-dm-conv'));
    });

    it('applies config from owner DM when available', async () => {
      (app.getConversationControls as ReturnType<typeof vi.fn>).mockResolvedValue({
        acpModel: 'claude-4',
        acpMode: 'agent',
      });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() =>
        expect(mockSession.applySessionConfig).toHaveBeenCalledWith({ acpModel: 'claude-4', acpMode: 'agent' }),
      );
    });
  });

  describe('applySessionConfigUpdate', () => {
    it('applies config to the singleton session regardless of which conversation triggered it', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalled());

      await manager.applySessionConfigUpdate({
        sessionType: 'conversation',
        externalReferenceId: 'conv-other',
        updates: { acpModel: 'new-model' },
      });

      expect(mockSession.applySessionConfig).toHaveBeenCalledWith({ acpModel: 'new-model' });
    });

    it('ignores config changes when session is not active', async () => {
      await manager.applySessionConfigUpdate({
        sessionType: 'conversation',
        externalReferenceId: 'conv-other',
        updates: { acpModel: 'new-model' },
      });

      expect(mockSession.applySessionConfig).not.toHaveBeenCalled();
    });
  });
});
