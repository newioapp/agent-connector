/**
 * Base agent instance — shared auth, WebSocket, session routing, and lifecycle logic.
 *
 * Uses NewioApp for all Newio interactions. Manages multiple sessions per agent,
 * routing incoming messages by conversationId → newioSessionId → AgentSession.
 * Subclasses implement session creation and greeting logic.
 */
import { ApprovalTimeoutError, NewioApp } from '@newio/sdk';
import type { IncomingMessage } from '@newio/sdk';
import type { AgentConfigManager } from '../agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from '../types';
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from '../types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import type { AgentSession } from '../agent-session';
import type { SessionStore } from '../session-store';
import { MessageQueue } from './message-queue';
import { Logger } from '../logger';
import WebSocket from 'ws';

const log = new Logger('base-agent-instance');

const API_BASE_URL = 'https://api.conduit.qinnan.dev';
const WS_URL = 'wss://ws.conduit.qinnan.dev';

interface LiveSession {
  readonly session: AgentSession;
  lastActivityAt: number;
}

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  protected app?: NewioApp;
  protected readonly messageQueue = new MessageQueue();

  /** correlationId → live session */
  private readonly liveSessions = new Map<string, LiveSession>();
  /** newioSessionId → in-flight creation/resume promise (dedup concurrent calls) */
  private readonly pendingSessions = new Map<string, Promise<AgentSession>>();
  /** correlationId → conversationId currently being processed */
  private readonly activeConversation = new Map<string, string>();
  private abortController?: AbortController;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly configManager: AgentConfigManager,
    protected readonly sessionStore: SessionStore,
    protected readonly listener: AgentInstanceListener,
  ) {}

  async start(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus('starting');
    log.info('Starting agent');

    try {
      const storedTokens = this.configManager.getTokens(this.config.id);
      log.debug(storedTokens ? 'Found persisted tokens' : 'No persisted tokens, will run auth flow');

      this.app = await NewioApp.create({
        agentId: this.config.newioAgentId,
        username: this.config.newioUsername,
        name: this.config.name,
        apiBaseUrl: API_BASE_URL,
        wsUrl: WS_URL,
        wsFactory: (url) => new WebSocket(url) as never,
        tokens: storedTokens,
        signal: abortController.signal,
        onApprovalUrl: (url) => {
          log.info('Awaiting approval', url);
          this.listener.onApprovalUrl(url);
          this.setStatus('awaiting_approval');
        },
        onTokens: (tokens) => {
          log.debug('Tokens received, persisting');
          this.configManager.setTokens(this.config.id, tokens);
        },
      });

      // Sync profile to config
      const { userId, username, displayName } = this.app.identity;
      log.info(`Authenticated as ${username} (${userId})`);
      this.configManager.setNewioIdentity(this.config.id, {
        newioAgentId: userId,
        newioUsername: username,
        newioDisplayName: displayName,
        newioAvatarUrl: undefined,
      });
      this.listener.onConfigUpdated();

      this.setStatus('initializing');

      this.app.onDisconnect(() => {
        if (!abortController.signal.aborted) {
          log.warn('WebSocket disconnected unexpectedly');
          this.setStatus('error', 'WebSocket disconnected');
        }
      });

      this.app.onMessage((msg) => {
        if (!msg.isOwnMessage) {
          this.messageQueue.enqueue(msg);
        }
      });

      this.startIdleCleanup();
      await this.onConnected();
      void this.processLoop();
      log.info('Agent running');
      this.setStatus('running');
    } catch (err: unknown) {
      this.app?.dispose();
      this.app = undefined;

      if (abortController.signal.aborted) {
        log.info('Start aborted');
        return;
      }

      if (err instanceof ApprovalTimeoutError) {
        log.warn('Approval timed out');
        this.setStatus('error', 'Approval timed out. Please try starting the agent again.');
      } else {
        const message = err instanceof Error ? (err.stack ?? err.message) : 'Unknown error';
        log.error('Failed to start', message);
        this.setStatus('error', message);
      }
    }
  }

  async stop(): Promise<void> {
    log.info('Stopping agent');
    this.abortController?.abort();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Dispose all live sessions
    for (const [correlationId, live] of this.liveSessions) {
      log.debug(`Disposing session: ${correlationId}`);
      live.session.dispose();
    }
    this.liveSessions.clear();

    if (this.app) {
      try {
        await this.app.auth.revoke();
        log.debug('Tokens revoked');
      } catch {
        log.warn('Token revocation failed (best-effort)');
      }
      this.app.dispose();
      this.app = undefined;
    }

    this.configManager.clearTokens(this.config.id);
    this.messageQueue.close();

    await this.onStopped();
    this.setStatus('stopped');
    log.info('Agent stopped');
  }

  // ---------------------------------------------------------------------------
  // Session routing
  // ---------------------------------------------------------------------------

  /**
   * Get, resume, or create a session for a conversation.
   * 1. Resolves conversationId → newioSessionId via NewioApp
   * 2. Checks if a live session exists → return it
   * 3. Checks if a persisted mapping exists → resume the session
   * 4. Otherwise → create a new session
   */
  protected async getOrCreateSession(conversationId: string): Promise<AgentSession> {
    const newioSessionId = this.app?.resolveSessionId(conversationId) ?? conversationId;

    // Check if already running
    const existingCorrelationId = this.sessionStore.get(newioSessionId);
    if (existingCorrelationId) {
      const live = this.liveSessions.get(existingCorrelationId);
      if (live) {
        live.lastActivityAt = Date.now();
        return live.session;
      }
    }

    // Deduplicate concurrent create/resume calls for the same session
    const pending = this.pendingSessions.get(newioSessionId);
    if (pending) {
      return pending;
    }

    const promise = this.resolveSession(newioSessionId, existingCorrelationId);
    this.pendingSessions.set(newioSessionId, promise);
    try {
      return await promise;
    } finally {
      this.pendingSessions.delete(newioSessionId);
    }
  }

  /** Create or resume a session — called only once per newioSessionId (guarded by pendingSessions). */
  private async resolveSession(
    newioSessionId: string,
    existingCorrelationId: string | undefined,
  ): Promise<AgentSession> {
    if (existingCorrelationId) {
      log.info(`Resuming session: correlation=${existingCorrelationId}`);
      const session = await this.resumeSession(existingCorrelationId);
      this.wireStatusListener(session);
      this.liveSessions.set(existingCorrelationId, { session, lastActivityAt: Date.now() });
      return session;
    }

    const session = await this.createSession();
    this.wireStatusListener(session);
    this.sessionStore.set(newioSessionId, session.correlationId);
    this.liveSessions.set(session.correlationId, { session, lastActivityAt: Date.now() });
    log.info(`New session: newio=${newioSessionId} → correlation=${session.correlationId}`);
    return session;
  }

  /** Attach a status listener that routes session status to the active conversation. */
  private wireStatusListener(session: AgentSession): void {
    session.onStatus((status) => {
      const convId = this.activeConversation.get(session.correlationId);
      if (convId) {
        this.app?.setStatus(status, convId);
      }
    });
  }

  /** Get a live session by its correlation ID, if running. */
  protected getLiveSession(correlationId: string): AgentSession | undefined {
    return this.liveSessions.get(correlationId)?.session;
  }

  // ---------------------------------------------------------------------------
  // Abstract — subclass hooks
  // ---------------------------------------------------------------------------

  /** Create a new agent-type-specific session. */
  protected abstract createSession(): Promise<AgentSession>;

  /** Resume a previously idle-killed session by its correlation ID. */
  protected abstract resumeSession(correlationId: string): Promise<AgentSession>;

  /** Called after NewioApp is ready. Subclasses add agent-specific behavior (e.g., greeting). */
  protected abstract onConnected(): Promise<void> | void;

  /** Called during stop. Subclasses clean up agent-specific resources. */
  protected abstract onStopped(): Promise<void> | void;

  // ---------------------------------------------------------------------------
  // Processing loop
  // ---------------------------------------------------------------------------

  private async processLoop(): Promise<void> {
    for await (const [conversationId, messages] of this.messageQueue.batches()) {
      await this.processBatch(conversationId, messages);
    }
  }

  private async processBatch(conversationId: string, messages: readonly IncomingMessage[]): Promise<void> {
    if (!this.app) {
      return;
    }

    let session: AgentSession;
    try {
      session = await this.getOrCreateSession(conversationId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to get/create session for ${conversationId}: ${errMsg}`);
      return;
    }

    const userText = this.formatPrompt(messages);
    this.activeConversation.set(session.correlationId, conversationId);

    try {
      const response = await session.prompt(userText);

      if (response && response.trim().toLowerCase() !== '_skip') {
        await this.app.sendMessage(conversationId, response.trim());
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Prompt/send failed for ${conversationId}: ${errMsg}`);
    } finally {
      this.activeConversation.delete(session.correlationId);
      this.app.setStatus('idle', conversationId);
    }
  }

  // ---------------------------------------------------------------------------
  // Idle cleanup
  // ---------------------------------------------------------------------------

  private startIdleCleanup(): void {
    const checkInterval = 60_000; // check every minute
    this.idleTimer = setInterval(() => {
      this.cleanupIdleSessions();
    }, checkInterval);
  }

  private cleanupIdleSessions(): void {
    const timeout = this.config.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const now = Date.now();

    for (const [correlationId, live] of this.liveSessions) {
      if (now - live.lastActivityAt > timeout) {
        log.info(`Idle session cleanup: ${correlationId} (idle ${Math.round((now - live.lastActivityAt) / 1000)}s)`);
        live.session.dispose();
        this.liveSessions.delete(correlationId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt formatting
  // ---------------------------------------------------------------------------

  protected formatPrompt(messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';
    if (isGroup) {
      return this.formatGroupBatch(first.conversationId, first.groupName, messages);
    }
    return this.formatDmBatch(first.conversationId, messages);
  }

  private formatSender(m: IncomingMessage): string {
    return [
      `    username: ${m.senderUsername ?? 'unknown'}`,
      `    displayName: ${m.senderDisplayName ?? 'Unknown'}`,
      `    accountType: ${m.senderAccountType ?? 'unknown'}`,
      `    inContact: ${String(m.inContact)}`,
    ].join('\n');
  }

  private formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
    const first = messages[0];
    const lines = [`conversationId: ${conversationId}`, `type: dm`, `from:`, this.formatSender(first), `messages:`];
    for (const m of messages) {
      lines.push(`  - message: ${m.text}`);
      lines.push(`    timestamp: "${m.timestamp}"`);
    }
    return lines.join('\n');
  }

  private formatGroupBatch(
    conversationId: string,
    groupName: string | undefined,
    messages: readonly IncomingMessage[],
  ): string {
    const lines = [
      `conversationId: ${conversationId}`,
      `type: group`,
      `groupName: ${groupName ?? 'Unnamed Group'}`,
      `messages:`,
    ];
    for (const m of messages) {
      lines.push(`  - from:`);
      lines.push(this.formatSender(m));
      lines.push(`    message: ${m.text}`);
      lines.push(`    timestamp: "${m.timestamp}"`);
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }
}
