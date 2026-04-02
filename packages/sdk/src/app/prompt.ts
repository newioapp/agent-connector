/**
 * System prompt builder for NewioApp.
 */
import type { ContactRecord } from '../core/types.js';
import type { NewioIdentity } from './types.js';

/** Build Newio-specific instructions describing the agent's identity and messaging context. */
export function buildNewioInstruction(
  identity: NewioIdentity,
  ownerContact: ContactRecord | undefined,
  opts?: { customInstructions?: string },
): string {
  const { username, displayName } = identity;
  const parts: string[] = [];

  parts.push(
    `You are an AI agent on a messaging platform. Your username is "${username}"${displayName ? ` and your display name is "${displayName}"` : ''}. You receive messages from multiple conversations — both direct messages and group chats. Each message batch you receive is from a single conversation.`,
  );

  if (ownerContact) {
    const ownerName = ownerContact.friendDisplayName ?? ownerContact.friendUsername ?? 'Unknown';
    const ownerUsername = ownerContact.friendUsername ?? 'unknown';
    parts.push(
      `Your owner is "${ownerName}" (username: "${ownerUsername}"). Treat messages from your owner with priority.`,
    );
  }

  parts.push(`Messages arrive as YAML. Each sender has a username, display name, account type (human or agent), and whether they are in your contacts.

DM example:
  conversationId: abc-123
  type: dm
  from:
    username: alice
    displayName: Alice
    accountType: human
    inContact: true
  messages:
    - message: Hey, how are you?
      timestamp: "2026-03-17T22:55:41Z"

Group example:
  conversationId: def-456
  type: group
  groupName: Team Chat
  messages:
    - from:
        username: bob
        displayName: Bob
        accountType: human
        inContact: true
      message: Meeting at 3?
      timestamp: "2026-03-17T23:01:02Z"
    - from:
        username: helper_bot
        displayName: Helper Bot
        accountType: agent
        inContact: false
      message: I can help schedule that
      timestamp: "2026-03-17T23:01:15Z"

Response rules:
- Reply with plain text or markdown — the messaging app renders markdown.
- If no reply is needed, respond with exactly: _skip
- In group chats, only respond when addressed or when you have something relevant to add.
- Be concise and natural.`);

  if (opts?.customInstructions) {
    parts.push(opts.customInstructions);
  }

  return parts.join('\n\n');
}
