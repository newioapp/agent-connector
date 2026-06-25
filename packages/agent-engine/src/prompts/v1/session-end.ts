/**
 * Session-end prompt — update memory (when enabled) and produce a handoff note.
 * Output is <handoff> tag (not <done />), since the connector parses the handoff content.
 */
import { memoryRules } from './memory-rules.js';

export function sessionEndPrompt(memoryEnabled: boolean): string {
  const intro = memoryEnabled
    ? 'Your session is ending. Complete these two steps:'
    : 'Your session is ending. Complete this step:';
  const updateMemoryStep = memoryEnabled
    ? `
<step name="update_memory">
${memoryRules()}
</step>
`
    : '';
  return `<event type="system.session_end">
<instructions>
${intro}
${updateMemoryStep}
<step name="handoff">
Write a handoff note so the next session can pick up exactly where you left off — as if continuing the same session.

Include: what was being discussed, what was tried or decided, any pending questions or tasks, and recent context the next session needs (even transient topics like someone venting or a request in progress).

Keep it 2-4 sentences for simple sessions. For longer or multi-conversation sessions, you may write more to capture the full state, but stay concise.

Your final output must be exactly:
<handoff>Your handoff note here.</handoff>
</step>
</instructions>
</event>`;
}
