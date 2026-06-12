/**
 * OverridablePromptFormatter — the eval's prompt experimentation seam.
 *
 * By default it delegates every call to a base {@link PromptFormatter} (the real
 * `PromptFormatterImpl` from `@newio/agent-engine`), so an eval with no overrides
 * tests exactly the prompts that ship. To A/B a prompt, pass an override for the
 * relevant method — each override receives the `base` formatter so it can either
 * fully replace the prompt or post-process the production output.
 *
 * This keeps experiments a declarative diff instead of a divergent copy: the real
 * engine remains the single source of truth for the baseline prompts.
 */
import type {
  PromptFormatter,
  Instruction,
  SessionPromptRole,
  IncomingMessage,
  ContactEvent,
  CronTriggerEvent,
} from '@newio/agent-engine';
import type { LoadSessionMemoryResponse } from '@newio/agent-sdk';

export interface PromptOverrides {
  readonly buildNewioInstruction?: (
    base: PromptFormatter,
    role?: SessionPromptRole,
    customInstructions?: string,
  ) => Instruction;
  readonly buildShareContextPrompt?: (base: PromptFormatter, context: string) => string;
  readonly buildInitiateConversationPrompt?: (base: PromptFormatter, context: string) => string;
}

export class OverridablePromptFormatter implements PromptFormatter {
  constructor(
    private readonly base: PromptFormatter,
    private readonly overrides: PromptOverrides = {},
  ) {}

  get version(): string {
    return this.base.version;
  }

  get skipToken(): string {
    return this.base.skipToken;
  }

  isSkip(text: string): boolean {
    return this.base.isSkip(text);
  }

  extractHandoff(text: string): string | undefined {
    return this.base.extractHandoff(text);
  }

  buildNewioInstruction(role?: SessionPromptRole, customInstructions?: string): Instruction {
    return this.overrides.buildNewioInstruction
      ? this.overrides.buildNewioInstruction(this.base, role, customInstructions)
      : this.base.buildNewioInstruction(role, customInstructions);
  }

  buildGreetingPrompt(): string {
    return this.base.buildGreetingPrompt();
  }

  formatMessagePrompt(messages: readonly IncomingMessage[]): string {
    return this.base.formatMessagePrompt(messages);
  }

  formatContactPrompt(events: readonly ContactEvent[]): string {
    return this.base.formatContactPrompt(events);
  }

  formatCronPrompt(job: CronTriggerEvent): string {
    return this.base.formatCronPrompt(job);
  }

  formatMemoryContext(memory: LoadSessionMemoryResponse, handoffNote?: string): string {
    return this.base.formatMemoryContext(memory, handoffNote);
  }

  buildMemoryUpdatePrompt(): string {
    return this.base.buildMemoryUpdatePrompt();
  }

  buildSessionEndPrompt(): string {
    return this.base.buildSessionEndPrompt();
  }

  buildInitiateConversationPrompt(context: string): string {
    return this.overrides.buildInitiateConversationPrompt
      ? this.overrides.buildInitiateConversationPrompt(this.base, context)
      : this.base.buildInitiateConversationPrompt(context);
  }

  buildShareContextPrompt(context: string): string {
    return this.overrides.buildShareContextPrompt
      ? this.overrides.buildShareContextPrompt(this.base, context)
      : this.base.buildShareContextPrompt(context);
  }
}
