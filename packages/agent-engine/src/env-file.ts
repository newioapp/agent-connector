/**
 * Serialize / parse a per-agent `.env` file.
 *
 * Reading uses `dotenv.parse`, so hand-edited files (via `newio agent env edit`)
 * in standard dotenv syntax — quotes, comments, `export` prefix — are accepted.
 *
 * Writing chooses, per value, the first dotenv form that provably round-trips:
 *   - bare, for simple values;
 *   - single quotes, which dotenv keeps fully literal but can't hold a `'`;
 *   - double quotes, where dotenv expands `\n`/`\r` (so real newlines are encoded)
 *     but does NOT un-escape `\\` or `\"`;
 *   - an unquoted line, also literal, failing only on `#`, edge whitespace, or
 *     real newlines.
 * Each candidate is checked against `dotenv.parse`, so we never emit something
 * that reads back differently. The rare value dotenv genuinely can't represent
 * (a single quote mixed with a comment marker / newline and a double quote or a
 * backslash-n sequence) throws rather than being silently corrupted.
 */
import { join } from 'path';
import dotenv from 'dotenv';

/** Absolute path of an agent's `.env` file within a data directory. */
export function agentEnvFilePath(dataDir: string, agentId: string): string {
  return join(dataDir, 'agents', agentId, '.env');
}

/** Values made only of these characters are safe to write without quoting. */
const SAFE_VALUE = /^[A-Za-z0-9_./@:+,=-]+$/;

/** Does `_=<candidate>` parse back to exactly `value`? */
function roundTrips(candidate: string, value: string): boolean {
  return dotenv.parse(`_=${candidate}`)['_'] === value;
}

function formatValue(value: string): string {
  if (value.length > 0 && SAFE_VALUE.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    // Single quotes are literal in dotenv and can hold everything but a `'`.
    return `'${value}'`;
  }
  // The value contains a single quote, so single quotes are out. Prefer double
  // quotes (encoding real newlines as \n/\r, which dotenv expands back), then a
  // bare line; keep the first that dotenv reads back unchanged.
  const candidates = [`"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`, value];
  for (const candidate of candidates) {
    if (roundTrips(candidate, value)) {
      return candidate;
    }
  }
  throw new Error(`Env value cannot be represented in dotenv format: ${JSON.stringify(value)}`);
}

/** Serialize env vars to dotenv text, keys sorted for stable diffs. */
export function serializeEnvVars(env: Readonly<Record<string, string>>): string {
  const keys = Object.keys(env).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map((key) => `${key}=${formatValue(env[key] ?? '')}`).join('\n') + '\n';
}

/** Parse dotenv text into env vars. */
export function parseEnvVars(content: string): Record<string, string> {
  return dotenv.parse(content);
}
