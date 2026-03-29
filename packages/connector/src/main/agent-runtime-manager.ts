/**
 * Agent runtime manager — manages the lifecycle of running agent instances.
 *
 * Each agent instance owns: an AuthManager, a NewioClient, and a NewioWebSocket.
 * The runtime manager handles start (register/login → poll → connect WS) and stop.
 */
import { AuthManager, NewioClient, NewioWebSocket } from '@newio/sdk';
import type { ApprovalHandle } from '@newio/sdk';
import type Store from 'electron-store';
import type { StoreSchema } from './store';
import type { AgentConfigManager } from './agent-config-manager';
import type { AgentRuntimeStatus } from '../shared/types';
import WebSocket from 'ws';

const API_BASE_URL = 'https://api.conduit.qinnan.dev';
const WS_URL = 'wss://ws.conduit.qinnan.dev';

interface AgentInstance {
  status: AgentRuntimeStatus;
  error?: string;
  auth: AuthManager;
  client?: NewioClient;
  ws?: NewioWebSocket;
  abortController?: AbortController;
}

export interface StatusListener {
  onStatusChanged(agentId: string, status: AgentRuntimeStatus, error?: string): void;
  onApprovalUrl(agentId: string, approvalUrl: string): void;
  onConfigUpdated(agentId: string): void;
}

export class AgentRuntimeManager {
  private readonly instances = new Map<string, AgentInstance>();
  private readonly store: Store<StoreSchema>;
  private readonly configManager: AgentConfigManager;
  private readonly listener: StatusListener;

  constructor(store: Store<StoreSchema>, configManager: AgentConfigManager, listener: StatusListener) {
    this.store = store;
    this.configManager = configManager;
    this.listener = listener;
  }

  getStatus(agentId: string): { status: AgentRuntimeStatus; error?: string } {
    const instance = this.instances.get(agentId);
    return instance ? { status: instance.status, error: instance.error } : { status: 'stopped' };
  }

  start(agentId: string): void {
    const existing = this.instances.get(agentId);
    if (existing && existing.status !== 'stopped' && existing.status !== 'error') {
      return;
    }

    const config = this.configManager.get(agentId);
    if (!config) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    const auth = new AuthManager(API_BASE_URL);
    const abortController = new AbortController();
    const instance: AgentInstance = { status: 'starting', auth, abortController };
    this.instances.set(agentId, instance);
    this.setStatus(agentId, 'starting');

    void this.runStartFlow(agentId, instance).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus(agentId, 'error', message);
    });
  }

  async stop(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId);
    if (!instance) {
      return;
    }

    instance.abortController?.abort();
    instance.ws?.disconnect();

    try {
      await instance.auth.revoke();
    } catch {
      // Best-effort
    }
    instance.auth.dispose();

    const tokens = this.store.get('agentTokens');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
    const { [agentId]: _removed, ...rest } = tokens;
    this.store.set('agentTokens', rest);

    this.instances.delete(agentId);
    this.setStatus(agentId, 'stopped');
  }

  async stopAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runStartFlow(agentId: string, instance: AgentInstance): Promise<void> {
    const config = this.configManager.get(agentId);
    if (!config) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    const allTokens = this.store.get('agentTokens');
    if (agentId in allTokens) {
      const storedTokens = allTokens[agentId];
      instance.auth.setTokens(storedTokens.accessToken, storedTokens.refreshToken);
    } else {
      await this.authenticate(agentId, instance);
    }

    instance.client = new NewioClient({ baseUrl: API_BASE_URL, tokenProvider: instance.auth.tokenProvider });
    instance.ws = new NewioWebSocket({
      url: WS_URL,
      tokenProvider: instance.auth.tokenProvider,
      wsFactory: (url) => new WebSocket(url) as never,
    });

    await instance.ws.connect();
    this.setStatus(agentId, 'running');

    instance.ws.onStateChange((state) => {
      if (state === 'disconnected' && !instance.abortController?.signal.aborted) {
        this.setStatus(agentId, 'error', 'WebSocket disconnected');
      }
    });
  }

  private async authenticate(agentId: string, instance: AgentInstance): Promise<void> {
    const config = this.configManager.get(agentId);
    if (!config) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    let handle: ApprovalHandle;
    if (config.newioAgentId) {
      handle = await instance.auth.login({ agentId: config.newioAgentId });
    } else {
      handle = await instance.auth.register({ name: config.name });
    }

    this.listener.onApprovalUrl(agentId, handle.approvalUrl);
    this.setStatus(agentId, 'awaiting_approval');

    const tokens = await handle.waitForApproval({ signal: instance.abortController?.signal });

    const allTokens = this.store.get('agentTokens');
    this.store.set('agentTokens', { ...allTokens, [agentId]: tokens });

    if (!config.newioAgentId) {
      const client = new NewioClient({ baseUrl: API_BASE_URL, tokenProvider: instance.auth.tokenProvider });
      const me = await client.getMe({});
      this.configManager.setNewioIdentity(agentId, me.userId, me.username ?? '');
      this.listener.onConfigUpdated(agentId);
    }
  }

  private setStatus(agentId: string, status: AgentRuntimeStatus, error?: string): void {
    const instance = this.instances.get(agentId);
    if (instance) {
      instance.status = status;
      instance.error = error;
    }
    this.listener.onStatusChanged(agentId, status, error);
  }
}
