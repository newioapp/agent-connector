import { describe, it, expect, vi } from 'vitest';
import type { PromptFormatter } from '../../src/core/prompt-formatter';
import { PromptManager, UnsupportedPromptFormatterVersion } from '../../src/core/prompt-manager';
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/sdk';

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
  describe('version compatibility', () => {
    it('finds formatter with same major version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      pm.assertPromptFormatterVersion('1.2.3');
    });

    it('finds formatter when minor/patch differ', () => {
      const v1 = mockFormatter('1.5.0');
      const pm = new PromptManager([v1], v1);
      pm.assertPromptFormatterVersion('1.0.0');
    });

    it('throws for incompatible major version', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.assertPromptFormatterVersion('2.0.0')).toThrow(UnsupportedPromptFormatterVersion);
    });

    it('selects correct formatter from multiple', () => {
      const v1 = mockFormatter('1.0.0');
      const v2 = mockFormatter('2.0.0');
      const pm = new PromptManager([v1, v2], v2);
      pm.assertPromptFormatterVersion('1.3.0');
      pm.assertPromptFormatterVersion('2.1.0');
    });

    it('throws for invalid version string', () => {
      const v1 = mockFormatter('1.0.0');
      const pm = new PromptManager([v1], v1);
      expect(() => pm.assertPromptFormatterVersion('abc')).toThrow(UnsupportedPromptFormatterVersion);
    });

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
