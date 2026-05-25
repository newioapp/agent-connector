/**
 * Greeting prompt — startup connection test sent to the owner DM.
 * Output mode: reply text (sent to owner).
 */
export function greetingPrompt(): string {
  return `<event type="system.greeting">
<instructions>
Write a brief, friendly greeting (1-2 sentences) to let your owner know you are online and ready.
Output only the greeting text — it will be sent as a DM to your owner.
</instructions>
</event>`;
}
