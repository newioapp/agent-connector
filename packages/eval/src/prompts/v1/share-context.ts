/**
 * Share-context prompt — context handed in from another of the agent's own sessions. The receiving
 * session ABSORBS the context; its text reply is NOT sent anywhere.
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
Another one of your sessions shared the context above with this conversation. Absorb it for when you
next act here. Do NOT reply: your text output for this event is discarded. If it means you should
message someone now, call send_dm or send_message explicitly; otherwise output <done action="..." />.
</instructions>
</event>`;
}
