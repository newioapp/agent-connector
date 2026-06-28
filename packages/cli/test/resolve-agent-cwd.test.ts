import { describe, it, expect, vi } from 'vitest';
import { isAbsolute } from 'path';
import { resolveAgentCwd, type CwdStat } from '../src/cli/agent-commands';

const aDirectory: CwdStat = { exists: true, isDirectory: true };
const aFile: CwdStat = { exists: true, isDirectory: false };
const missing: CwdStat = { exists: false, isDirectory: false };

describe('resolveAgentCwd', () => {
  it('returns process.cwd() and skips the stat when --cwd is omitted', () => {
    const stat = vi.fn<(p: string) => CwdStat>(() => missing);
    expect(resolveAgentCwd(undefined, stat)).toBe(process.cwd());
    expect(stat).not.toHaveBeenCalled();
  });

  it('resolves a valid directory to an absolute path', () => {
    const stat = vi.fn<(p: string) => CwdStat>(() => aDirectory);
    const result = resolveAgentCwd('some/relative/dir', stat);
    expect(isAbsolute(result)).toBe(true);
    expect(result.endsWith('some/relative/dir')).toBe(true);
    // The stat is performed against the resolved absolute path.
    expect(stat).toHaveBeenCalledWith(result);
  });

  it('leaves an already-absolute directory path intact', () => {
    expect(resolveAgentCwd('/opt/work', () => aDirectory)).toBe('/opt/work');
  });

  it('throws naming the absolute path when the directory does not exist', () => {
    expect(() => resolveAgentCwd('/nope/missing', () => missing)).toThrow('cwd does not exist: /nope/missing');
  });

  it('throws distinguishing a non-directory from a missing path', () => {
    expect(() => resolveAgentCwd('/etc/hosts', () => aFile)).toThrow('cwd is not a directory: /etc/hosts');
  });
});
