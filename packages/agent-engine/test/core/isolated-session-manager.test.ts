import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IsolatedSessionManager } from '../../src/isolated-session-manager';
import type { AgentSession } from '../../src/agent-session';
import type { SessionEventProcessor, NewioAppForSession } from '../../src/types';
import type { PromptManager } from '../../src/prompt-manager';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSession(correlationId = 'session-1'): AgentSession {
  return {
    correlationId,
    type: 'conversation',
    externalReferenceId: 'conv-1',
    promptFormatterVersion: '1.0.0',
    currentConversationId: undefined,
    prompt: vi.fn(async function* () {
      yield { type: 'agent_message_chunk' as const, text: '' };
    }),
    applySessionConfig: vi.fn().mockResolvedValue(undefined),
    handleCompactSession: vi.fn().mockResolvedValue({ success: true }),
    handleCancelSession: vi.fn().mockResolvedValue({ success: true }),
    getLiveSessionInfo: vi.fn().mockReturnValue({
      sessionType: 'conversation',
      externalReferenceId: 'conv-1',
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
    getSessionConfig: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn(),
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
  };
}

function makeCronEvent(): CronTriggerEvent {
  return { cronId: 'cron-1', label: 'Daily check', expression: '0 9 * * *' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IsolatedSessionManager', () => {
  let manager: IsolatedSessionManager;
  let eventProcessor: SessionEventProcessor;
  let mockSession: AgentSession;
  let newSessionFn: ReturnType<typeof vi.fn>;
  let endSessionFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    eventProcessor = createMockEventProcessor();
    mockSession = createMockSession();
    newSessionFn = vi.fn().mockResolvedValue(mockSession);
    endSessionFn = vi.fn().mockResolvedValue(undefined);
    const promptManager = createMockPromptManager();
    const app = createMockApp();

    manager = new IsolatedSessionManager('[test]', eventProcessor, newSessionFn, endSessionFn, promptManager, app);
  });

  afterEach(() => {
    void manager.terminate();
  });

  describe('routeInboundEvent', () => {
    it('routes messages to conversation slots', async () => {
      const msg = makeMessage('conv-a');
      manager.routeInboundEvent({ type: 'message', msg });

      // Session should be created for conv-a
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', 'conv-a'));
    });

    it('routes contact events to the contact slot', async () => {
      const event = makeContactEvent();
      manager.routeInboundEvent({ type: 'contact', event });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('contact', '__contact__'));
    });

    it('routes cron events to cron slots', async () => {
      const event = makeCronEvent();
      manager.routeInboundEvent({ type: 'cron', event });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('cron', 'cron-1'));
    });

    it('routes multiple messages to the same conversation slot', async () => {
      const msg1 = makeMessage('conv-a');
      const msg2 = makeMessage('conv-a');
      manager.routeInboundEvent({ type: 'message', msg: msg1 });
      manager.routeInboundEvent({ type: 'message', msg: msg2 });

      // Should only create one session
      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledTimes(1));
    });

    it('creates separate slots for different conversations', async () => {
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-a') });
      manager.routeInboundEvent({ type: 'message', msg: makeMessage('conv-b') });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledTimes(2));
      expect(newSessionFn).toHaveBeenCalledWith('conversation', 'conv-a');
      expect(newSessionFn).toHaveBeenCalledWith('conversation', 'conv-b');
    });

    it('routes initiate_conversation events', async () => {
      manager.routeInboundEvent({
        type: 'initiate_conversation',
        conversationId: 'conv-new',
        context: 'Please message Alice about the meeting',
      });

      await vi.waitFor(() => expect(newSessionFn).toHaveBeenCalledWith('conversation', 'conv-new'));
    });
  });

  describe('getDmSession', () => {
    it('creates and returns a session for a DM conversation', async () => {
      const session = await manager.getDmSession('dm-conv');

      expect(newSessionFn).toHaveBeenCalledWith('conversation', 'dm-conv');
      expect(session).toBe(mockSession);
    });

    it('reuses existing session on second call', async () => {
      await manager.getDmSession('dm-conv');
      await manager.getDmSession('dm-conv');

      expect(newSessionFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleStartSession', () => {
    it('launches a session for conversation type', async () => {
      const result = await manager.handleStartSession({
        sessionType: 'conversation',
        externalReferenceId: 'conv-x',
      });

      expect(result.success).toBe(true);
      expect(newSessionFn).toHaveBeenCalledWith('conversation', 'conv-x');
    });

    it('rejects non-conversation session types', async () => {
      const result = await manager.handleStartSession({
        sessionType: 'contact',
        externalReferenceId: '__contact__',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('getLiveSessionInfo', () => {
    it('returns not-live for unknown sessions', () => {
      const result = manager.getLiveSessionInfo({
        sessionType: 'conversation',
        externalReferenceId: 'unknown-conv',
      });

      expect(result.isLive).toBe(false);
    });

    it('returns live info for active sessions', async () => {
      await manager.getDmSession('conv-live');

      const result = manager.getLiveSessionInfo({
        sessionType: 'conversation',
        externalReferenceId: 'conv-live',
      });

      expect(result.isLive).toBe(true);
    });
  });

  describe('terminate', () => {
    it('closes all slots and disposes sessions', async () => {
      await manager.getDmSession('conv-1');
      await manager.terminate();

      // Verify session was disposed (dispose called on the mock session)
      // The slot's queue should be closed and no further events processed
      expect(endSessionFn).toHaveBeenCalledWith(mockSession.correlationId);
    });
  });
});
