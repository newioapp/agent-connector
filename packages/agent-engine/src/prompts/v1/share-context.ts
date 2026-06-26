/**
 * Share-context prompt — context handed in from another of the agent's own sessions via the
 * share_context MCP tool. The receiving session ABSORBS the context: its text reply is NOT sent
 * anywhere. To say something in this conversation it must call send_message; to reach a different
 * conversation it uses share_context.
 */
export interface ShareContextProps {
  readonly context: string;
}

export function shareContextPrompt({ context }: ShareContextProps): string {
  return `<event type="system.share_context">
<context>
${context}
</context>
<instructions>
Another one of your sessions handed the context above to this conversation. Absorb it so you can use it
when you next act here — it becomes part of what you know about this conversation.

Do NOT reply here: your text output for this event is discarded, not sent to anyone. If you should say
something in THIS conversation right now, call send_message explicitly; to reach a different
conversation, use share_context. Otherwise, output <done action="absorbed shared context" />.
</instructions>
</event>`;
}
