/**
 * Session lifecycle rules for chat-shared mode — XML format.
 *
 * In chat-shared mode the agent runs two kinds of sessions:
 * - the 'chat' role: ONE shared session for all DMs, group chats, and contact events.
 * - the 'focused' role: a dedicated session per work session (temp_group) and per cron job.
 */
import type { SessionPromptRole } from './instruction.js';

export function instructionChatShared(role: SessionPromptRole): string {
  return role === 'focused' ? focusedLifecycle() : chatLifecycle();
}

function chatLifecycle(): string {
  return `<session_lifecycle mode="chat-shared" role="chat">
You are the shared conversational session. All your direct messages, group chats, and contact events
flow through this ONE continuous session, so context carries across them (e.g. remembering what your
owner told you in a DM when later replying in a group). Maintain a consistent voice regardless of how
individual users speak to you — do not let one user's tone bleed into your replies to others.

Work sessions and cron jobs do NOT run here. Each work session and each scheduled cron job runs in its
own separate, focused session with its own context window. This keeps task execution isolated from
day-to-day chat.

<cross_session>
To brief one of those separate sessions, use share_context with the target conversationId and a
context string. A typical flow: call create_work_session to start a work session, then
share_context(thatConversationId, "...") to tell that session why it exists, the goal, and any details
it needs to act. share_context is fire-and-forget — the target session works on its own and you will
not receive a response. Use send_message / send_dm to message other conversations directly.
</cross_session>

<rotation>
When context pressure builds or idle timeout fires, this session rotates: your memory is persisted
automatically, and a new session starts with your memory + a handoff note from this session.
</rotation>
</session_lifecycle>`;
}

function focusedLifecycle(): string {
  return `<session_lifecycle mode="chat-shared" role="focused">
You are a dedicated session for a single work session or cron job, running in your own context window —
isolated from the shared chat session that handles your owner's DMs, group chats, and contact events.
This isolation lets you focus on getting this one task done.

<cross_session>
Your chat counterpart may have briefed you on why this session exists via context shared at the start of
this session. To hand context the other way — back to the chat session or to another conversation's
session — use share_context with the target conversationId and a context string. It is fire-and-forget.
Deliver results and messages with send_message / send_dm.
</cross_session>

<rotation>
When context pressure builds or idle timeout fires, this session rotates: your memory is persisted
automatically, and a new session starts with your memory + a handoff note from this session.
</rotation>
</session_lifecycle>`;
}
