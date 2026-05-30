import { describe, it, expect, vi } from 'vitest';
import { SessionEventProcessorImpl } from '../../src/session-event-processor-impl';
import type { NewioAppForSessionEventProcessor } from '../../src/session-event-processor-impl';
import type { AgentSession } from '../../src/agent-session';
import type { PromptManager } from '../../src/prompt-manager';
import type { IncomingMessage } from '@newio/agent-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApp(): NewioAppForSessionEventProcessor {
  return {
    identity: { userId: 'agent-1', username: 'test-agent', displayName: 'Test Agent', ownerId: 'owner-1' },
    getConversationFlags: vi.fn().mockReturnValue({ showToolCalls: false, showThoughts: false }),
    isConversationMember: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn(),
    rotateSession: vi.fn().mockResolvedValue(undefined),
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

function createMockSession(responseText = 'Hello!'): AgentSession {
  return {
    correlationId: 'session-1',
    type: 'conversation',
    externalReferenceId: 'conv-1',
    promptFormatterVersion: '1.0.0',
    currentConversationId: undefined,
    prompt: vi.fn(async function* () {
      yield { type: 'agent_message_chunk', text: responseText };
    }),
  } as unknown as AgentSession;
}

function makeMessage(conversationId = 'conv-1'): IncomingMessage {
  return {
    messageId: 'msg-1',
    conversationId,
    conversationType: 'dm',
    senderUserId: 'user-1',
    senderUsername: 'alice',
    senderDisplayName: 'Alice',
    senderAccountType: 'human',
    relationship: 'in-contact',
    isOwnMessage: false,
    text: 'Hi there',
    timestamp: new Date().toISOString(),
    status: 'new',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventProcessorImpl', () => {
  describe('processEvent — messages', () => {
    it('sends agent response to the conversation', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('Hello!');

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'Hello!');
      expect(app.setStatus).toHaveBeenCalledWith('idle', 'conv-1');
    });

    it('does not send when response is a skip token', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      (promptManager.isSkip as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('_skip');

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).not.toHaveBeenCalled();
      expect(app.setStatus).toHaveBeenCalledWith('idle', 'conv-1');
    });

    it('does not send empty responses', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('');

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).not.toHaveBeenCalled();
    });

    it('sends thoughts when showThoughts is enabled and owner is in conversation', async () => {
      const app = createMockApp();
      (app.getConversationFlags as ReturnType<typeof vi.fn>).mockReturnValue({
        showToolCalls: false,
        showThoughts: true,
      });
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = {
        ...createMockSession(),
        prompt: vi.fn(async function* () {
          yield { type: 'agent_thought_chunk', text: 'Thinking...' };
          yield { type: 'agent_message_chunk', text: 'Hi!' };
        }),
      } as unknown as AgentSession;

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'Thinking...', {
        metadata: { type: 'agent_thought' },
        visibleTo: ['owner-1'],
      });
      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'Hi!');
    });
  });

  describe('processEvent — contact', () => {
    it('processes contact events without sending messages', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('Noted');

      await processor.processEvent(
        {
          type: 'contact',
          events: [
            {
              type: 'contact.request_received',
              username: 'bob',
              displayName: 'Bob',
              accountType: 'human',
              timestamp: new Date().toISOString(),
            },
          ],
        },
        session,
      );

      // Contact responses are discarded (not sent as messages)
      expect(app.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('processEvent — cron', () => {
    it('processes cron events without sending messages', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('Done');

      await processor.processEvent(
        { type: 'cron', job: { cronId: 'cron-1', label: 'Check-in', triggeredAt: new Date().toISOString() } },
        session,
      );

      // Cron responses are discarded
      expect(app.sendMessage).not.toHaveBeenCalled();
    });
  });
});
