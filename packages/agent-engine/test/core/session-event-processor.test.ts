import { describe, it, expect, vi } from 'vitest';
import { SessionEventProcessorImpl } from '../../src/session-event-processor-impl';
import type { NewioAppForSessionEventProcessor } from '../../src/session-event-processor-impl';
import { AgentPromptError } from '../../src/errors';
import { ForbiddenApiError } from '@newio/agent-sdk';
import type { AgentSession } from '../../src/agent-session';
import type { PromptManager } from '../../src/prompt-manager';
import type { SessionStreamSegment } from '../../src/types';
import type { IncomingMessage } from '../../src/app/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockApp(): NewioAppForSessionEventProcessor {
  return {
    identity: { userId: 'agent-1', username: 'test_agent', displayName: 'Test Agent', ownerId: 'owner-1' },
    getConversationControls: vi.fn().mockResolvedValue({ showToolCalls: false, showThoughts: false }),
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
    buildShareContextPrompt: vi.fn().mockReturnValue('share context'),
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
      (app.getConversationControls as ReturnType<typeof vi.fn>).mockResolvedValue({
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

    it('re-reads capability controls each segment so a mid-turn toggle affects later segments', async () => {
      const app = createMockApp();
      // showThoughts is on for the first thought segment, then toggled off mid-turn.
      (app.getConversationControls as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ showToolCalls: false, showThoughts: true })
        .mockResolvedValueOnce({ showToolCalls: false, showThoughts: false });
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = {
        ...createMockSession(),
        prompt: vi.fn(async function* () {
          yield { type: 'agent_thought_chunk', text: 'First thought' };
          yield { type: 'agent_thought_chunk', text: 'Second thought' };
          yield { type: 'agent_message_chunk', text: 'Done' };
        }),
      } as unknown as AgentSession;

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      // First thought sent (capability on); second suppressed (toggled off mid-turn);
      // the normal message still goes through.
      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'First thought', {
        metadata: { type: 'agent_thought' },
        visibleTo: ['owner-1'],
      });
      expect(app.sendMessage).not.toHaveBeenCalledWith('conv-1', 'Second thought', expect.anything());
      expect(app.sendMessage).toHaveBeenCalledWith('conv-1', 'Done');
    });
  });

  describe('processEvent — messages error handling', () => {
    /** A session whose prompt() yields the given segments then optionally throws. */
    function sessionThatThrows(throwErr: unknown, segments: SessionStreamSegment[] = []): AgentSession {
      return {
        ...createMockSession(),
        prompt: vi.fn(async function* () {
          for (const seg of segments) {
            yield seg;
          }
          throw throwErr;
        }),
      } as unknown as AgentSession;
    }

    it('posts an owner-only agent_error notice when the agent prompt fails', async () => {
      const app = createMockApp();
      const processor = new SessionEventProcessorImpl('[test]', app, createMockPromptManager());
      const session = sessionThatThrows(new AgentPromptError('Prompt failed: boom', new Error('boom detail')));

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).toHaveBeenCalledTimes(1);
      const [conversationId, text, opts] = (app.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(conversationId).toBe('conv-1');
      expect(text).toContain("Hit an internal error and couldn't finish that turn");
      expect(text).toContain('boom detail');
      expect(opts).toEqual({ metadata: { type: 'agent_error' }, visibleTo: ['owner-1'] });
      expect(app.setStatus).toHaveBeenCalledWith('idle', 'conv-1');
    });

    it('truncates a very long error detail in the owner notice', async () => {
      const app = createMockApp();
      const processor = new SessionEventProcessorImpl('[test]', app, createMockPromptManager());
      const longDetail = 'x'.repeat(2000);
      const session = sessionThatThrows(new AgentPromptError('Prompt failed', new Error(longDetail)));

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      const text = (app.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
      // The full 2000-char detail must not pass through verbatim; it's capped and ellipsized.
      expect(text).not.toContain(longDetail);
      expect(text).toContain('…');
      expect(text.length).toBeLessThan(700);
    });

    it('does NOT post an agent_error notice when the failure is not from the agent prompt (e.g. sendMessage 403)', async () => {
      const app = createMockApp();
      const forbidden = new ForbiddenApiError('You do not have permission to send messages in this conversation.', {
        errorCode: 'FORBIDDEN',
      });
      (app.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(forbidden);
      const processor = new SessionEventProcessorImpl('[test]', app, createMockPromptManager());
      const session = createMockSession('reply');

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      // Only the original (failed) reply attempt — no second agent_error message.
      expect(app.sendMessage).toHaveBeenCalledTimes(1);
      expect((app.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBeUndefined();
    });

    it('does not post an agent_error notice when the owner is not a member', async () => {
      const app = createMockApp();
      (app.isConversationMember as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const processor = new SessionEventProcessorImpl('[test]', app, createMockPromptManager());
      const session = sessionThatThrows(new AgentPromptError('Prompt failed: boom', new Error('boom')));

      await processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session);

      expect(app.sendMessage).not.toHaveBeenCalled();
    });

    it('swallows a failure to deliver the agent_error notice (turn still ends idle)', async () => {
      const app = createMockApp();
      (app.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notice delivery failed'));
      const processor = new SessionEventProcessorImpl('[test]', app, createMockPromptManager());
      const session = sessionThatThrows(new AgentPromptError('Prompt failed: boom', new Error('boom')));

      await expect(
        processor.processEvent({ type: 'messages', conversationId: 'conv-1', messages: [makeMessage()] }, session),
      ).resolves.toBeUndefined();
      expect(app.setStatus).toHaveBeenCalledWith('idle', 'conv-1');
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

  describe('processEvent — share_context', () => {
    it('absorbs shared context without sending a message', async () => {
      const app = createMockApp();
      const promptManager = createMockPromptManager();
      const processor = new SessionEventProcessorImpl('[test]', app, promptManager);
      const session = createMockSession('Got it, will keep that in mind.');

      await processor.processEvent(
        { type: 'share_context', conversationId: 'conv-1', context: 'owner wants the migration done by Friday' },
        session,
      );

      // share_context injects the context but the agent's text reply is NOT sent anywhere.
      expect(promptManager.buildShareContextPrompt).toHaveBeenCalledWith(
        '1.0.0',
        'owner wants the migration done by Friday',
      );
      expect(app.sendMessage).not.toHaveBeenCalled();
    });
  });
});
