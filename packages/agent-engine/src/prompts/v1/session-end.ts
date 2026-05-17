/**
 * Session-end prompt — update memory and produce a handoff note.
 */
import { memoryRules } from './memory-rules.js';

export function sessionEndPrompt(): string {
  return `\
event: system.session_end
instructions: |
  Your session is ending. Complete these two steps:

  ## Step 1: Update memory

  ${memoryRules().split('\n').join('\n  ')}

  ## Step 2: Handoff note

  Output 2-4 sentences describing the current state of work so the next session can pick up context.
  This should capture what was happening, not durable facts (those go in memory).

  Output the handoff note as your final message, prefixed with exactly "HANDOFF:" on its own line.`;
}
