import { describe, it, expect } from 'vitest';
import { serializeEnvVars, parseEnvVars, agentEnvFilePath } from '../src/env-file';

describe('env-file serialize/parse', () => {
  it('round-trips a variety of tricky values', () => {
    const env = {
      PLAIN: 'simple',
      PATH: '/usr/bin:/bin',
      SPACES: 'a b c',
      HASH: 'value#withhash',
      EQUALS: 'a=b=c',
      DQUOTE: 'has"dquote',
      SQUOTE: "has'squote",
      NEWLINE: 'line1\nline2',
      BACKSLASH: 'a\\b',
      TAB: 'a\tb',
      EMPTY: '',
    };
    expect(parseEnvVars(serializeEnvVars(env))).toEqual(env);
  });

  it('round-trips single-quote-plus-backslash values', () => {
    const env = {
      WIN_PATH: "C:\\Users\\O'Brien\\dev", // single quote + backslashes (not \n/\r)
      LITERAL_BACKSLASH_N: "a\\nb'", // literal backslash-n next to a single quote
      LITERAL_BACKSLASH_R: "x\\ry'", // literal backslash-r next to a single quote
      SQUOTE_AND_DQUOTE: 'a\'b"c', // both quote kinds
      SQUOTE_REAL_NEWLINE: "a'\nb", // single quote + real newline
    };
    expect(parseEnvVars(serializeEnvVars(env))).toEqual(env);
  });

  it('throws rather than silently corrupting a value dotenv cannot represent', () => {
    // A single quote mixed with a comment marker and a double quote has no
    // lossless dotenv form.
    expect(() => serializeEnvVars({ K: 'a"\'#b' })).toThrow('cannot be represented');
  });

  it('writes safe values unquoted and sorts keys', () => {
    const text = serializeEnvVars({ ZED: 'z', ALPHA: 'a' });
    expect(text).toBe('ALPHA=a\nZED=z\n');
  });

  it('single-quotes values with spaces or special characters', () => {
    expect(serializeEnvVars({ K: 'a b' })).toBe("K='a b'\n");
    expect(serializeEnvVars({ K: 'x#y' })).toBe("K='x#y'\n");
  });

  it('falls back to double quotes when a value contains a single quote', () => {
    const text = serializeEnvVars({ K: "it's" });
    expect(text).toBe('K="it\'s"\n');
    expect(parseEnvVars(text)).toEqual({ K: "it's" });
  });

  it('serializes an empty record to an empty string', () => {
    expect(serializeEnvVars({})).toBe('');
  });

  it('parses hand-edited dotenv syntax (comments, blank lines, export)', () => {
    const text = ['# a comment', '', 'export FOO=bar', 'BAZ = qux', "QUOTED='spaced value'"].join('\n');
    expect(parseEnvVars(text)).toEqual({ FOO: 'bar', BAZ: 'qux', QUOTED: 'spaced value' });
  });

  it('builds the per-agent env path under agents/<id>/', () => {
    expect(agentEnvFilePath('/data', 'abc')).toBe('/data/agents/abc/.env');
  });
});
