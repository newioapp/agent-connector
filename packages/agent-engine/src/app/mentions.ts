/**
 * MentionResolver — parses @username, @everyone, @here from message text.
 *
 * Extracted from NewioApp for testability. Pure logic — no I/O.
 */
import type { Mentions } from '@newio/agent-sdk';

// Username grammar — must stay in sync with the canonical USERNAME_REGEX in
// @conduit/shared and the desktop mention parser: starts with a letter, letters/
// numbers/single internal underscores, no trailing or repeated underscore, 3–24 chars.
const USERNAME = '[a-zA-Z](?:[a-zA-Z0-9]|_(?=[a-zA-Z0-9])){1,22}[a-zA-Z0-9]';
// Reject a match that runs into another username char, or a `.`/`-` joined to one
// (so `@alice.bob`, `@here-now`, `@user__name` don't partially match).
const TOKEN_BOUNDARY = '(?![a-zA-Z0-9_]|[.-][a-zA-Z0-9_])';
const MENTION_PREFIX = '(?:^|[\\s])@';

/** Extract all @username tokens from a message (preceded by whitespace or start-of-line). */
const MENTION_EXTRACT_RE = new RegExp(`${MENTION_PREFIX}(${USERNAME})${TOKEN_BOUNDARY}`, 'g');
const EVERYONE_RE = new RegExp(`${MENTION_PREFIX}everyone${TOKEN_BOUNDARY}`);
const HERE_RE = new RegExp(`${MENTION_PREFIX}here${TOKEN_BOUNDARY}`);

/**
 * Parse @mentions from text and resolve usernames to userIds using the member list.
 *
 * @param text - The message text to scan.
 * @param members - Conversation members with userId and optional username.
 * @returns A Mentions object, or undefined if no mentions found.
 */
export function buildMentions(
  text: string,
  members: ReadonlyArray<{ readonly userId: string; readonly username?: string }>,
): Mentions | undefined {
  const everyone = EVERYONE_RE.test(text);
  const here = HERE_RE.test(text);

  const usernameToUserId = new Map<string, string>();
  for (const m of members) {
    if (m.username) {
      usernameToUserId.set(m.username.toLowerCase(), m.userId);
    }
  }

  const userIds: string[] = [];
  for (const match of text.matchAll(MENTION_EXTRACT_RE)) {
    const name = match[1]?.toLowerCase();
    if (!name || name === 'everyone' || name === 'here') {
      continue;
    }
    const userId = usernameToUserId.get(name);
    if (userId && !userIds.includes(userId)) {
      userIds.push(userId);
    }
  }

  if (!everyone && !here && userIds.length === 0) {
    return undefined;
  }
  return {
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(everyone ? { everyone: true } : {}),
    ...(here ? { here: true } : {}),
  };
}
