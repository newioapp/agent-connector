/**
 * Base agent instance — shared auth, WebSocket, and lifecycle logic.
 *
 * Uses NewioApp for all Newio interactions. Subclasses implement onConnected()
 * to add agent-type-specific behavior (e.g. Claude message bridging, Kiro CLI process spawning).
 */
import { ApprovalTimeoutError } from '@newio/sdk';
import type Store from 'electron-store';
import type { StoreSchema } from '../store';
import type { AgentConfigManager } from '../agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from '../../shared/types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import { NewioApp } from '../newio-app';

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  protected app?: NewioApp;
  private abortController?: AbortController;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly store: Store<StoreSchema>,
    protected readonly configManager: AgentConfigManager,
    protected readonly listener: AgentInstanceListener,
  ) {}

  async start(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus('starting');

    try {
      // Load persisted tokens if available
      const allTokens = this.store.get('agentTokens');
      const storedTokens = this.config.id in allTokens ? allTokens[this.config.id] : undefined;

      this.app = await NewioApp.create({
        agentId: this.config.newioAgentId,
        username: this.config.newioUsername,
        name: this.config.name,
        tokens: storedTokens,
        signal: abortController.signal,
        onApprovalUrl: (url) => {
          this.listener.onApprovalUrl(url);
          this.setStatus('awaiting_approval');
        },
        onTokens: (tokens) => {
          const all = this.store.get('agentTokens');
          this.store.set('agentTokens', { ...all, [this.config.id]: tokens });
        },
      });

      // Sync profile to config
      const { userId, username, displayName } = this.app.identity;
      this.configManager.setNewioIdentity(this.config.id, {
        newioAgentId: userId,
        newioUsername: username,
        newioDisplayName: displayName,
        newioAvatarUrl: undefined,
      });
      this.listener.onConfigUpdated();

      this.setStatus('connected');

      this.app.onDisconnect(() => {
        if (!abortController.signal.aborted) {
          this.setStatus('error', 'WebSocket disconnected');
        }
      });

      await this.onConnected();
      this.setStatus('running');
    } catch (err: unknown) {
      this.app?.dispose();
      this.app = undefined;

      // User-initiated cancel — stop() will set status to 'stopped'
      if (abortController.signal.aborted) {
        return;
      }

      if (err instanceof ApprovalTimeoutError) {
        this.setStatus('error', 'Approval timed out. Please try starting the agent again.');
      } else {
        const message = err instanceof Error ? (err.stack ?? err.message) : 'Unknown error';
        this.setStatus('error', message);
      }
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();

    if (this.app) {
      try {
        await this.app.auth.revoke();
      } catch {
        // Best-effort
      }
      this.app.dispose();
      this.app = undefined;
    }

    // Clear persisted tokens
    const tokens = this.store.get('agentTokens');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
    const { [this.config.id]: _removed, ...rest } = tokens;
    this.store.set('agentTokens', rest);

    await this.onStopped();
    this.setStatus('stopped');
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
