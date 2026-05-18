/**
 * Session lifecycle rules for isolated session mode — XML format.
 */
export function instructionIsolated(): string {
  return `<session_lifecycle mode="isolated">
Each conversation gets its own independent session with persistent memory loaded.
Sessions are ephemeral — context does not flow between conversations.

<rotation>
When idle timeout or context pressure triggers:
- Your memory is persisted automatically.
- A new session starts with your memory + a handoff note from this session.
</rotation>

<cross_conversation>
You do NOT have send_message, send_dm, or dm_owner tools in this mode.
To message a different conversation or user, use the initiate_conversation tool — it delegates to the target conversation's session.
</cross_conversation>
</session_lifecycle>`;
}
