import { describe, it, expect, vi } from 'vitest';
import { PromptManager } from '../src/core/instances/prompt-manager';
import type { IncomingMessage, NewioApp } from '@newio/sdk';

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
