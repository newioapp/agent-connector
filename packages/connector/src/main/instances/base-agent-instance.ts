/**
 * Base agent instance — shared auth, WebSocket, and lifecycle logic.
 *
 * Subclasses implement onConnected() to add agent-type-specific behavior
 * (e.g. Claude message bridging, Kiro CLI process spawning).
 */
import { AuthManager, NewioClient, NewioWebSocket } from '@newio/sdk';
import type { ApprovalHandle } from '@newio/sdk';
import type Store from 'electron-store';
import type { StoreSchema } from '../store';
import type { AgentConfigManager } from '../agent-config-manager';
import type { AgentRuntimeStatus, AgentConfig } from '../../shared/types';
import type { AgentInstance, AgentInstanceListener } from './agent-instance';
import WebSocket from 'ws';

const API_BASE_URL = 'https://api.conduit.qinnan.dev';
const WS_URL = 'wss://ws.conduit.qinnan.dev';

export abstract class BaseAgentInstance implements AgentInstance {
  status: AgentRuntimeStatus = 'stopped';
  error?: string;

  protected auth: AuthManager;
  protected client?: NewioClient;
  protected ws?: NewioWebSocket;
  private abortController?: AbortController;

  constructor(
    protected readonly config: AgentConfig,
    protected readonly store: Store<StoreSchema>,
    protected readonly configManager: AgentConfigManager,
    protected readonly listener: AgentInstanceListener,
  ) {
    this.auth = new AuthManager(API_BASE_URL);
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    this.setStatus('starting');

    try {
      // Check for persisted tokens
      const allTokens = this.store.get('agentTokens');
      if (this.config.id in allTokens) {
        const storedTokens = allTokens[this.config.id];
        this.auth.setTokens(storedTokens.accessToken, storedTokens.refreshToken);
      } else {
        await this.authenticate();
      }

      // Create client and WebSocket
      this.client = new NewioClient({ baseUrl: API_BASE_URL, tokenProvider: this.auth.tokenProvider });
      this.ws = new NewioWebSocket({
        url: WS_URL,
        tokenProvider: this.auth.tokenProvider,
        wsFactory: (url) => new WebSocket(url) as never,
      });

      await this.ws.connect();
      this.setStatus('running');

      this.ws.onStateChange((state) => {
        if (state === 'disconnected' && !this.abortController?.signal.aborted) {
          this.setStatus('error', 'WebSocket disconnected');
        }
      });

      // Let the subclass do its thing
      await this.onConnected();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus('error', message);
    }
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.ws?.disconnect();

    try {
      await this.auth.revoke();
    } catch {
      // Best-effort
    }
    this.auth.dispose();

    // Clear persisted tokens
    const tokens = this.store.get('agentTokens');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
    const { [this.config.id]: _removed, ...rest } = tokens;
    this.store.set('agentTokens', rest);

    await this.onStopped();
    this.setStatus('stopped');
  }

  /** Called after WebSocket is connected. Subclasses add agent-specific behavior. */
  protected abstract onConnected(): Promise<void>;

  /** Called during stop. Subclasses clean up agent-specific resources. */
  protected abstract onStopped(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async authenticate(): Promise<void> {
    let handle: ApprovalHandle;
    if (this.config.newioAgentId) {
      handle = await this.auth.login({ agentId: this.config.newioAgentId });
    } else {
      handle = await this.auth.register({ name: this.config.name });
    }

    this.listener.onApprovalUrl(handle.approvalUrl);
    this.setStatus('awaiting_approval');

    const tokens = await handle.waitForApproval({ signal: this.abortController?.signal });

    // Persist tokens
    const allTokens = this.store.get('agentTokens');
    this.store.set('agentTokens', { ...allTokens, [this.config.id]: tokens });

    // If new registration, fetch profile to get Newio identity
    if (!this.config.newioAgentId) {
      const client = new NewioClient({ baseUrl: API_BASE_URL, tokenProvider: this.auth.tokenProvider });
      const me = await client.getMe({});
      this.configManager.setNewioIdentity(this.config.id, me.userId, me.username ?? '');
      this.listener.onConfigUpdated();
    }
  }

  private setStatus(status: AgentRuntimeStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.listener.onStatusChanged(status, error);
  }
}
