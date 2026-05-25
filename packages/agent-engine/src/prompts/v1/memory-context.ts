/**
 * Memory context — formats loaded memory into XML injected at session start.
 */
import type { LoadSessionMemoryResponse } from '@newio/agent-sdk';

export interface MemoryContextProps {
  readonly memory: LoadSessionMemoryResponse;
  readonly handoffNote?: string;
}

export function memoryContextPrompt({ memory, handoffNote }: MemoryContextProps): string {
  const sections: string[] = [];

  if (handoffNote) {
    sections.push(`<handoff_note>\n${handoffNote}\n</handoff_note>`);
  }

  // Global memory
  const globalParts: string[] = [];
  if (memory.global.summary) {
    globalParts.push(`  <summary>${memory.global.summary.text}</summary>`);
  }
  for (const fact of memory.global.facts) {
    globalParts.push(`  <fact id="${fact.factId}">${fact.text}</fact>`);
  }
  if (globalParts.length > 0) {
    sections.push(`<global_memory>\n${globalParts.join('\n')}\n</global_memory>`);
  }

  // Per-participant memory
  for (const [userId, data] of Object.entries(memory.participants)) {
    const parts: string[] = [];
    if (data.summary) {
      parts.push(`  <summary>${data.summary.text}</summary>`);
    }
    for (const fact of data.facts) {
      parts.push(`  <fact id="${fact.factId}">${fact.text}</fact>`);
    }
    if (parts.length > 0) {
      sections.push(`<user_memory user_id="${userId}">\n${parts.join('\n')}\n</user_memory>`);
    }
  }

  // Per-conversation memory
  const convParts: string[] = [];
  if (memory.conversation.summary) {
    convParts.push(`  <summary>${memory.conversation.summary.text}</summary>`);
  }
  for (const fact of memory.conversation.facts) {
    convParts.push(`  <fact id="${fact.factId}">${fact.text}</fact>`);
  }
  if (convParts.length > 0) {
    sections.push(`<conversation_memory>\n${convParts.join('\n')}\n</conversation_memory>`);
  }

  // Top-N user summaries
  if (memory.topUsers.length > 0) {
    const lines = memory.topUsers.map((s) => `  <user id="${s.scopeId}">${s.text}</user>`);
    sections.push(`<known_users>\n${lines.join('\n')}\n</known_users>`);
  }

  // Top-N conversation summaries
  if (memory.topConversations.length > 0) {
    const lines = memory.topConversations.map((s) => `  <conversation id="${s.scopeId}">${s.text}</conversation>`);
    sections.push(`<known_conversations>\n${lines.join('\n')}\n</known_conversations>`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `<memory>
Use this persistent memory for context. Do not repeat it back to users.

${sections.join('\n\n')}
</memory>`;
}
