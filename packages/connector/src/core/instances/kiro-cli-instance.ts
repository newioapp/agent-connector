/**
 * Kiro CLI agent instance — manages multiple KiroCliSession instances.
 *
 * Each session is a separate kiro-cli ACP process with its own context window.
 * Session routing, idle cleanup, and the message processing loop are handled
 * by BaseAgentInstance. This class provides session creation and greeting logic.
 */
import { BaseAgentInstance } from './base-agent-instance';
import { KiroCliSession } from './kiro-cli-session';
import type { PermissionHandler } from './kiro-cli-session';
import type { AgentSession } from '../agent-session';
import type { SessionStreamSegment } from './session-stream';
import { Logger } from '../logger';

const log = new Logger('kiro-cli-instance');

export class KiroCliInstance extends BaseAgentInstance {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    log.info('Kiro CLI instance connected, preparing greeting...');
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    await this.sendGreeting();
  }

  protected onStopped(): void {
    log.info('Kiro CLI instance stopped');
  }

  // ---------------------------------------------------------------------------
  // Permission handler
  // ---------------------------------------------------------------------------

  private readonly permissionHandler: PermissionHandler = async (correlationId, params) => {
    const title = params.toolCall.title ?? 'Permission request';
    if (params.toolCall.content) {
      log.debug(`[${correlationId}] Permission request toolCall content: ${JSON.stringify(params.toolCall.content)}`);
    }

    try {
      const selectedOptionId = await this.handlePermissionRequest(correlationId, params.options, title);
      return { outcome: { outcome: 'selected' as const, optionId: selectedOptionId } };
    } catch (err: unknown) {
      log.warn(`Permission request failed: ${err instanceof Error ? err.message : String(err)}`);
      return { outcome: { outcome: 'cancelled' as const } };
    }
  };

  // ---------------------------------------------------------------------------
  // Session factory
  // ---------------------------------------------------------------------------

  protected async createSession(): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }

    log.info('Creating new Kiro CLI session...');
    const session = await KiroCliSession.create(
      this.config.kiroCli,
      this.mcpSocketPath,
      this.config.envVars,
      this.permissionHandler,
    );
    log.info(`Session created: ${session.correlationId}`);

    // Send Newio instruction as the first prompt so the session has context
    log.debug(`[${session.correlationId}] Sending Newio instruction to new session`);
    const instruction = this.promptManager.buildNewioInstruction();
    // Drain the generator — we don't need the instruction response
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of session.prompt(instruction)) {
      // discard
    }
    log.debug(`[${session.correlationId}] Newio instruction delivered`);

    return session;
  }

  protected async resumeSession(correlationId: string): Promise<AgentSession> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    log.info(`Resuming Kiro CLI session: ${correlationId}`);
    return KiroCliSession.resume(
      this.config.kiroCli,
      correlationId,
      this.mcpSocketPath,
      this.config.envVars,
      this.permissionHandler,
    );
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(): Promise<void> {
    if (!this.app.identity.ownerId) {
      log.warn('No ownerId set, skipping greeting');
      return;
    }

    // Find or create DM with owner
    log.debug('Finding or creating DM with owner...');
    const ownerDmConversationId = await this.app.getOwnerDmConversationId();
    if (!ownerDmConversationId) {
      log.warn('Could not get owner DM conversation, skipping greeting');
      return;
    }
    log.debug(`Owner DM conversation: ${ownerDmConversationId}`);

    this.setStatus('greeting');
    // Get or create the session for the owner DM
    const session = await this.getOrCreateSession(ownerDmConversationId);
    log.debug(`[${session.correlationId}] Generating greeting for owner...`);

    let greeting: string | undefined;
    try {
      greeting = await collectAgentMessage(session.prompt(this.promptManager.buildGreetingPrompt()));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error(`[${session.correlationId}] Greeting prompt failed: ${message}`);
      throw new Error(`Kiro CLI connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      log.error(`[${session.correlationId}] Agent returned empty greeting`);
      throw new Error('Kiro CLI test failed: agent returned an empty response');
    }

    await this.app.sendMessage(ownerDmConversationId, greeting.trim());
    log.info(`[${session.correlationId}] Greeting sent to owner`);
  }
}

/** Drain a prompt generator and return concatenated agent_message text. */
async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk') {
      parts.push(segment.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}
