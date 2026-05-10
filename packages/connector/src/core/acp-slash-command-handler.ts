/**
 * AcpSlashCommandHandler — caches available slash commands for an ACP session.
 *
 * Processes `available_commands_update` session updates (standard ACP) and
 * `_kiro.dev/commands/available` ext notifications (kiro-cli) and provides
 * query methods for checking command availability (e.g. compact support).
 */
import type { ClientSideConnection } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import type { CompactSessionResponse } from '@newio/agent-sdk';
import { Logger } from './logger';
import { extractErrorMessage, SessionType } from './types';

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
  private useKiroExt = false;

  constructor(
    private readonly sessionType: SessionType,
    private readonly externalReferenceId: string,
    private readonly correlationId: string,
    private readonly connection: ClientSideConnection,
  ) {}

  /** Returns all available slash commands for this session. */
  listCommands(): ReadonlyArray<SlashCommand> {
    return this.commands;
  }

  /** Whether this session supports a compact/context-compaction command. */
  isCompactSupported(): boolean {
    return this.getCompactCommandName() !== undefined;
  }

  /** Returns the actual command name for compact, or undefined if not supported. */
  private getCompactCommandName(): string | undefined {
    return this.commands.find((cmd) =>
      COMPACT_COMMAND_NAMES.includes(cmd.name as (typeof COMPACT_COMMAND_NAMES)[number]),
    )?.name;
  }

  /** Execute the compact command. */
  async compact(): Promise<CompactSessionResponse> {
    const commandName = this.getCompactCommandName();
    if (!commandName) {
      return { success: false, error: 'Compact not supported by this agent' };
    }
    try {
      if (this.useKiroExt) {
        await this.connection.extMethod('_kiro.dev/commands/execute', {
          sessionId: this.correlationId,
          command: { command: commandName, args: {} },
        });
      } else {
        await this.connection.prompt({
          sessionId: this.correlationId,
          prompt: [{ type: 'text', text: `/${commandName}` }],
        });
      }
      log.info(`[${this.sessionType}/${this.externalReferenceId}] Compact completed`);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: extractErrorMessage(err) };
    }
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
    log.info(
      `[${this.sessionType}/${this.externalReferenceId}] Available commands updated: ${this.commands.map((c) => c.name).join(', ')}`,
    );
    return true;
  }

  /** Handle kiro-cli ext notification for available commands. */
  handleExtNotification(method: string, params: Record<string, unknown>): void {
    if (method !== '_kiro.dev/commands/available') {
      return;
    }
    const commands = params.commands;
    if (!Array.isArray(commands)) {
      return;
    }
    this.useKiroExt = true;
    this.commands = commands.map((cmd: Record<string, unknown>) => {
      const name = typeof cmd.name === 'string' ? cmd.name.replace(/^\//, '') : '';
      const description = typeof cmd.description === 'string' ? cmd.description : '';
      const meta =
        typeof cmd.meta === 'object' && cmd.meta !== null ? (cmd.meta as Record<string, unknown>) : undefined;
      const inputHint = meta && typeof meta.hint === 'string' ? meta.hint : undefined;
      return { name, description, inputHint };
    });
    log.info(
      `[${this.sessionType}/${this.externalReferenceId}] Kiro commands updated: ${this.commands.map((c) => c.name).join(', ')}`,
    );
  }
}
