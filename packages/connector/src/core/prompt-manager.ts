/**
 * Prompt manager — centralizes all prompt generation for agent sessions.
 *
 * The system instruction (agent identity, messaging conventions) lives in
 * the SDK ({@link NewioApp.buildNewioInstruction}). This module owns the
 * runtime event formatters that produce per-turn prompt text. The message
 * format here must stay in sync with the examples in the system instruction.
 */
import type { IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/sdk';
import type { Instruction, PromptFormatter } from './prompt-formatter';

export class UnsupportedPromptFormatterVersion extends Error {
  constructor(version: string) {
    super(`No compatible prompt formatter for version ${version}`);
    this.name = 'UnsupportedPromptFormatterVersion';
  }
}

/** Parse the major version number from a semver string. */
function parseMajor(version: string): number {
  const major = parseInt(version.split('.')[0], 10);
  if (isNaN(major)) {
    throw new UnsupportedPromptFormatterVersion(version);
  }
  return major;
}

export class PromptManager {
  private readonly promptFormatters: ReadonlyArray<PromptFormatter>;
  private readonly defaultFormatter: PromptFormatter;

  constructor(promptFormatters: ReadonlyArray<PromptFormatter>, defaultFormatter: PromptFormatter) {
    this.promptFormatters = promptFormatters;
    this.defaultFormatter = defaultFormatter;
  }

  buildNewioInstruction(customInstructions?: string): Instruction {
    return this.defaultFormatter.buildNewioInstruction(customInstructions);
  }

  buildGreetingPrompt(promptVersion: string): string {
    return this.findCompatiblePromptFormatter(promptVersion).buildGreetingPrompt();
  }

  formatMessagePrompt(promptVersion: string, messages: readonly IncomingMessage[]): string {
    return this.findCompatiblePromptFormatter(promptVersion).formatMessagePrompt(messages);
  }

  formatContactPrompt(promptVersion: string, events: readonly ContactEvent[]): string {
    return this.findCompatiblePromptFormatter(promptVersion).formatContactPrompt(events);
  }

  formatCronPrompt(promptVersion: string, job: CronTriggerEvent): string {
    return this.findCompatiblePromptFormatter(promptVersion).formatCronPrompt(job);
  }

  /** Find a formatter whose major version matches the requested version. */
  findCompatiblePromptFormatter(version: string): PromptFormatter {
    const requestedMajor = parseMajor(version);
    for (const formatter of this.promptFormatters) {
      if (parseMajor(formatter.version) === requestedMajor) {
        return formatter;
      }
    }
    throw new UnsupportedPromptFormatterVersion(version);
  }

  assertPromptFormatterVersion(version: string): void {
    this.findCompatiblePromptFormatter(version);
  }
}
