import { describe, it, expect, vi } from 'vitest';
import { PromptManager } from '../src/core/instances/prompt-manager';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, NewioApp } from '@newio/sdk';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    conversationType: 'dm',
    senderUserId: 'user-1',
    senderUsername: 'alice',
    senderDisplayName: 'Alice',
    senderAccountType: 'human',
    inContact: true,
    isOwnMessage: false,
    text: 'hello',
    timestamp: '2026-03-17T22:55:41Z',
    status: 'new',
    ...overrides,
  };
}

function mockApp(overrides: Partial<NewioApp> = {}): NewioApp {
  return {
    identity: { userId: 'agent-1', username: 'myagent', displayName: 'My Agent', ownerId: 'owner-1' },
    getOwnerDisplayName: vi.fn().mockReturnValue('Nan'),
    getContact: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as NewioApp;
}

describe('PromptManager', () => {
  // ---------------------------------------------------------------------------
  // formatMessagePrompt
  // ---------------------------------------------------------------------------

  describe('formatMessagePrompt', () => {
    it('returns empty string for empty array', () => {
      const pm = new PromptManager(mockApp());
      expect(pm.formatMessagePrompt([])).toBe('');
    });

    it('formats a single DM message', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([makeMsg()]);
      expect(result).toContain('conversationId: conv-1');
      expect(result).toContain('type: dm');
      expect(result).toContain('username: alice');
      expect(result).toContain('displayName: Alice');
      expect(result).toContain('accountType: human');
      expect(result).toContain('inContact: true');
      expect(result).toContain('message: hello');
      expect(result).toContain('timestamp: "2026-03-17T22:55:41Z"');
    });

    it('batches multiple DM messages from same sender', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([
        makeMsg({ text: 'first' }),
        makeMsg({ text: 'second', messageId: 'msg-2' }),
      ]);
      expect(result).toContain('message: first');
      expect(result).toContain('message: second');
      // Sender info appears once (in the from: block), not per message
      const usernameMatches = result.match(/username: alice/g);
      expect(usernameMatches).toHaveLength(1);
    });

    it('formats group messages with per-message sender', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([
        makeMsg({ conversationType: 'group', groupName: 'Team Chat', text: 'hi' }),
        makeMsg({
          conversationType: 'group',
          groupName: 'Team Chat',
          text: 'hey',
          messageId: 'msg-2',
          senderUsername: 'bob',
          senderDisplayName: 'Bob',
        }),
      ]);
      expect(result).toContain('type: group');
      expect(result).toContain('groupName: Team Chat');
      expect(result).toContain('username: alice');
      expect(result).toContain('username: bob');
    });

    it('formats temp_group as group type', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([makeMsg({ conversationType: 'temp_group', groupName: 'Sprint' })]);
      expect(result).toContain('type: group');
      expect(result).toContain('groupName: Sprint');
    });

    it('uses fallback for missing sender info', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([
        makeMsg({ senderUsername: undefined, senderDisplayName: undefined, senderAccountType: undefined }),
      ]);
      expect(result).toContain('username: unknown');
      expect(result).toContain('displayName: Unknown');
      expect(result).toContain('accountType: unknown');
    });

    it('uses fallback for missing group name', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.formatMessagePrompt([makeMsg({ conversationType: 'group', groupName: undefined })]);
      expect(result).toContain('groupName: Unnamed Group');
    });
  });

  // ---------------------------------------------------------------------------
  // formatContactPrompt
  // ---------------------------------------------------------------------------

  describe('formatContactPrompt', () => {
    it('returns empty string for empty array', () => {
      const pm = new PromptManager(mockApp());
      expect(pm.formatContactPrompt([])).toBe('');
    });

    it('formats a single friend request received event', () => {
      const pm = new PromptManager(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_received',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        note: 'Hey, let us connect!',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pm.formatContactPrompt([event]);
      expect(result).toContain('events:');
      expect(result).toContain('event: contact.request_received');
      expect(result).toContain('username: alice');
      expect(result).toContain('displayName: Alice');
      expect(result).toContain('accountType: human');
      expect(result).toContain('note: "Hey, let us connect!"');
      expect(result).toContain('timestamp: "2026-04-04T10:00:00Z"');
    });

    it('formats multiple contact events in one batch', () => {
      const pm = new PromptManager(mockApp());
      const events: ContactEvent[] = [
        {
          type: 'contact.request_received',
          username: 'alice',
          displayName: 'Alice',
          accountType: 'human',
          timestamp: '2026-04-04T10:00:00Z',
        },
        {
          type: 'contact.request_accepted',
          username: 'bob',
          displayName: 'Bob',
          accountType: 'agent',
          ownerUsername: 'charlie',
          ownerDisplayName: 'Charlie',
          timestamp: '2026-04-04T10:01:00Z',
        },
      ];
      const result = pm.formatContactPrompt(events);
      expect(result).toContain('event: contact.request_received');
      expect(result).toContain('event: contact.request_accepted');
      expect(result).toContain('username: alice');
      expect(result).toContain('username: bob');
      expect(result).toContain('ownerUsername: charlie');
      expect(result).toContain('ownerDisplayName: Charlie');
    });

    it('includes owner info for agent contacts', () => {
      const pm = new PromptManager(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_accepted',
        username: 'helper_bot',
        displayName: 'Helper Bot',
        accountType: 'agent',
        ownerUsername: 'alice',
        ownerDisplayName: 'Alice',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pm.formatContactPrompt([event]);
      expect(result).toContain('ownerUsername: alice');
      expect(result).toContain('ownerDisplayName: Alice');
    });

    it('omits owner info for human contacts', () => {
      const pm = new PromptManager(mockApp());
      const event: ContactEvent = {
        type: 'contact.removed',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pm.formatContactPrompt([event]);
      expect(result).not.toContain('ownerUsername');
      expect(result).not.toContain('ownerDisplayName');
    });

    it('uses fallback for missing username/displayName', () => {
      const pm = new PromptManager(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_rejected',
        username: undefined,
        displayName: undefined,
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pm.formatContactPrompt([event]);
      expect(result).toContain('username: unknown');
      expect(result).toContain('displayName: Unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // formatCronPrompt
  // ---------------------------------------------------------------------------

  describe('formatCronPrompt', () => {
    it('formats a cron trigger event', () => {
      const pm = new PromptManager(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_abc123',
        sessionId: 'session-1',
        label: 'Send daily standup reminder',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pm.formatCronPrompt(job);
      expect(result).toContain('event: cron.triggered');
      expect(result).toContain('cronId: cron_abc123');
      expect(result).toContain('label: "Send daily standup reminder"');
      expect(result).toContain('triggeredAt: "2026-04-05T09:00:00Z"');
    });

    it('includes payload when present', () => {
      const pm = new PromptManager(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        sessionId: 'session-1',
        label: 'Check deadlines',
        payload: { conversationId: 'conv-123' },
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pm.formatCronPrompt(job);
      expect(result).toContain('payload: {"conversationId":"conv-123"}');
    });

    it('omits payload when undefined', () => {
      const pm = new PromptManager(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        sessionId: 'session-1',
        label: 'Simple task',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pm.formatCronPrompt(job);
      expect(result).not.toContain('payload');
    });
  });

  // ---------------------------------------------------------------------------
  // buildNewioInstruction
  // ---------------------------------------------------------------------------

  describe('buildNewioInstruction', () => {
    it('includes agent identity', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction();
      expect(result).toContain('"myagent"');
      expect(result).toContain('"My Agent"');
    });

    it('includes owner info when available', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction();
      expect(result).toContain('Your owner is "Nan"');
    });

    it('omits owner info when no owner', () => {
      const app = mockApp({
        identity: { userId: 'a', username: 'bot', displayName: 'Bot' },
        getOwnerDisplayName: vi.fn().mockReturnValue(undefined),
      } as unknown as Partial<NewioApp>);
      const pm = new PromptManager(app);
      const result = pm.buildNewioInstruction();
      expect(result).not.toContain('Your owner');
    });

    it('appends custom instructions', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction('Always respond in French.');
      expect(result).toContain('Always respond in French.');
    });

    it('includes YAML examples and response rules', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction();
      expect(result).toContain('DM example:');
      expect(result).toContain('Group example:');
      expect(result).toContain('_skip');
      expect(result).toContain('@mention convention');
    });

    it('includes contact event instructions', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction();
      expect(result).toContain('Contact events:');
      expect(result).toContain('contact.request_received');
      expect(result).toContain('dm_owner');
      expect(result).toContain('accept_friend_request');
    });

    it('includes cron trigger instructions', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildNewioInstruction();
      expect(result).toContain('Cron triggers:');
      expect(result).toContain('schedule_cron');
      expect(result).toContain('cron.triggered');
    });
  });

  // ---------------------------------------------------------------------------
  // buildGreetingPrompt
  // ---------------------------------------------------------------------------

  describe('buildGreetingPrompt', () => {
    it('includes owner name', () => {
      const pm = new PromptManager(mockApp());
      const result = pm.buildGreetingPrompt();
      expect(result).toContain('Nan');
      expect(result).toContain('greeting');
    });

    it('falls back to "your owner" when no owner name', () => {
      const app = mockApp({ getOwnerDisplayName: vi.fn().mockReturnValue(undefined) } as unknown as Partial<NewioApp>);
      const pm = new PromptManager(app);
      const result = pm.buildGreetingPrompt();
      expect(result).toContain('your owner');
    });
  });
});
