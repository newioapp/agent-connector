import { describe, it, expect } from 'vitest';
import { AcpSlashCommandHandler } from '../../src/core/acp-slash-command-handler';
import type * as acp from '@agentclientprotocol/sdk';

function makeUpdate(commands: acp.AvailableCommand[]): acp.SessionUpdate {
  return {
    sessionUpdate: 'available_commands_update',
    availableCommands: commands,
  } as acp.SessionUpdate;
}

describe('AcpSlashCommandHandler', () => {
  describe('listCommands', () => {
    it('returns empty array initially', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      expect(handler.listCommands()).toEqual([]);
    });

    it('caches commands from available_commands_update', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(
        makeUpdate([
          { name: 'compact', description: 'Compact context' },
          { name: 'web', description: 'Search the web', input: { hint: 'query' } },
        ]),
      );

      expect(handler.listCommands()).toEqual([
        { name: 'compact', description: 'Compact context', inputHint: undefined },
        { name: 'web', description: 'Search the web', inputHint: 'query' },
      ]);
    });

    it('replaces commands on subsequent updates', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'compact', description: 'v1' }]));
      handler.handleSessionUpdate(makeUpdate([{ name: 'test', description: 'Run tests' }]));

      expect(handler.listCommands()).toEqual([{ name: 'test', description: 'Run tests', inputHint: undefined }]);
    });
  });

  describe('isCompactSupported', () => {
    it('returns false when no commands', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      expect(handler.isCompactSupported()).toBe(false);
    });

    it('returns true when compact command is available', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'compact', description: 'Compact context' }]));
      expect(handler.isCompactSupported()).toBe(true);
    });

    it('returns false when only non-compact commands are available', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'web', description: 'Search' }]));
      expect(handler.isCompactSupported()).toBe(false);
    });

    it('returns false after commands are cleared', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'compact', description: 'Compact' }]));
      handler.handleSessionUpdate(makeUpdate([]));
      expect(handler.isCompactSupported()).toBe(false);
    });
  });

  describe('getCompactCommandName', () => {
    it('returns undefined when no commands', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      expect(handler.getCompactCommandName()).toBeUndefined();
    });

    it('returns "compact" when compact command is available', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'compact', description: 'Compact context' }]));
      expect(handler.getCompactCommandName()).toBe('compact');
    });

    it('returns undefined when only non-compact commands are available', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      handler.handleSessionUpdate(makeUpdate([{ name: 'web', description: 'Search' }]));
      expect(handler.getCompactCommandName()).toBeUndefined();
    });
  });

  describe('handleSessionUpdate', () => {
    it('returns true for available_commands_update', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      expect(handler.handleSessionUpdate(makeUpdate([]))).toBe(true);
    });

    it('returns false for unrelated updates', () => {
      const handler = new AcpSlashCommandHandler('sess-1');
      expect(handler.handleSessionUpdate({ sessionUpdate: 'agent_message_chunk' } as acp.SessionUpdate)).toBe(false);
      expect(handler.handleSessionUpdate({ sessionUpdate: 'config_option_update' } as acp.SessionUpdate)).toBe(false);
    });
  });
});
