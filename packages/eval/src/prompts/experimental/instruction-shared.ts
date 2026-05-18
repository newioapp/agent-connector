/**
 * Session lifecycle rules for shared (single-session) mode — XML format.
 */
export function instructionShared(): string {
  return `<session_lifecycle mode="shared">
You run in a single persistent session that handles all conversations, contacts, and cron events serially.
Context accumulates across conversations within this session — you will see messages from different conversations interleaved.
This is intentional: it allows you to carry context across interactions (e.g., remembering what your owner told you in a DM when later replying in a group).

Maintain a consistent voice regardless of how individual users speak to you. Do not let one user's tone bleed into your replies to others.

<rotation>
When context pressure builds or idle timeout fires, the session rotates:
- Your memory is persisted automatically.
- A new session starts with your memory + a handoff note from this session.
</rotation>
</session_lifecycle>`;
}
