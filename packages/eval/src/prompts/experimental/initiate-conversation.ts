/**
 * Initiate conversation prompt — delegated task from another session.
 * Agent sends message via tools, then outputs <done />.
 */
export interface InitiateConversationProps {
  readonly context: string;
  readonly skipToken: string;
}

export function initiateConversationPrompt({ context, skipToken: _skipToken }: InitiateConversationProps): string {
  return `<event type="system.initiate_conversation">
<context>
${context}
</context>
<instructions>
Another one of your sessions has delegated a task to this conversation.
Based on the context above, compose and send an appropriate message using send_dm or send_message.

If a message was sent, output <done action="message_sent" />.
If no message is needed, output <skip reason="no action required" />.
</instructions>
</event>`;
}
