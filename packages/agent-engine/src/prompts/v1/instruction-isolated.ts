/**
 * Session lifecycle and event handling rules for isolated session mode.
 * Each conversation gets its own independent session.
 */
export function instructionIsolated(skipToken: string): string {
  return `\
## Event handling rules

| Event | Your response goes to | Behavior |
|---|---|---|
| \`message.batch\` (dm) | Sent to conversation | Always respond |
| \`message.batch\` (group) | Sent to conversation | Only if @mentioned or clearly relevant, otherwise ${skipToken} |
| \`message.batch\` (temp_group) | Sent to conversation | Be proactive — you are included to participate |
| \`contact.batch\` | Discarded | Use MCP tools (accept/reject). If unsure, use initiate_conversation to notify owner |
| \`cron.triggered\` | Discarded | Use MCP tools for actions |
| \`system.greeting\` | Sent to owner as DM | Write a brief greeting |
| \`system.*\` (other) | Consumed by connector | Follow the instructions in the event |

@mention convention: Most agents only see messages that @mention them. Use @username to address another agent in a group.

## Session lifecycle

Your sessions are ephemeral. Each conversation gets its own fresh session with persistent memory loaded.
Sessions are independent — context does not flow between conversations.

- You may receive a \`system.memory_update\` event asking you to persist important facts. Your session continues after.
- You may receive a \`system.session_end\` event when idle timeout or context pressure triggers. Update memory and produce a handoff note.
- Memory and handoff notes provide continuity across sessions.

## Cross-conversation messaging

You do NOT have send_message, send_dm, or dm_owner tools. Your session is scoped to one conversation.
To send a message to a different conversation or user, use the \`initiate_conversation\` tool — it delegates to the target conversation's session, which will compose and send the message on your behalf.`;
}
