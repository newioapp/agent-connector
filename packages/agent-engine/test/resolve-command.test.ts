import { describe, it, expect } from 'vitest';
import { resolveCommand } from '../src/utils';
import type { AcpConfig } from '../src/types';

const cwd = '/tmp';

describe('resolveCommand', () => {
  describe('defaults (no executablePath override)', () => {
    it('claude-code → claude-agent-acp', () => {
      expect(resolveCommand('claude-code', { cwd })).toEqual({ command: 'claude-agent-acp', args: [] });
    });

    it('codex → codex-acp', () => {
      expect(resolveCommand('codex', { cwd })).toEqual({ command: 'codex-acp', args: [] });
    });

    it('cursor → agent acp', () => {
      expect(resolveCommand('cursor', { cwd })).toEqual({ command: 'agent', args: ['acp'] });
    });

    it('gemini → gemini --acp', () => {
      expect(resolveCommand('gemini', { cwd })).toEqual({ command: 'gemini', args: ['--acp'] });
    });

    it('kiro-cli → kiro-cli acp --trust-all-tools', () => {
      expect(resolveCommand('kiro-cli', { cwd })).toEqual({ command: 'kiro-cli', args: ['acp', '--trust-all-tools'] });
    });

    it('kiro-cli without trust-all-tools', () => {
      expect(resolveCommand('kiro-cli', { cwd, kiroCliTrustAllTools: false })).toEqual({
        command: 'kiro-cli',
        args: ['acp'],
      });
    });

    it('custom without executablePath throws', () => {
      expect(() => resolveCommand('custom', { cwd })).toThrow('No executable path configured');
    });
  });

  describe('executablePath override — single binary token', () => {
    it('overrides a built-in binary while keeping its default args', () => {
      const config: AcpConfig = { cwd, executablePath: '/opt/homebrew/bin/gemini' };
      expect(resolveCommand('gemini', config)).toEqual({ command: '/opt/homebrew/bin/gemini', args: ['--acp'] });
    });

    it('overrides codex binary (no default args)', () => {
      const config: AcpConfig = { cwd, executablePath: '/usr/local/bin/codex-acp' };
      expect(resolveCommand('codex', config)).toEqual({ command: '/usr/local/bin/codex-acp', args: [] });
    });
  });

  describe('executablePath override — binary with extra args (the ENOENT-bug fix)', () => {
    it('codex: extra args are split out, not baked into the binary name', () => {
      const config: AcpConfig = { cwd, executablePath: 'codex-acp --flag' };
      // Previously this produced command="codex-acp --flag" → ENOENT.
      expect(resolveCommand('codex', config)).toEqual({ command: 'codex-acp', args: ['--flag'] });
    });

    it('cursor: keeps the acp subcommand first, appends extra args', () => {
      const config: AcpConfig = { cwd, executablePath: 'agent --verbose' };
      expect(resolveCommand('cursor', config)).toEqual({ command: 'agent', args: ['acp', '--verbose'] });
    });

    it('gemini: appends extra args after the default --acp flag', () => {
      const config: AcpConfig = { cwd, executablePath: 'gemini --yolo' };
      expect(resolveCommand('gemini', config)).toEqual({ command: 'gemini', args: ['--acp', '--yolo'] });
    });

    it('kiro-cli: base args first, then extra args', () => {
      const config: AcpConfig = { cwd, executablePath: 'kiro-cli --debug' };
      expect(resolveCommand('kiro-cli', config)).toEqual({
        command: 'kiro-cli',
        args: ['acp', '--trust-all-tools', '--debug'],
      });
    });

    it('claude-code: a wrapped command splits into binary + args', () => {
      const config: AcpConfig = { cwd, executablePath: 'node wrapper.js' };
      expect(resolveCommand('claude-code', config)).toEqual({ command: 'node', args: ['wrapper.js'] });
    });
  });

  describe('custom', () => {
    it('uses the full invocation as binary + args', () => {
      const config: AcpConfig = { cwd, executablePath: 'my-agent acp --trust' };
      expect(resolveCommand('custom', config)).toEqual({ command: 'my-agent', args: ['acp', '--trust'] });
    });

    it('collapses extra whitespace', () => {
      const config: AcpConfig = { cwd, executablePath: '  my-agent   acp  ' };
      expect(resolveCommand('custom', config)).toEqual({ command: 'my-agent', args: ['acp'] });
    });
  });
});
