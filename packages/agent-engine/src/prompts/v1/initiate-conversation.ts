/**
 * Initiate conversation prompt — delegated task from another session.
 */
export interface InitiateConversationProps {
  readonly context: string;
  readonly skipToken: string;
}

export function initiateConversationPrompt({ context, skipToken }: InitiateConversationProps): string {
  return `\
event: system.initiate_conversation
context: |
  ${context.split('\n').join('\n  ')}
instructions: |
  Another one of your sessions has delegated a task to this conversation.
  Based on the context above, compose an appropriate message.

  If a message should be sent, output it after "MESSAGE:" on its own line.
  Only the text after MESSAGE: will be delivered.

  If no message is needed, respond with exactly: ${skipToken}`;
}
