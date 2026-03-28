import { HttpClient } from './http.js';
import { ApprovalTimeoutError, TokenRefreshError } from './errors.js';
import type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  PollApprovalStatusResponse,
  RefreshResponse,
} from './types.js';

/** Pluggable token storage interface. */
export interface TokenStore {
  getAccessToken(): string | undefined;
  getRefreshToken(): string | undefined;
  setTokens(accessToken: string, refreshToken: string): void;
  clear(): void;
}

/** In-memory token store (default). */
export class InMemoryTokenStore implements TokenStore {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  setTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  clear(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
  }
}

/** Options for the approval polling loop. */
export interface WaitForApprovalOptions {
  /** Polling interval in milliseconds. Default: 3000. */
  readonly intervalMs?: number;
  /** Maximum time to wait in milliseconds. Default: 600000 (10 minutes). */
  readonly timeoutMs?: number;
  /** Abort signal to cancel polling. */
  readonly signal?: AbortSignal;
}

/** Handle returned by register/login — call `waitForApproval()` to get tokens. */
export interface ApprovalHandle {
  readonly agentId: string;
  readonly approvalId: string;
  readonly approvalUrl: string;
  /** Polls until the owner approves and tokens are issued. */
  waitForApproval(options?: WaitForApprovalOptions): Promise<{ accessToken: string; refreshToken: string }>;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const REFRESH_BUFFER_MS = 60_000;

/**
 * Manages agent authentication — registration, login, token refresh.
 *
 * @example
 * ```ts
 * const auth = new AuthManager('https://api.newio.dev');
 * const handle = await auth.register({ name: 'My Agent' });
 * console.log(`Approve at: ${handle.approvalUrl}`);
 * const tokens = await handle.waitForApproval();
 * ```
 */
export class AuthManager {
  private readonly http: HttpClient;
  private readonly store: TokenStore;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;

  constructor(
    private readonly baseUrl: string,
    store?: TokenStore,
  ) {
    this.http = new HttpClient(baseUrl);
    this.store = store ?? new InMemoryTokenStore();
  }

  /** Register a new agent. The person who approves becomes the owner. */
  async register(input: RegisterRequest): Promise<ApprovalHandle> {
    const res = await this.http.request<RegisterResponse>('/mcp/agents/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return this.createApprovalHandle(res.agentId, res.approvalId, res.approvalUrl);
  }

  /** Login an existing agent. Only the owner can approve. */
  async login(input: LoginRequest): Promise<ApprovalHandle> {
    const res = await this.http.request<LoginResponse>('/mcp/agents/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return this.createApprovalHandle(res.agentId, res.approvalId, res.approvalUrl);
  }

  /**
   * Set tokens directly (e.g. from persistent storage on restart).
   * Starts the auto-refresh timer.
   */
  setTokens(accessToken: string, refreshToken: string): void {
    this.store.setTokens(accessToken, refreshToken);
    this.scheduleRefresh(accessToken);
  }

  /** Get the current access token, or undefined if not authenticated. */
  getAccessToken(): string | undefined {
    return this.store.getAccessToken();
  }

  /** Get the current refresh token, or undefined if not authenticated. */
  getRefreshToken(): string | undefined {
    return this.store.getRefreshToken();
  }

  /** Token provider function suitable for passing to HttpClient. */
  tokenProvider = (): string => {
    const token = this.store.getAccessToken();
    if (!token) {
      throw new TokenRefreshError('Not authenticated — no access token available.');
    }
    return token;
  };

  /** Force an immediate token refresh. */
  async forceRefresh(): Promise<void> {
    await this.doRefresh();
  }

  /** Revoke the current refresh token and clear stored tokens. */
  async revoke(): Promise<void> {
    const refreshToken = this.store.getRefreshToken();
    if (refreshToken) {
      const authedHttp = new HttpClient(this.baseUrl, this.tokenProvider);
      try {
        await authedHttp.request('/auth/revoke', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // Best-effort — clear tokens regardless
      }
    }
    this.clearRefreshTimer();
    this.store.clear();
  }

  /** Stop the auto-refresh timer. Call when shutting down. */
  dispose(): void {
    this.clearRefreshTimer();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private createApprovalHandle(agentId: string, approvalId: string, approvalUrl: string): ApprovalHandle {
    const approvalToken = new URL(approvalUrl).searchParams.get('token') ?? '';
    return {
      agentId,
      approvalId,
      approvalUrl,
      waitForApproval: (options?: WaitForApprovalOptions) => this.pollForApproval(approvalId, approvalToken, options),
    };
  }

  private async pollForApproval(
    approvalId: string,
    approvalToken: string,
    options?: WaitForApprovalOptions,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const signal = options?.signal;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new ApprovalTimeoutError();
      }

      const pollUrl = `/approvals/${approvalId}/status${this.http.qs({ token: approvalToken })}`;
      const res = await this.http.request<PollApprovalStatusResponse>(pollUrl);

      if (res.status === 'active' && res.accessToken && res.refreshToken) {
        this.store.setTokens(res.accessToken, res.refreshToken);
        this.scheduleRefresh(res.accessToken);
        return { accessToken: res.accessToken, refreshToken: res.refreshToken };
      }

      // Sleep for the interval, but cap at the remaining time until deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(intervalMs, remaining), signal);
    }

    throw new ApprovalTimeoutError();
  }

  private async doRefresh(): Promise<void> {
    // Dedup concurrent refresh calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const refreshToken = this.store.getRefreshToken();
      if (!refreshToken) {
        throw new TokenRefreshError('No refresh token available.');
      }

      try {
        const res = await this.http.request<RefreshResponse>('/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
        this.store.setTokens(res.accessToken, res.refreshToken);
        this.scheduleRefresh(res.accessToken);
      } catch (err) {
        this.store.clear();
        this.clearRefreshTimer();
        throw new TokenRefreshError(err instanceof Error ? err.message : 'Token refresh failed.');
      }
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private scheduleRefresh(accessToken: string): void {
    this.clearRefreshTimer();
    const expiresInMs = this.getTokenExpiresInMs(accessToken);
    if (expiresInMs <= 0) {
      return;
    }
    const refreshInMs = Math.max(expiresInMs - REFRESH_BUFFER_MS, 0);
    this.refreshTimer = setTimeout(() => {
      void this.doRefresh();
    }, refreshInMs);
  }

  private getTokenExpiresInMs(token: string): number {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return 0;
      }
      const payloadPart = parts[1];
      if (!payloadPart) {
        return 0;
      }
      const payload = JSON.parse(atob(payloadPart)) as Record<string, unknown>;
      const exp = payload['exp'];
      if (typeof exp !== 'number') {
        return 0;
      }
      return exp * 1000 - Date.now();
    } catch {
      return 0;
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ApprovalTimeoutError());
        },
        { once: true },
      );
    });
  }
}
