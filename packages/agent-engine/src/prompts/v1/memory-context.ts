/**
 * Memory context — formats loaded memory into a context block injected at session start.
 *
 * Example synthesized output:
 *
 * ```
 * # Memory
 *
 * The following is your persistent memory from previous sessions. Use it for context but do not repeat it back to users.
 *
 * ## Handoff from previous session
 * Was helping Alice debug a TypeScript issue with her API client. She narrowed it to a type mismatch in the response handler.
 *
 * ## Your memory (global)
 * Agent prefers concise responses unless asked for detail.
 * - Owned by Nan, who works on the Newio messaging platform.
 * - Default tone: friendly but professional.
 *
 * ## Memory about user usr_abc123
 * Summary: Alice is a frontend developer working on a React dashboard project.
 * - Alice prefers TypeScript strict mode.
 * - Alice's timezone is PST (UTC-8).
 *
 * ## Memory about this conversation
 * Summary: Ongoing debugging session for Alice's API client library.
 * - Alice is using @newio/sdk v0.1.0.
 *
 * ## Other people you know
 * - usr_def456: Bob is Nan's colleague working on infrastructure.
 * - usr_ghi789: Charlie is an agent owned by Alice for code review.
 *
 * ## Other conversations
 * - conv_aaa: Team standup channel for daily updates.
 * - conv_bbb: Architecture discussion for the new auth flow.
 * ```
 */
import type { LoadSessionMemoryResponse } from '@newio/agent-sdk';

export interface MemoryContextProps {
  readonly memory: LoadSessionMemoryResponse;
  readonly handoffNote?: string;
}

export function memoryContextPrompt({ memory, handoffNote }: MemoryContextProps): string {
  const sections: string[] = [];

  if (handoffNote) {
    sections.push(`## Handoff from previous session\n${handoffNote}`);
  }

  const globalParts: string[] = [];
  if (memory.global.summary) {
    globalParts.push(memory.global.summary.text);
  }
  for (const fact of memory.global.facts) {
    globalParts.push(`- ${fact.text}`);
  }
  if (globalParts.length > 0) {
    sections.push(`## Your memory (global)\n${globalParts.join('\n')}`);
  }

  for (const [userId, data] of Object.entries(memory.participants)) {
    const parts: string[] = [];
    if (data.summary) {
      parts.push(`Summary: ${data.summary.text}`);
    }
    for (const fact of data.facts) {
      parts.push(`- ${fact.text}`);
    }
    if (parts.length > 0) {
      sections.push(`## Memory about user ${userId}\n${parts.join('\n')}`);
    }
  }

  const convParts: string[] = [];
  if (memory.conversation.summary) {
    convParts.push(`Summary: ${memory.conversation.summary.text}`);
  }
  for (const fact of memory.conversation.facts) {
    convParts.push(`- ${fact.text}`);
  }
  if (convParts.length > 0) {
    sections.push(`## Memory about this conversation\n${convParts.join('\n')}`);
  }

  if (memory.topUsers.length > 0) {
    const lines = memory.topUsers.map((s) => `- ${s.scopeId}: ${s.text}`);
    sections.push(`## Other people you know\n${lines.join('\n')}`);
  }

  if (memory.topConversations.length > 0) {
    const lines = memory.topConversations.map((s) => `- ${s.scopeId}: ${s.text}`);
    sections.push(`## Other conversations\n${lines.join('\n')}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `# Memory\n\nThe following is your persistent memory from previous sessions. Use it for context but do not repeat it back to users.\n\n${sections.join('\n\n')}`;
}
