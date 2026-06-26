import { ActivityStatus, getLogger } from '@newio/agent-sdk';
import { ContactEvent, CronTriggerEvent, IncomingMessage } from './app/index.js';
import { AgentSession } from './agent-session';
import { AgentEvent, OwnerOpCallback } from './event-queue';
import { PromptManager } from './prompt-manager';
import { collectAgentMessage, extractErrorMessage } from './utils';
import { AgentPromptError } from './errors';
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

/** Cap the agent-error detail shown to the owner so a runaway error string can't bloat the message. */
const MAX_AGENT_ERROR_DETAIL = 500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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
      case 'share_context':
        await this.processSharedContext(session, event.conversationId, event.context);
        break;
    }
  }

  private async processMessageBatch(
    conversationId: string,
    session: AgentSession,
    messages: readonly IncomingMessage[],
  ): Promise<void> {
    const userText = this.promptManager.formatMessagePrompt(session.promptFormatterVersion, messages);
    const ownerId = this.app.identity.ownerId;
    // Hoisted so the catch can decide whether to post an owner-only error notice.
    let ownerVisible: string | boolean | undefined = false;
    try {
      // ownerVisible hits the backend (load conversation/members) and can throw
      // on a transient failure; keep it inside the try so a blip is logged and
      // the session loop survives rather than tearing down on an unguarded await.
      ownerVisible = ownerId && (await this.app.isConversationMember(conversationId, ownerId));
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
        } else if (segment.type === 'agent_thought_chunk' && text && ownerId && ownerVisible) {
          // Re-read controls per segment rather than snapshotting at turn start, so a
          // mid-turn capabilities toggle takes effect on later segments of the same turn.
          const controls = await this.app.getConversationControls(conversationId);
          if (controls?.showThoughts) {
            await this.app.sendMessage(conversationId, text, {
              metadata: { type: 'agent_thought' },
              visibleTo: [ownerId],
            });
          }
        } else if (segment.type === 'tool_call' && text && ownerId && ownerVisible) {
          const controls = await this.app.getConversationControls(conversationId);
          if (controls?.showToolCalls) {
            await this.app.sendMessage(conversationId, text, {
              metadata: { type: 'tool_call', toolCallId: segment.toolCallId, status: segment.toolCallStatus },
              visibleTo: [ownerId],
            });
          }
        }
      }
    } catch (err: unknown) {
      log.error(`${this.logTag} Prompt/send failed for ${conversationId}`, err);
      // Surface an owner-only notice ONLY when the agent's own prompt turn failed
      // (AgentPromptError). Incidental failures of the turn handling itself — a
      // sendMessage 403, a membership-lookup blip — are not the agent erroring and
      // would likely fail to deliver a notice anyway, so they only get logged.
      if (err instanceof AgentPromptError && ownerVisible && ownerId) {
        try {
          const detail = truncate(extractErrorMessage(err.cause), MAX_AGENT_ERROR_DETAIL);
          await this.app.sendMessage(
            conversationId,
            `⚠️ Hit an internal error and couldn't finish that turn. You can try again.\n\n\`${detail}\``,
            { metadata: { type: 'agent_error' }, visibleTo: [ownerId] },
          );
        } catch (notifyErr: unknown) {
          log.warn(`${this.logTag} Failed to deliver agent_error notice to ${conversationId}`, notifyErr);
        }
      }
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

  /**
   * Inject context shared from another of the agent's sessions. The session ABSORBS the context — its
   * text output is discarded (not sent). The agent may call send_message during processing if it
   * explicitly decides to surface something.
   */
  private async processSharedContext(session: AgentSession, conversationId: string, context: string) {
    try {
      const promptText = this.promptManager.buildShareContextPrompt(session.promptFormatterVersion, context);
      await collectAgentMessage(session.prompt(promptText, conversationId));
      log.debug(`${this.logTag} Absorbed shared context for ${conversationId}`);
    } catch (err: unknown) {
      log.error(`${this.logTag} Share-context processing failed for ${conversationId}`, err);
    }
  }
}
