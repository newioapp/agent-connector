/**
 * Share-context prompt — context handed in from another of the agent's own sessions via the
 * share_context MCP tool. Unlike initiate-conversation, the receiving session ABSORBS the context:
 * its text reply is NOT sent anywhere. If it needs to message someone it must use send_dm /
 * send_message explicitly.
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
Another one of your sessions shared the context above with this conversation. Absorb it so you can
use it when you next act here — it becomes part of what you know about this conversation.

Do NOT reply here: your text output for this event is discarded, not sent to anyone. If the shared
context means you should message someone right now, call send_dm or send_message explicitly.
Otherwise, output <done action="absorbed shared context" />.
</instructions>
</event>`;
}
