/**
 * MentionResolver — parses @username, @everyone, @here from message text.
 *
 * Extracted from NewioApp for testability. Pure logic — no I/O.
 */
import type { Mentions } from '../core/types.js';

/** Extract all @username tokens from a message (preceded by whitespace or start-of-line). */
const MENTION_EXTRACT_RE = /(?:^|[\s])@([a-zA-Z][a-zA-Z0-9]*)/g;

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
  const everyone = /(?:^|[\s])@everyone\b/.test(text);
  const here = /(?:^|[\s])@here\b/.test(text);

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
