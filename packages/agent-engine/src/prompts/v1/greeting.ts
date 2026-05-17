/**
 * Greeting prompt — startup connection test sent to the owner DM.
 */
export function greetingPrompt(): string {
  return `\
event: system.greeting
task: |
  Write a brief, friendly greeting (1-2 sentences) to let your owner know you are online and ready.
  Just output the greeting text, nothing else.`;
}
