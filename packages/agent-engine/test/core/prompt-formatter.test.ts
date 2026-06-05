import { describe, it, expect } from 'vitest';
import { PromptFormatterImpl } from '../../src/prompt-formatter';
import type { PromptFormatterIdentity, PromptFormatterOwner } from '../../src/prompt-formatter';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '../../src/app/index.js';

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

const defaultIdentity: PromptFormatterIdentity = { username: 'myagent', displayName: 'My Agent' };
const defaultOwner: PromptFormatterOwner = { username: 'nan', displayName: 'Nan' };

function mockApp(
  identity: PromptFormatterIdentity = defaultIdentity,
  owner: PromptFormatterOwner = defaultOwner,
): PromptFormatterImpl {
  return new PromptFormatterImpl(identity, owner, 'isolated');
}

describe('PromptFormatterImpl', () => {
  describe('formatMessagePrompt', () => {
    it('returns empty string for empty array', () => {
      const pf = mockApp();
      expect(pf.formatMessagePrompt([])).toBe('');
    });

    it('formats a single DM message in XML', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([makeMsg()]);
      expect(result).toContain('conversation_id="conv-1"');
      expect(result).toContain('conversation_type="dm"');
      expect(result).toContain('username="alice"');
      expect(result).toContain('display_name="Alice"');
      expect(result).toContain('account_type="human"');
      expect(result).toContain('relationship="in-contact"');
      expect(result).toContain('>hello</message>');
      expect(result).toContain('timestamp="2026-03-17T22:55:41Z"');
    });

    it('batches multiple DM messages from same sender', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([
        makeMsg({ text: 'first' }),
        makeMsg({ text: 'second', messageId: 'msg-2' }),
      ]);
      expect(result).toContain('>first</message>');
      expect(result).toContain('>second</message>');
      // Only one <from> element in DM batch
      const fromMatches = result.match(/<from /g);
      expect(fromMatches).toHaveLength(1);
    });

    it('formats group messages with per-message sender', () => {
      const pf = mockApp();
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
      expect(result).toContain('conversation_type="group"');
      expect(result).toContain('group_name="Team Chat"');
      expect(result).toContain('from_username="alice"');
      expect(result).toContain('from_username="bob"');
    });

    it('formats temp_group as work_session type', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([makeMsg({ conversationType: 'temp_group', groupName: 'Sprint' })]);
      expect(result).toContain('conversation_type="work_session"');
      expect(result).toContain('group_name="Sprint"');
    });

    it('uses fallback for missing sender info', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([
        makeMsg({ senderUsername: undefined, senderDisplayName: undefined, senderAccountType: undefined }),
      ]);
      expect(result).toContain('username="unknown"');
      expect(result).toContain('display_name="Unknown"');
      expect(result).toContain('account_type="unknown"');
    });

    it('omits group_name attr when missing', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([makeMsg({ conversationType: 'group', groupName: undefined })]);
      expect(result).not.toContain('group_name=');
    });

    it('formats messages with attachments', () => {
      const pf = mockApp();
      const result = pf.formatMessagePrompt([
        makeMsg({
          text: 'Here is the file',
          attachments: [
            {
              fileName: 'report.pdf',
              contentType: 'application/pdf',
              size: 245000,
              s3Key: 'media/conv-1/report.pdf',
              attachmentType: 'file',
            },
          ],
        }),
      ]);
      expect(result).toContain('<text>Here is the file</text>');
      expect(result).toContain('file_name="report.pdf"');
      expect(result).toContain('content_type="application/pdf"');
      expect(result).toContain('size="245000"');
      expect(result).toContain('s3_key="media/conv-1/report.pdf"');
    });
  });

  describe('formatContactPrompt', () => {
    it('returns empty string for empty array', () => {
      const pf = mockApp();
      expect(pf.formatContactPrompt([])).toBe('');
    });

    it('formats a single friend request received event in XML', () => {
      const pf = mockApp();
      const event: ContactEvent = {
        type: 'contact.request_received',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        note: 'Hey, let us connect!',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('<event type="contact.batch">');
      expect(result).toContain('<contact_event');
      expect(result).toContain('type="contact.request_received"');
      expect(result).toContain('username="alice"');
      expect(result).toContain('display_name="Alice"');
      expect(result).toContain('account_type="human"');
      expect(result).toContain('timestamp="2026-04-04T10:00:00Z"');
      expect(result).toContain('>Hey, let us connect!</contact_event>');
    });

    it('formats multiple contact events in one batch', () => {
      const pf = mockApp();
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
      expect(result).toContain('type="contact.request_received"');
      expect(result).toContain('type="contact.request_accepted"');
      expect(result).toContain('username="alice"');
      expect(result).toContain('username="bob"');
      expect(result).toContain('owner_username="charlie"');
      expect(result).toContain('owner_display_name="Charlie"');
    });

    it('includes owner info for agent contacts', () => {
      const pf = mockApp();
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
      expect(result).toContain('owner_username="alice"');
      expect(result).toContain('owner_display_name="Alice"');
    });

    it('omits owner info for human contacts', () => {
      const pf = mockApp();
      const event: ContactEvent = {
        type: 'contact.removed',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).not.toContain('owner_username');
      expect(result).not.toContain('owner_display_name');
    });

    it('uses fallback for missing username/displayName', () => {
      const pf = mockApp();
      const event: ContactEvent = {
        type: 'contact.request_rejected',
        username: undefined,
        displayName: undefined,
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('username="unknown"');
      expect(result).toContain('display_name="Unknown"');
    });

    it('self-closes contact_event without note', () => {
      const pf = mockApp();
      const event: ContactEvent = {
        type: 'contact.request_received',
        username: 'alice',
        displayName: 'Alice',
        accountType: 'human',
        timestamp: '2026-04-04T10:00:00Z',
      };
      const result = pf.formatContactPrompt([event]);
      expect(result).toContain('/>');
    });
  });

  describe('formatCronPrompt', () => {
    it('formats a cron trigger event in XML', () => {
      const pf = mockApp();
      const job: CronTriggerEvent = {
        cronId: 'cron_abc123',
        label: 'Send daily standup reminder',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).toContain('<event type="cron.triggered"');
      expect(result).toContain('cron_id="cron_abc123"');
      expect(result).toContain('label="Send daily standup reminder"');
      expect(result).toContain('triggered_at="2026-04-05T09:00:00Z"');
    });

    it('includes payload when present', () => {
      const pf = mockApp();
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        label: 'Check deadlines',
        payload: { conversationId: 'conv-123' },
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).toContain('<payload>{"conversationId":"conv-123"}</payload>');
    });

    it('self-closes event without payload', () => {
      const pf = mockApp();
      const job: CronTriggerEvent = {
        cronId: 'cron_xyz',
        label: 'Simple task',
        triggeredAt: '2026-04-05T09:00:00Z',
      };
      const result = pf.formatCronPrompt(job);
      expect(result).toContain('/>');
      expect(result).not.toContain('<payload>');
    });
  });

  describe('buildNewioInstruction', () => {
    it('includes agent identity and returns version', () => {
      const pf = mockApp();
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('"myagent"');
      expect(result.prompt).toContain('"My Agent"');
      expect(result.version).toBe('1.0.0');
    });

    it('includes owner info', () => {
      const pf = mockApp();
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('"Nan" (username: nan)');
    });

    it('appends custom instructions', () => {
      const pf = mockApp();
      const result = pf.buildNewioInstruction('Always respond in French.');
      expect(result.prompt).toContain('Always respond in French.');
      expect(result.prompt).toContain('<custom_instructions>');
    });

    it('includes XML structure with identity and relationships', () => {
      const pf = mockApp();
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('<identity>');
      expect(result.prompt).toContain('<relationships>');
      expect(result.prompt).toContain('<global_rules>');
      expect(result.prompt).toContain('<event_type name="message.batch">');
      expect(result.prompt).toContain('<event_type name="contact.batch">');
      expect(result.prompt).toContain('<event_type name="cron.triggered">');
      expect(result.prompt).toContain('<system_events>');
    });

    it('includes session lifecycle for isolated mode', () => {
      const pf = mockApp();
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('<session_lifecycle mode="isolated">');
      expect(result.prompt).toContain('initiate_conversation');
    });

    it('includes session lifecycle for shared mode', () => {
      const pf = new PromptFormatterImpl(defaultIdentity, defaultOwner, 'shared');
      const result = pf.buildNewioInstruction();
      expect(result.prompt).toContain('<session_lifecycle mode="shared">');
      expect(result.prompt).toContain('send_dm');
    });
  });

  describe('buildGreetingPrompt', () => {
    it('includes greeting instructions in XML', () => {
      const pf = mockApp();
      const result = pf.buildGreetingPrompt();
      expect(result).toContain('<event type="system.greeting">');
      expect(result).toContain('greeting');
    });
  });

  it('has version 1.0.0', () => {
    const pf = mockApp();
    expect(pf.version).toBe('1.0.0');
  });

  describe('isSkip', () => {
    it('returns true for skip/done/handoff tags', () => {
      const pf = mockApp();
      expect(pf.isSkip('<skip reason="no reply needed" />')).toBe(true);
      expect(pf.isSkip('  <skip reason="test" />  ')).toBe(true);
      expect(pf.isSkip('<done action="accepted_request" />')).toBe(true);
      expect(pf.isSkip('<handoff>Some handoff note.</handoff>')).toBe(true);
    });

    it('returns false for non-skip text', () => {
      const pf = mockApp();
      expect(pf.isSkip('hello')).toBe(false);
      expect(pf.isSkip('_skip')).toBe(false);
      expect(pf.isSkip('')).toBe(false);
      expect(pf.isSkip('I will skip that')).toBe(false);
    });
  });

  describe('extractHandoff', () => {
    it('extracts content from handoff tags', () => {
      const pf = mockApp();
      expect(pf.extractHandoff('<handoff>Session was about planning a trip.</handoff>')).toBe(
        'Session was about planning a trip.',
      );
    });

    it('extracts multiline handoff content', () => {
      const pf = mockApp();
      const input = '<handoff>\nLine 1.\nLine 2.\n</handoff>';
      expect(pf.extractHandoff(input)).toBe('Line 1.\nLine 2.');
    });

    it('returns undefined when no handoff tag present', () => {
      const pf = mockApp();
      expect(pf.extractHandoff('<done action="memory_updated" />')).toBeUndefined();
      expect(pf.extractHandoff('plain text')).toBeUndefined();
      expect(pf.extractHandoff('')).toBeUndefined();
    });

    it('is case-insensitive', () => {
      const pf = mockApp();
      expect(pf.extractHandoff('<HANDOFF>Note here.</HANDOFF>')).toBe('Note here.');
      expect(pf.extractHandoff('<Handoff>Mixed case.</Handoff>')).toBe('Mixed case.');
    });

    it('extracts only the first handoff tag', () => {
      const pf = mockApp();
      expect(pf.extractHandoff('<handoff>First.</handoff> extra <handoff>Second.</handoff>')).toBe('First.');
    });
  });
});
