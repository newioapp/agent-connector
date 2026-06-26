import { HttpClient } from './http.js';
import { ApprovalTimeoutError, TokenRefreshError, UnauthenticatedApiError, ForbiddenApiError } from './errors.js';
import { getLogger } from './logger.js';
import type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  PollApprovalStatusResponse,
  RefreshResponse,
} from './types.js';

const log = getLogger('auth');

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
  /** Called each time a poll request is made. */
  readonly onPollAttempt?: () => void;
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
const REFRESH_BUFFER_MS = 5 * 60_000; // 5 minutes before expiry
// Retry a failed scheduled refresh on this interval until it succeeds or the
// refresh token is rejected — so a single transient failure (or a refresh that
// fired late after sleep while the network was still down) doesn't permanently
// stop auto-refresh.
const REFRESH_RETRY_MS = 60_000;

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
export interface AuthManagerOptions {
  readonly store?: TokenStore;
  /** Called whenever tokens are updated (e.g. after refresh). Use to persist tokens to disk. */
  readonly onTokensChanged?: (accessToken: string, refreshToken: string) => void;
}

export class AuthManager {
  private readonly http: HttpClient;
  private readonly store: TokenStore;
  private readonly onTokensChanged?: (accessToken: string, refreshToken: string) => void;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;

  constructor(
    private readonly baseUrl: string,
    options?: AuthManagerOptions,
  ) {
    this.http = new HttpClient(baseUrl);
    this.store = options?.store ?? new InMemoryTokenStore();
    this.onTokensChanged = options?.onTokensChanged;
  }

  /** Register a new agent. The person who approves becomes the owner. */
  async register(input: RegisterRequest): Promise<ApprovalHandle> {
    log.info(`Registering agent "${input.name}"...`);
    const res = await this.http.request<RegisterResponse>('/agents/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    log.info(`Registration submitted. Agent ID: ${res.agentId}. Approval URL: ${res.approvalUrl}`);
    return this.createApprovalHandle(res.agentId, res.approvalId, res.approvalUrl);
  }

  /** Login an existing agent. Only the owner can approve. */
  async login(input: LoginRequest): Promise<ApprovalHandle> {
    const id = 'agentId' in input ? input.agentId : input.username;
    log.info(`Logging in agent "${id}"...`);
    const res = await this.http.request<LoginResponse>('/agents/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    log.info(`Login submitted. Approval URL: ${res.approvalUrl}`);
    return this.createApprovalHandle(res.agentId, res.approvalId, res.approvalUrl);
  }

  /**
   * Set tokens directly (e.g. from persistent storage on restart).
   * Starts the auto-refresh timer.
   */
  setTokens(accessToken: string, refreshToken: string): void {
    log.debug('Setting tokens directly (from persistent storage).');
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

  /**
   * Token provider for {@link HttpClient} and {@link NewioWebSocket}. Refreshes
   * on demand: if the access token is missing, expired, or within the refresh
   * buffer of expiry, it awaits a refresh (single-flight via {@link doRefresh})
   * before returning. This is the primary recovery path after a long outage —
   * the scheduled refresh timer is a `setTimeout` that does not reliably fire
   * across laptop sleep, so a WebSocket reconnect attempt must be able to mint a
   * fresh token itself rather than reuse an expired one.
   */
  tokenProvider = async (): Promise<string> => {
    const token = this.store.getAccessToken();
    if (token && !this.isExpiringSoon(token)) {
      return token;
    }
    if (this.store.getRefreshToken()) {
      try {
        await this.doRefresh();
      } catch (err) {
        // Refresh failed (e.g. network still down). If the current token isn't
        // hard-expired we were only refreshing proactively — hand it back.
        if (token && !this.isExpired(token)) {
          return token;
        }
        throw err;
      }
      const refreshed = this.store.getAccessToken();
      if (refreshed) {
        return refreshed;
      }
    }
    // No refresh token, but a still-valid (if soon-expiring) access token: use it.
    if (token && !this.isExpired(token)) {
      return token;
    }
    throw new TokenRefreshError('Not authenticated — no access token available.');
  };

  /** Force an immediate token refresh. */
  async forceRefresh(): Promise<void> {
    log.debug('Force-refreshing tokens...');
    await this.doRefresh();
  }

  /** Revoke the current refresh token and clear stored tokens. */
  async revoke(): Promise<void> {
    log.info('Revoking tokens...');
    const refreshToken = this.store.getRefreshToken();
    if (refreshToken) {
      const authedHttp = new HttpClient(this.baseUrl, this.tokenProvider);
      try {
        await authedHttp.request('/auth/revoke', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
        log.info('Tokens revoked.');
      } catch {
        log.warn('Failed to revoke tokens on server (best-effort).');
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

    log.info(`Polling for approval (timeout: ${timeoutMs / 1000}s, interval: ${intervalMs / 1000}s)...`);

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        log.warn('Approval polling aborted by signal.');
        throw new ApprovalTimeoutError();
      }

      const pollUrl = `/approvals/${approvalId}/status${this.http.qs({ token: approvalToken })}`;
      options?.onPollAttempt?.();
      try {
        const res = await this.http.request<PollApprovalStatusResponse>(pollUrl);

        if (res.status === 'active' && res.accessToken && res.refreshToken) {
          log.info('Approval granted — tokens received.');
          this.store.setTokens(res.accessToken, res.refreshToken);
          this.scheduleRefresh(res.accessToken);
          return { accessToken: res.accessToken, refreshToken: res.refreshToken };
        }

        log.debug(`Approval status: ${res.status}. Retrying in ${intervalMs / 1000}s...`);
      } catch (err) {
        if (err instanceof UnauthenticatedApiError || err instanceof ForbiddenApiError) {
          throw err;
        }
        log.warn(`Poll attempt failed (network error?), retrying in ${intervalMs / 1000}s...`, err);
      }

      // Sleep for the interval, but cap at the remaining time until deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(Math.min(intervalMs, remaining), signal);
    }

    log.error('Approval timed out.');
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
        log.debug('Refreshing access token...');
        const res = await this.http.request<RefreshResponse>('/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
        this.store.setTokens(res.accessToken, res.refreshToken);
        this.scheduleRefresh(res.accessToken);
        this.onTokensChanged?.(res.accessToken, res.refreshToken);
        log.debug('Token refreshed successfully.');
      } catch (err) {
        log.error('Token refresh failed.', err);
        if (err instanceof UnauthenticatedApiError) {
          log.warn('Refresh token rejected by server — clearing tokens.');
          this.store.clear();
          this.clearRefreshTimer();
        }
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
    log.debug(
      `Token expires in ${Math.round(expiresInMs / 1000)}s. Scheduling refresh in ${Math.round(refreshInMs / 1000)}s.`,
    );
    this.refreshTimer = setTimeout(() => {
      void this.runScheduledRefresh();
    }, refreshInMs);
  }

  /**
   * Run a scheduled refresh, re-arming a short retry on failure so a single
   * transient error doesn't permanently stop auto-refresh. On success {@link
   * doRefresh} re-arms the normal pre-expiry timer; on a 401 the refresh token is
   * cleared, so there is nothing left to retry and the retry loop stops.
   */
  private async runScheduledRefresh(): Promise<void> {
    try {
      await this.doRefresh();
    } catch {
      if (this.store.getRefreshToken()) {
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
          void this.runScheduledRefresh();
        }, REFRESH_RETRY_MS);
      }
    }
  }

  /** True when the token is malformed, missing its exp, or within the refresh buffer of expiry. */
  private isExpiringSoon(token: string): boolean {
    return this.getTokenExpiresInMs(token) <= REFRESH_BUFFER_MS;
  }

  /** True when the token is malformed or already past its exp. */
  private isExpired(token: string): boolean {
    return this.getTokenExpiresInMs(token) <= 0;
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
