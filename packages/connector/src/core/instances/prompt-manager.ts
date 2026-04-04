/**
 * Prompt manager — centralizes all prompt generation for agent sessions.
 *
 * The system instruction (agent identity, messaging conventions) lives in
 * the SDK ({@link NewioApp.buildNewioInstruction}). This module owns the
 * runtime event formatters that produce per-turn prompt text. The message
 * format here must stay in sync with the examples in the system instruction.
 *
 * Will be extended to format other event types (cron tasks, friend
 * requests, notifications, etc.) as the agent platform grows.
 */
import type { IncomingMessage } from '@newio/sdk';

/** Format a batch of incoming messages into a prompt string. */
export function formatMessagePrompt(messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';
  if (isGroup) {
    return formatGroupBatch(first.conversationId, first.groupName, messages);
  }
  return formatDmBatch(first.conversationId, messages);
}

function formatSender(m: IncomingMessage): string {
  return [
    `    username: ${m.senderUsername ?? 'unknown'}`,
    `    displayName: ${m.senderDisplayName ?? 'Unknown'}`,
    `    accountType: ${m.senderAccountType ?? 'unknown'}`,
    `    inContact: ${String(m.inContact)}`,
  ].join('\n');
}

function formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const lines = [`conversationId: ${conversationId}`, `type: dm`, `from:`, formatSender(first), `messages:`];
  for (const m of messages) {
    lines.push(`  - message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}

function formatGroupBatch(
  conversationId: string,
  groupName: string | undefined,
  messages: readonly IncomingMessage[],
): string {
  const lines = [
    `conversationId: ${conversationId}`,
    `type: group`,
    `groupName: ${groupName ?? 'Unnamed Group'}`,
    `messages:`,
  ];
  for (const m of messages) {
    lines.push(`  - from:`);
    lines.push(formatSender(m));
    lines.push(`    message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}
