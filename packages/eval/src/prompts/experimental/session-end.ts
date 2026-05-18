/**
 * Session-end prompt — update memory and produce a handoff note.
 * Output is <handoff> tag (not <done />), since the connector parses the handoff content.
 */
import { memoryRules } from './memory-rules.js';

export function sessionEndPrompt(): string {
  return `<event type="system.session_end">
<instructions>
Your session is ending. Complete these two steps:

<step name="update_memory">
${memoryRules()}
</step>

<step name="handoff">
Output 2-4 sentences describing the current state of work so the next session can pick up context.
Capture what was happening — not durable facts (those go in memory).

Your final output must be exactly:
<handoff>Your handoff note here.</handoff>
</step>
</instructions>
</event>`;
}
