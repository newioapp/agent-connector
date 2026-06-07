/**
 * Serialize / parse a per-agent `.env` file.
 *
 * Reading uses `dotenv.parse`, so hand-edited files (via `newio agent env edit`)
 * in standard dotenv syntax — quotes, comments, `export` prefix — are accepted.
 *
 * Writing prefers single quotes, which dotenv treats as fully literal (spaces,
 * `#`, `=`, `"`, `\`, and newlines all survive untouched). The only thing single
 * quotes can't hold is a literal single quote, so values containing one fall
 * back to double quotes where dotenv expands `\n`/`\r`. Values made entirely of
 * safe characters are written bare. All forms round-trip through `dotenv.parse`.
 */
import { join } from 'path';
import dotenv from 'dotenv';

/** Absolute path of an agent's `.env` file within a data directory. */
export function agentEnvFilePath(dataDir: string, agentId: string): string {
  return join(dataDir, 'envs', `${agentId}.env`);
}

/** Values made only of these characters are safe to write without quoting. */
const SAFE_VALUE = /^[A-Za-z0-9_./@:+,=-]+$/;

function formatValue(value: string): string {
  if (value.length > 0 && SAFE_VALUE.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    // Single quotes are literal in dotenv — nothing inside needs escaping.
    return `'${value}'`;
  }
  // Contains a single quote: use double quotes; only \n and \r are interpreted.
  return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
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
