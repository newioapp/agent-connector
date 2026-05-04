/**
 * AcpSlashCommandHandler — caches available slash commands for an ACP session.
 *
 * Processes `available_commands_update` session updates and provides query methods
 * for checking command availability (e.g. compact support).
 */
import type * as acp from '@agentclientprotocol/sdk';
import { Logger } from './logger';

const log = new Logger('acp-slash-command-handler');

/** Known command names that map to "compact" across different ACP agents. */
const COMPACT_COMMAND_NAMES = ['compact'] as const;

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly inputHint?: string;
}

export class AcpSlashCommandHandler {
  private commands: ReadonlyArray<SlashCommand> = [];

  constructor(private readonly sessionId: string) {}

  /** Returns all available slash commands for this session. */
  listCommands(): ReadonlyArray<SlashCommand> {
    return this.commands;
  }

  /** Whether this session supports a compact/context-compaction command. */
  isCompactSupported(): boolean {
    return this.getCompactCommandName() !== undefined;
  }

  /** Returns the actual command name for compact, or undefined if not supported. */
  getCompactCommandName(): string | undefined {
    return this.commands.find((cmd) =>
      COMPACT_COMMAND_NAMES.includes(cmd.name as (typeof COMPACT_COMMAND_NAMES)[number]),
    )?.name;
  }

  /** Handle slash-command-related session updates. Returns true if the update was handled. */
  handleSessionUpdate(update: acp.SessionUpdate): boolean {
    if (update.sessionUpdate !== 'available_commands_update') {
      return false;
    }
    this.commands = update.availableCommands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      inputHint: cmd.input?.hint ?? undefined,
    }));
    log.info(`[${this.sessionId}] Available commands updated: ${this.commands.map((c) => c.name).join(', ')}`);
    return true;
  }
}
