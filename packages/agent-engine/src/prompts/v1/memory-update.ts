/**
 * Mid-session memory update prompt — session continues after.
 */
import { memoryRules } from './memory-rules.js';

export function memoryUpdatePrompt(): string {
  return `\
event: system.memory_update
instructions: |
  Update your memory now. Your session will continue after this.

  ${memoryRules().split('\n').join('\n  ')}`;
}
