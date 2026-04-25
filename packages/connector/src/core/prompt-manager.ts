/**
 * Prompt manager — version-aware dispatcher for prompt formatters.
 *
 * Holds a registry of {@link PromptFormatter} instances keyed by major version.
 * Each session stores the formatter version it was created with; on resume the
 * manager routes to a compatible formatter (same major version) or throws.
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
  private readonly formatterByMajor: ReadonlyMap<number, PromptFormatter>;
  private readonly defaultFormatter: PromptFormatter;

  constructor(promptFormatters: ReadonlyArray<PromptFormatter>, defaultFormatter: PromptFormatter) {
    const map = new Map<number, PromptFormatter>();
    for (const f of promptFormatters) {
      map.set(parseMajor(f.version), f);
    }
    this.formatterByMajor = map;
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

  assertPromptFormatterVersion(version: string): void {
    this.findCompatiblePromptFormatter(version);
  }

  /** Find a formatter whose major version matches the requested version. */
  private findCompatiblePromptFormatter(version: string): PromptFormatter {
    const formatter = this.formatterByMajor.get(parseMajor(version));
    if (!formatter) {
      throw new UnsupportedPromptFormatterVersion(version);
    }
    return formatter;
  }
}
