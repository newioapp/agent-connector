/**
 * Initiate conversation prompt — delegated task from another session.
 * Agent outputs reply text (sent to the target conversation).
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
Based on the context above, compose an appropriate message.

Output your message as reply text — it will be delivered to this conversation.
If no message is needed, output <skip reason="..." />.
</instructions>
</event>`;
}
