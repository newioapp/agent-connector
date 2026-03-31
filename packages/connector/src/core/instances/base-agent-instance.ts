/**
 * Base agent instance — shared auth, WebSocket, and lifecycle logic.
 *
 * Uses NewioApp for all Newio interactions. Subclasses implement onConnected()
 * to add agent-type-specific behavior (e.g. Claude message bridging, Kiro CLI process spawning).
 */
import { ApprovalTimeoutError } from '@newio/sdk';
import type { AgentConfigManager } from '../agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from '../types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import { NewioApp } from '../newio-app';
import { Logger } from '../logger';

const log = new Logger('base-agent-instance');

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  protected app?: NewioApp;
  private abortController?: AbortController;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly configManager: AgentConfigManager,
    protected readonly listener: AgentInstanceListener,
  ) {}

  async start(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus('starting');
    log.info('Starting agent');

    try {
      // Load persisted tokens if available
      const storedTokens = this.configManager.getTokens(this.config.id);
      log.debug(storedTokens ? 'Found persisted tokens' : 'No persisted tokens, will run auth flow');

      this.app = await NewioApp.create({
        agentId: this.config.newioAgentId,
        username: this.config.newioUsername,
        name: this.config.name,
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

      await this.onConnected();
      log.info('Agent running');
      this.setStatus('running');
    } catch (err: unknown) {
      this.app?.dispose();
      this.app = undefined;

      // User-initiated cancel — stop() will set status to 'stopped'
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

    // Clear persisted tokens
    this.configManager.clearTokens(this.config.id);

    await this.onStopped();
    this.setStatus('stopped');
    log.info('Agent stopped');
  }

  /** Called after NewioApp is ready. Subclasses add agent-specific behavior. */
  protected abstract onConnected(): Promise<void> | void;

  /** Called during stop. Subclasses clean up agent-specific resources. */
  protected abstract onStopped(): Promise<void> | void;

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }
}
