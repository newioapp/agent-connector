import { ActivityStatus, getLogger } from '@newio/agent-sdk';
import { ContactEvent, CronTriggerEvent, IncomingMessage } from './app/index.js';
import { AgentSession } from './agent-session';
import { AgentEvent, OwnerOpCallback } from './event-queue';
import { PromptManager } from './prompt-manager';
import { collectAgentMessage } from './utils';
import type { ConversationControls } from './app/index.js';
import { AgentIdentity, SessionType, SessionEventProcessor } from './types';

export interface NewioAppForSessionEventProcessor {
  readonly identity: AgentIdentity;

  getConversationControls(conversationId: string): Promise<ConversationControls | undefined>;

  isConversationMember(conversationId: string, userId: string): Promise<boolean>;

  sendMessage(
    conversationId: string,
    text?: string,
    opts?: { filePaths?: readonly string[]; metadata?: Record<string, unknown>; visibleTo?: readonly string[] },
  ): Promise<void>;

  setStatus(status: ActivityStatus, conversationId?: string): void;

  rotateSession(sessionType: SessionType, externalReferenceId: string): Promise<void>;
}

const log = getLogger('session-event-processor-impl');

export class SessionEventProcessorImpl implements SessionEventProcessor {
  constructor(
    private readonly logTag: string,
    private readonly app: NewioAppForSessionEventProcessor,
    private readonly promptManager: PromptManager,
  ) {}
  /** Dispatch an event to the appropriate handler. */
  async processEvent(event: AgentEvent, session: AgentSession): Promise<void> {
    switch (event.type) {
      case 'messages':
        await this.processMessageBatch(event.conversationId, session, event.messages);
        break;
      case 'contact':
        await this.processContactBatch(session, event.events);
        break;
      case 'cron':
        await this.processCronTrigger(session, event.job);
        break;
      case 'compact_session':
        await this.processSessionCompaction(session, event.callbacks);
        break;
      case 'rotate_session':
        await this.processSessionRotation(event.sessionType, event.externalReferenceId, event.callbacks);
        break;
      case 'update_memory':
        await this.processSessionMemoryUpdate(session, event.callbacks);
        break;
      case 'initiate_conversation':
        await this.processConversationInitiation(session, event.conversationId, event.context);
        break;
    }
  }

  private async processMessageBatch(
    conversationId: string,
    session: AgentSession,
    messages: readonly IncomingMessage[],
  ): Promise<void> {
    const userText = this.promptManager.formatMessagePrompt(session.promptFormatterVersion, messages);
    const controls = await this.app.getConversationControls(conversationId);
    const ownerId = this.app.identity.ownerId;
    const ownerVisible = ownerId && (await this.app.isConversationMember(conversationId, ownerId));
    try {
      log.debug(
        `Prompting session ${session.correlationId} for conversation ${conversationId} with ${messages.length} message(s)`,
      );
      for await (const segment of session.prompt(userText, conversationId)) {
        const text = segment.text.trim();
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, segment.text)
        ) {
          await this.app.sendMessage(conversationId, text);
        } else if (segment.type === 'agent_thought_chunk' && controls?.showThoughts && text && ownerVisible) {
          await this.app.sendMessage(conversationId, text, {
            metadata: { type: 'agent_thought' },
            visibleTo: [ownerId],
          });
        } else if (segment.type === 'tool_call' && controls?.showToolCalls && text && ownerVisible) {
          await this.app.sendMessage(conversationId, text, {
            metadata: { type: 'tool_call', toolCallId: segment.toolCallId, status: segment.toolCallStatus },
            visibleTo: [ownerId],
          });
        }
      }
    } catch (err: unknown) {
      log.error(`${this.logTag} Prompt/send failed for ${conversationId}`, err);
    } finally {
      this.app.setStatus('idle', conversationId);
    }
  }

  private async processContactBatch(session: AgentSession, events: readonly ContactEvent[]): Promise<void> {
    const userText = this.promptManager.formatContactPrompt(session.promptFormatterVersion, events);
    log.debug(`${this.logTag} Processing ${String(events.length)} contact event(s)`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, text)
        ) {
          log.debug(`${this.logTag} Contact event response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      log.error(`${this.logTag} Contact event processing failed`, err);
    }
  }

  private async processCronTrigger(session: AgentSession, job: CronTriggerEvent): Promise<void> {
    const userText = this.promptManager.formatCronPrompt(session.promptFormatterVersion, job);
    log.debug(`${this.logTag} Processing cron ${job.cronId} ("${job.label}")`);

    try {
      for await (const segment of session.prompt(userText)) {
        const text = segment.text.trim();
        if (
          segment.type === 'agent_message_chunk' &&
          text &&
          !this.promptManager.isSkip(session.promptFormatterVersion, text)
        ) {
          log.debug(`${this.logTag} Cron response (discarded): ${text.substring(0, 100)}`);
        }
      }
    } catch (err: unknown) {
      log.error(`${this.logTag} Cron processing failed for ${job.cronId}`, err);
    }
  }

  private async processSessionCompaction(session: AgentSession, callbacks: readonly OwnerOpCallback[]): Promise<void> {
    try {
      const result = await session.handleCompactSession();
      callbacks.forEach((callback) => callback.resolve(result));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
    }
  }

  private async processSessionRotation(
    sessionType: SessionType,
    externalReferenceId: string,
    callbacks: readonly OwnerOpCallback[],
  ): Promise<void> {
    try {
      await this.app.rotateSession(sessionType, externalReferenceId);
      callbacks.forEach((callback) => callback.resolve({ success: true }));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
    }
  }

  private async processSessionMemoryUpdate(
    session: AgentSession,
    callbacks: readonly OwnerOpCallback[],
  ): Promise<void> {
    try {
      await collectAgentMessage(
        session.prompt(this.promptManager.buildMemoryUpdatePrompt(session.promptFormatterVersion)),
      );
      callbacks.forEach((callback) => callback.resolve({ success: true }));
    } catch (err: unknown) {
      callbacks.forEach((callback) => callback.reject(err));
    }
  }

  private async processConversationInitiation(session: AgentSession, conversationId: string, context: string) {
    try {
      const promptText = this.promptManager.buildInitiateConversationPrompt(session.promptFormatterVersion, context);
      const output = await collectAgentMessage(session.prompt(promptText, conversationId));

      if (!output || this.promptManager.isSkip(session.promptFormatterVersion, output)) {
        log.debug(`${this.logTag} Conversation initiation skipped for ${conversationId} (no message produced)`);
        return;
      }

      await this.app.sendMessage(conversationId, output);
      log.info(`${this.logTag} Delegated message sent to ${conversationId}`);
    } catch (err: unknown) {
      log.error(`${this.logTag} Conversation initiation failed for ${conversationId}`, err);
    }
  }
}
