/**
 * Mid-session memory update prompt — session continues after.
 * Agent uses memory tools then outputs <done />.
 */
import { memoryRules } from './memory-rules.js';

export function memoryUpdatePrompt(): string {
  return `<event type="system.memory_update">
<instructions>
Update your memory now. Your session will continue after this.

${memoryRules()}

When finished, output <done action="memory_updated" />.
</instructions>
</event>`;
}
