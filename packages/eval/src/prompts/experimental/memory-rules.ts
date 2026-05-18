/**
 * Shared memory update rules — used by both memory-update and session-end prompts.
 */
export function memoryRules(): string {
  return `\
Before making changes, use \`get_memory\` to check what you already know about relevant users and this conversation.

For each piece of information from this session, apply these gates:
1. **Future Utility** — Will this matter in future interactions?
2. **Novelty** — Is this already captured in your current memory?
3. **Factual** — Is this a fact, preference, or decision (not ephemeral chatter)?
4. **Safe** — No sensitive credentials or PII?

Actions:
- New fact → \`add_memory\` with the appropriate username or conversationId
- Update existing → \`update_memory\` with the factId
- Obsolete → \`delete_memory\` with the factId
- Summary needs refresh → \`update_memory_summary\`

Rules:
- Facts: self-contained, third-person, no pronouns.
- Summaries: max 8 lines, high-level overviews only.
- Do NOT store: transient task status, verbatim conversation, or anything stale tomorrow.
- Omit username and conversationId to store facts about yourself (global scope).`;
}
