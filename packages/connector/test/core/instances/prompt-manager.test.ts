import { describe, it, expect, vi } from 'vitest';
import { PromptFormatterImpl } from '../../../src/core/prompt-formatter';
import type { PromptFormatter } from '../../../src/core/prompt-formatter';
import { PromptManager, UnsupportedPromptFormatterVersion } from '../../../src/core/prompt-manager';
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
    relationship: 'in-contact',
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
    getOwnerInfo: vi.fn().mockReturnValue({ username: 'nan', displayName: 'Nan' }),
    getContact: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as NewioApp;
}

// ---------------------------------------------------------------------------
// PromptFormatterImpl
// ---------------------------------------------------------------------------

describe('PromptFormatterImpl', () => {
  describe('formatMessagePrompt', () => {
    it('returns empty string for empty array', () => {
      const pf = new PromptFormatterImpl(mockApp());
      expect(pf.formatMessagePrompt([])).toBe('');
    });

    it('formats a single DM message', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([makeMsg()]);
      expect(result).toContain('conversationId: conv-1');
      expect(result).toContain('type: dm');
      expect(result).toContain('username: alice');
      expect(result).toContain('displayName: Alice');
      expect(result).toContain('accountType: human');
      expect(result).toContain('relationship: in-contact');
      expect(result).toContain('message: hello');
      expect(result).toContain('timestamp: "2026-03-17T22:55:41Z"');
    });

    it('batches multiple DM messages from same sender', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([
        makeMsg({ text: 'first' }),
        makeMsg({ text: 'second', messageId: 'msg-2' }),
      ]);
      expect(result).toContain('message: first');
      expect(result).toContain('message: second');
      const usernameMatches = result.match(/username: alice/g);
      expect(usernameMatches).toHaveLength(1);
    });

    it('formats group messages with per-message sender', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([
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
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([makeMsg({ conversationType: 'temp_group', groupName: 'Sprint' })]);
      expect(result).toContain('type: group');
      expect(result).toContain('groupName: Sprint');
    });

    it('uses fallback for missing sender info', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([
        makeMsg({ senderUsername: undefined, senderDisplayName: undefined, senderAccountType: undefined }),
      ]);
      expect(result).toContain('username: unknown');
      expect(result).toContain('displayName: Unknown');
      expect(result).toContain('accountType: unknown');
    });

    it('uses fallback for missing group name', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.formatMessagePrompt([makeMsg({ conversationType: 'group', groupName: undefined })]);
      expect(result).toContain('groupName: Unnamed Group');
    });
  });

  describe('formatContactPrompt', () => {
    it('returns empty string for empty array', () => {
      const pf = new PromptFormatterImpl(mockApp());
      expect(pf.formatContactPrompt([])).toBe('');
    });

    it('formats a single friend request received event', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_received',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        note: 'Hey, let us connect!',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('events:');
      expect(result).toContain('event: contact.request_received');
      expect(result).toContain('username: alice');
      expect(result).toContain('displayName: Alice');
      expect(result).toContain('accountType: human');
      expect(result).toContain('note: "Hey, let us connect!"');
      expect(result).toContain('timestamp: "2026-04-04T10:00:00Z"');
    });

    it('formats multiple contact events in one batch', () => {
      const pf = new PromptFormatterImpl(mockApp());
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
      const result = pf.formatContactPrompt(events);
      expect(result).toContain('event: contact.request_received');
      expect(result).toContain('event: contact.request_accepted');
      expect(result).toContain('username: alice');
      expect(result).toContain('username: bob');
      expect(result).toContain('ownerUsername: charlie');
      expect(result).toContain('ownerDisplayName: Charlie');
    });

    it('includes owner info for agent contacts', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_accepted',
        username: 'helper_bot',
        displayName: 'Helper Bot',
        accountType: 'agent',
        ownerUsername: 'alice',
        ownerDisplayName: 'Alice',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('ownerUsername: alice');
      expect(result).toContain('ownerDisplayName: Alice');
    });

    it('omits owner info for human contacts', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const event: ContactEvent = {
        type: 'contact.removed',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).not.toContain('ownerUsername');
      expect(result).not.toContain('ownerDisplayName');
    });

    it('uses fallback for missing username/displayName', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const event: ContactEvent = {
        type: 'contact.request_rejected',
        username: undefined,
        displayName: undefined,
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('username: unknown');
      expect(result).toContain('displayName: Unknown');
    });
  });

  describe('formatCronPrompt', () => {
    it('formats a cron trigger event', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_abc123',
        newioSessionId: 'session-1',
        label: 'Send daily standup reminder',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).toContain('event: cron.triggered');
      expect(result).toContain('cronId: cron_abc123');
      expect(result).toContain('label: "Send daily standup reminder"');
      expect(result).toContain('triggeredAt: "2026-04-05T09:00:00Z"');
    });

    it('includes payload when present', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        newioSessionId: 'session-1',
        label: 'Check deadlines',
        payload: { conversationId: 'conv-123' },
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).toContain('payload: {"conversationId":"conv-123"}');
    });

    it('omits payload when undefined', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        newioSessionId: 'session-1',
        label: 'Simple task',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).not.toContain('payload');
    });
  });

  describe('buildNewioInstruction', () => {
    it('includes agent identity and returns version', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('"myagent"');
      expect(result.prompt).toContain('"My Agent"');
      expect(result.version).toBe('1.0.0');
    });

    it('includes owner info', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('Your owner is "Nan" (username: nan)');
    });

    it('throws when owner not in contacts', () => {
      const app = mockApp({
        getOwnerInfo: vi.fn().mockImplementation(() => {
          throw new Error('Owner not found in contacts');
        }),
      } as unknown as Partial<NewioApp>);
      const pf = new PromptFormatterImpl(app);
      expect(() => pf.buildNewioInstruction()).toThrow('Owner not found in contacts');
    });

    it('appends custom instructions', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction('Always respond in French.');
      expect(result.prompt).toContain('Always respond in French.');
    });

    it('includes YAML examples and response rules', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('DM example:');
      expect(result.prompt).toContain('Group example:');
      expect(result.prompt).toContain('_skip');
      expect(result.prompt).toContain('@mention convention');
    });

    it('includes contact event instructions', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('Contact events:');
      expect(result.prompt).toContain('contact.request_received');
      expect(result.prompt).toContain('Always respond with _skip');
      expect(result.prompt).toContain('accept_friend_request');
    });

    it('includes cron trigger instructions', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('Cron triggers:');
      expect(result.prompt).toContain('schedule_cron');
      expect(result.prompt).toContain('cron.triggered');
      expect(result.prompt).toContain('Always respond with _skip');
    });
  });

  describe('buildGreetingPrompt', () => {
    it('includes owner name', () => {
      const pf = new PromptFormatterImpl(mockApp());
      const result = pf.buildGreetingPrompt();
      expect(result).toContain('Nan');
      expect(result).toContain('greeting');
    });

    it('throws when owner info unavailable', () => {
      const app = mockApp({
        getOwnerInfo: vi.fn().mockImplementation(() => {
          throw new Error('Owner not found in contacts');
        }),
      } as unknown as Partial<NewioApp>);
      const pf = new PromptFormatterImpl(app);
      expect(() => pf.buildGreetingPrompt()).toThrow('Owner not found in contacts');
    });
  });

  it('has version 1.0.0', () => {
    const pf = new PromptFormatterImpl(mockApp());
    expect(pf.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// PromptManager — version dispatch
// ---------------------------------------------------------------------------

function mockFormatter(version: string): PromptFormatter {
  return {
    version,
    buildNewioInstruction: vi.fn().mockReturnValue({ prompt: `instruction-${version}`, version }),
    buildGreetingPrompt: vi.fn().mockReturnValue(`greeting-${version}`),
    formatMessagePrompt: vi.fn().mockReturnValue(`messages-${version}`),
    formatContactPrompt: vi.fn().mockReturnValue(`contacts-${version}`),
    formatCronPrompt: vi.fn().mockReturnValue(`cron-${version}`),
  };
}

describe('PromptManager', () => {
  describe('findCompatiblePromptFormatter', () => {
    it('finds formatter with same major version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(pm.findCompatiblePromptFormatter('1.2.3')).toBe(v1);
    });

    it('finds formatter when minor/patch differ', () => {
      const v1 = mockFormatter('1.5.0');
      const pm = new PromptManager([v1], v1);
      expect(pm.findCompatiblePromptFormatter('1.0.0')).toBe(v1);
    });

    it('throws for incompatible major version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.findCompatiblePromptFormatter('2.0.0')).toThrow(UnsupportedPromptFormatterVersion);
    });

    it('selects correct formatter from multiple', () => {
      const v1 = mockFormatter('1.0.0');
      const v2 = mockFormatter('2.0.0');
      const pm = new PromptManager([v1, v2], v2);
      expect(pm.findCompatiblePromptFormatter('1.3.0')).toBe(v1);
      expect(pm.findCompatiblePromptFormatter('2.1.0')).toBe(v2);
    });

    it('throws for invalid version string', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.findCompatiblePromptFormatter('abc')).toThrow(UnsupportedPromptFormatterVersion);
    });
  });

  describe('assertPromptFormatterVersion', () => {
    it('does not throw for compatible version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.assertPromptFormatterVersion('1.2.0')).not.toThrow();
    });

    it('throws for incompatible version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.assertPromptFormatterVersion('3.0.0')).toThrow(UnsupportedPromptFormatterVersion);
    });
  });

  describe('delegation', () => {
    it('buildNewioInstruction uses default formatter', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      const result = pm.buildNewioInstruction('custom');
      expect(v1.buildNewioInstruction).toHaveBeenCalledWith('custom');
      expect(result.version).toBe('1.0.0');
    });

    it('buildGreetingPrompt dispatches by version', () => {
      const v1 = mockFormatter('1.0.0');
      const v2 = mockFormatter('2.0.0');
      const pm = new PromptManager([v1, v2], v2);
      pm.buildGreetingPrompt('1.5.0');
      expect(v1.buildGreetingPrompt).toHaveBeenCalled();
      expect(v2.buildGreetingPrompt).not.toHaveBeenCalled();
    });

    it('formatMessagePrompt dispatches by version', () => {
      const v1 = mockFormatter('1.0.0');
      const v2 = mockFormatter('2.0.0');
      const pm = new PromptManager([v1, v2], v2);
      const msgs = [makeMsg()];
      pm.formatMessagePrompt('2.0.0', msgs);
      expect(v2.formatMessagePrompt).toHaveBeenCalledWith(msgs);
      expect(v1.formatMessagePrompt).not.toHaveBeenCalled();
    });

    it('formatContactPrompt dispatches by version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      const events: ContactEvent[] = [];
      pm.formatContactPrompt('1.0.0', events);
      expect(v1.formatContactPrompt).toHaveBeenCalledWith(events);
    });

    it('formatCronPrompt dispatches by version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      const job: CronTriggerEvent = {
        cronId: 'c1',
        newioSessionId: 's1',
        label: 'test',
        triggeredAt: '2026-01-01T00:00:00Z',
      };
      pm.formatCronPrompt('1.0.0', job);
      expect(v1.formatCronPrompt).toHaveBeenCalledWith(job);
    });
  });
});
