import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager, InMemoryTokenStore } from '../src/core/auth.js';
import { ApprovalTimeoutError, TokenRefreshError } from '../src/core/errors.js';

// Helper: create a fake JWT with a given exp (seconds since epoch)
function fakeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub: 'agent-1', exp }));
  return `${header}.${payload}.signature`;
}

// Helper: mock fetch globally
function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  let callIndex = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const res = responses[callIndex++];
      if (!res) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: () => Promise.resolve(res.body),
      });
    }),
  );
}

describe('AuthManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('should call register endpoint and return an approval handle', async () => {
      mockFetch([
        {
          status: 201,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-1',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-1&token=secret-token',
          },
        },
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.register({ name: 'Test Agent' });

      expect(handle.agentId).toBe('agent-1');
      expect(handle.approvalId).toBe('approval-1');
      expect(handle.approvalUrl).toContain('approval-1');
      expect(typeof handle.waitForApproval).toBe('function');

      auth.dispose();
    });
  });

  describe('login', () => {
    it('should call login endpoint with agentId and return an approval handle', async () => {
      mockFetch([
        {
          status: 200,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-2',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-2&token=secret-token',
          },
        },
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.login({ agentId: 'agent-1' });

      expect(handle.agentId).toBe('agent-1');
      expect(handle.approvalId).toBe('approval-2');

      auth.dispose();
    });

    it('should call login endpoint with username and return an approval handle', async () => {
      mockFetch([
        {
          status: 200,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-3',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-3&token=secret-token',
          },
        },
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.login({ username: 'my_agent' });

      expect(handle.agentId).toBe('agent-1');
      expect(handle.approvalId).toBe('approval-3');

      auth.dispose();
    });
  });

  describe('waitForApproval', () => {
    it('should poll until approved and store tokens', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = fakeJwt(exp);

      mockFetch([
        // register
        {
          status: 201,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-1',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-1&token=tok',
          },
        },
        // poll 1 — still pending
        { status: 200, body: { status: 'pending_approval' } },
        // poll 2 — approved
        { status: 200, body: { status: 'active', accessToken, refreshToken: 'refresh-1' } },
      ]);

      const store = new InMemoryTokenStore();
      const auth = new AuthManager('https://api.newio.dev', { store });
      const handle = await auth.register({ name: 'Test Agent' });

      const approvalPromise = handle.waitForApproval({ intervalMs: 100 });

      // Advance past first poll interval
      await vi.advanceTimersByTimeAsync(100);
      // Advance past second poll interval
      await vi.advanceTimersByTimeAsync(100);

      const tokens = await approvalPromise;

      expect(tokens.accessToken).toBe(accessToken);
      expect(tokens.refreshToken).toBe('refresh-1');
      expect(store.getAccessToken()).toBe(accessToken);
      expect(store.getRefreshToken()).toBe('refresh-1');

      auth.dispose();
    });

    it('should throw ApprovalTimeoutError when timeout is exceeded', async () => {
      mockFetch([
        // register
        {
          status: 201,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-1',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-1&token=tok',
          },
        },
        // All polls return pending
        ...Array.from({ length: 20 }, () => ({ status: 200, body: { status: 'pending_approval' } })),
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.register({ name: 'Test Agent' });

      // Capture the promise and attach a no-op catch to prevent unhandled rejection
      let caughtError: unknown;
      const approvalPromise = handle.waitForApproval({ intervalMs: 50, timeoutMs: 120 }).catch((err: unknown) => {
        caughtError = err;
      });

      // Advance enough for the timeout to expire
      await vi.advanceTimersByTimeAsync(200);
      await approvalPromise;

      expect(caughtError).toBeInstanceOf(ApprovalTimeoutError);

      auth.dispose();
    });

    it('should abort when signal is triggered', async () => {
      mockFetch([
        {
          status: 201,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-1',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-1&token=tok',
          },
        },
        { status: 200, body: { status: 'pending_approval' } },
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.register({ name: 'Test Agent' });

      const controller = new AbortController();
      const approvalPromise = handle.waitForApproval({
        intervalMs: 10000,
        timeoutMs: 60000,
        signal: controller.signal,
      });

      // Let the first poll (fetch) resolve, then the loop enters sleep(10000)
      await vi.advanceTimersByTimeAsync(0);

      // Abort while sleeping — the sleep promise should reject immediately
      controller.abort();

      await expect(approvalPromise).rejects.toThrow(ApprovalTimeoutError);

      auth.dispose();
    });
  });

  describe('setTokens', () => {
    it('should store tokens and make them available via tokenProvider', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = fakeJwt(exp);

      const auth = new AuthManager('https://api.newio.dev');
      auth.setTokens(accessToken, 'refresh-1');

      expect(auth.getAccessToken()).toBe(accessToken);
      expect(auth.getRefreshToken()).toBe('refresh-1');
      // A still-valid token is returned without hitting the network.
      expect(await auth.tokenProvider()).toBe(accessToken);

      auth.dispose();
    });
  });

  describe('tokenProvider', () => {
    it('should reject when not authenticated', async () => {
      const auth = new AuthManager('https://api.newio.dev');
      await expect(auth.tokenProvider()).rejects.toThrow(TokenRefreshError);
      auth.dispose();
    });

    it('should refresh on demand when the access token is expired', async () => {
      // Access token already expired; refresh token still valid.
      const expiredToken = fakeJwt(Math.floor(Date.now() / 1000) - 60);
      const freshToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
      mockFetch([{ status: 200, body: { accessToken: freshToken, refreshToken: 'refresh-2' } }]);

      const store = new InMemoryTokenStore();
      store.setTokens(expiredToken, 'refresh-1');
      const auth = new AuthManager('https://api.newio.dev', { store });

      const token = await auth.tokenProvider();

      expect(token).toBe(freshToken);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      auth.dispose();
    });

    it('should dedup concurrent on-demand refreshes into one request', async () => {
      const expiredToken = fakeJwt(Math.floor(Date.now() / 1000) - 60);
      const freshToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
      mockFetch([{ status: 200, body: { accessToken: freshToken, refreshToken: 'refresh-2' } }]);

      const store = new InMemoryTokenStore();
      store.setTokens(expiredToken, 'refresh-1');
      const auth = new AuthManager('https://api.newio.dev', { store });

      const [a, b] = await Promise.all([auth.tokenProvider(), auth.tokenProvider()]);

      expect(a).toBe(freshToken);
      expect(b).toBe(freshToken);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      auth.dispose();
    });

    it('should fall back to a still-valid token when a proactive refresh fails', async () => {
      // Token within the 5-min buffer (refresh attempted) but not yet expired.
      const soonToken = fakeJwt(Math.floor(Date.now() / 1000) + 120);
      mockFetch([{ status: 500, body: null }]);

      const store = new InMemoryTokenStore();
      store.setTokens(soonToken, 'refresh-1');
      const auth = new AuthManager('https://api.newio.dev', { store });

      // Refresh fails, but the current token is still valid so connect can proceed.
      expect(await auth.tokenProvider()).toBe(soonToken);
      auth.dispose();
    });
  });

  describe('forceRefresh', () => {
    it('should refresh tokens and update the store', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const oldToken = fakeJwt(exp);
      const newToken = fakeJwt(exp + 3600);

      mockFetch([{ status: 200, body: { accessToken: newToken, refreshToken: 'refresh-2' } }]);

      const store = new InMemoryTokenStore();
      store.setTokens(oldToken, 'refresh-1');

      const auth = new AuthManager('https://api.newio.dev', { store });
      await auth.forceRefresh();

      expect(store.getAccessToken()).toBe(newToken);
      expect(store.getRefreshToken()).toBe('refresh-2');

      auth.dispose();
    });

    it('should dedup concurrent refresh calls', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const newToken = fakeJwt(exp);

      mockFetch([{ status: 200, body: { accessToken: newToken, refreshToken: 'refresh-2' } }]);

      const store = new InMemoryTokenStore();
      store.setTokens(fakeJwt(exp), 'refresh-1');

      const auth = new AuthManager('https://api.newio.dev', { store });

      // Call forceRefresh twice concurrently
      const [r1, r2] = await Promise.all([auth.forceRefresh(), auth.forceRefresh()]);

      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      // fetch should only have been called once
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      auth.dispose();
    });
  });

  describe('revoke', () => {
    it('should call revoke endpoint and clear tokens', async () => {
      mockFetch([{ status: 200, body: { success: true } }]);

      const exp = Math.floor(Date.now() / 1000) + 3600;
      const store = new InMemoryTokenStore();
      store.setTokens(fakeJwt(exp), 'refresh-1');

      const auth = new AuthManager('https://api.newio.dev', { store });
      await auth.revoke();

      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();

      auth.dispose();
    });

    it('should clear tokens even if revoke endpoint fails', async () => {
      mockFetch([{ status: 500, body: null }]);

      const exp = Math.floor(Date.now() / 1000) + 3600;
      const store = new InMemoryTokenStore();
      store.setTokens(fakeJwt(exp), 'refresh-1');

      const auth = new AuthManager('https://api.newio.dev', { store });
      await auth.revoke();

      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();

      auth.dispose();
    });
  });

  describe('InMemoryTokenStore', () => {
    it('should store and retrieve tokens', () => {
      const store = new InMemoryTokenStore();
      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();

      store.setTokens('access', 'refresh');
      expect(store.getAccessToken()).toBe('access');
      expect(store.getRefreshToken()).toBe('refresh');

      store.clear();
      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();
    });
  });

  describe('forceRefresh — error handling', () => {
    it('should clear tokens and throw TokenRefreshError when refresh fails', async () => {
      mockFetch([{ status: 401, body: { error: 'Invalid refresh token', errorCode: 'UNAUTHENTICATED' } }]);

      const exp = Math.floor(Date.now() / 1000) + 3600;
      const store = new InMemoryTokenStore();
      store.setTokens(fakeJwt(exp), 'refresh-1');

      const auth = new AuthManager('https://api.newio.dev', { store });
      await expect(auth.forceRefresh()).rejects.toThrow(TokenRefreshError);

      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();

      auth.dispose();
    });

    it('should throw TokenRefreshError when no refresh token is available', async () => {
      const auth = new AuthManager('https://api.newio.dev');
      await expect(auth.forceRefresh()).rejects.toThrow('No refresh token available.');
      auth.dispose();
    });
  });

  describe('auto-refresh scheduling', () => {
    it('should auto-refresh before token expires', async () => {
      // Token expires in 10 minutes — refresh should fire at 5min (600 - 300 buffer)
      const exp = Math.floor(Date.now() / 1000) + 600;
      const oldToken = fakeJwt(exp);
      const newToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);

      mockFetch([{ status: 200, body: { accessToken: newToken, refreshToken: 'refresh-2' } }]);

      const store = new InMemoryTokenStore();
      const auth = new AuthManager('https://api.newio.dev', { store });
      auth.setTokens(oldToken, 'refresh-1');

      // Advance past the scheduled refresh time (600s - 300s buffer = 300s)
      await vi.advanceTimersByTimeAsync(301_000);

      expect(store.getAccessToken()).toBe(newToken);

      auth.dispose();
    });

    it('should retry a failed scheduled refresh instead of giving up', async () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const oldToken = fakeJwt(exp);
      const newToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);

      // First scheduled refresh fails (transient); the retry succeeds.
      mockFetch([
        { status: 500, body: null },
        { status: 200, body: { accessToken: newToken, refreshToken: 'refresh-2' } },
      ]);

      const store = new InMemoryTokenStore();
      const auth = new AuthManager('https://api.newio.dev', { store });
      auth.setTokens(oldToken, 'refresh-1');

      // Fire the scheduled refresh (300s) — fails, leaving the old token in place.
      await vi.advanceTimersByTimeAsync(301_000);
      expect(store.getAccessToken()).toBe(oldToken);

      // The retry timer (60s) fires and recovers.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.getAccessToken()).toBe(newToken);

      auth.dispose();
    });

    it('should stop retrying once the refresh token is rejected (401)', async () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const oldToken = fakeJwt(exp);
      mockFetch([{ status: 401, body: { error: 'bad refresh', errorCode: 'UNAUTHENTICATED' } }]);

      const store = new InMemoryTokenStore();
      const auth = new AuthManager('https://api.newio.dev', { store });
      auth.setTokens(oldToken, 'refresh-1');

      await vi.advanceTimersByTimeAsync(301_000);
      // 401 clears tokens — no refresh token left, so no retry is armed.
      expect(store.getRefreshToken()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      auth.dispose();
    });

    it('should not retry a terminal auth failure (403 forbidden refresh token)', async () => {
      const exp = Math.floor(Date.now() / 1000) + 600;
      const oldToken = fakeJwt(exp);
      mockFetch([{ status: 403, body: { error: 'forbidden', errorCode: 'FORBIDDEN' } }]);

      const store = new InMemoryTokenStore();
      const auth = new AuthManager('https://api.newio.dev', { store });
      auth.setTokens(oldToken, 'refresh-1');

      await vi.advanceTimersByTimeAsync(301_000);
      // Terminal (auth) failure clears tokens and arms no retry.
      expect(store.getRefreshToken()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

      auth.dispose();
    });
  });

  describe('waitForApproval — onPollAttempt callback', () => {
    it('should call onPollAttempt on each poll', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = fakeJwt(exp);

      mockFetch([
        {
          status: 201,
          body: {
            agentId: 'agent-1',
            approvalId: 'approval-1',
            status: 'pending_approval',
            approvalUrl: 'https://newio.dev/approve?approvalId=approval-1&token=tok',
          },
        },
        { status: 200, body: { status: 'pending_approval' } },
        { status: 200, body: { status: 'active', accessToken, refreshToken: 'refresh-1' } },
      ]);

      const auth = new AuthManager('https://api.newio.dev');
      const handle = await auth.register({ name: 'Test Agent' });

      let pollCount = 0;
      const approvalPromise = handle.waitForApproval({
        intervalMs: 100,
        onPollAttempt: () => pollCount++,
      });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      await approvalPromise;

      expect(pollCount).toBe(2);

      auth.dispose();
    });
  });
});

describe('AuthManager — onTokensChanged callback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should call onTokensChanged on successful auto-refresh', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const oldToken = fakeJwt(exp);
    const newToken = fakeJwt(Math.floor(Date.now() / 1000) + 3600);

    mockFetch([{ status: 200, body: { accessToken: newToken, refreshToken: 'refresh-2' } }]);

    const onTokensChanged = vi.fn();
    const store = new InMemoryTokenStore();
    const auth = new AuthManager('https://api.newio.dev', { store, onTokensChanged });
    auth.setTokens(oldToken, 'refresh-1');

    await vi.advanceTimersByTimeAsync(301_000);

    expect(onTokensChanged).toHaveBeenCalledOnce();
    expect(onTokensChanged).toHaveBeenCalledWith(newToken, 'refresh-2');

    auth.dispose();
  });

  it('should call onTokensChanged on forceRefresh', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const newToken = fakeJwt(exp);

    mockFetch([{ status: 200, body: { accessToken: newToken, refreshToken: 'refresh-new' } }]);

    const onTokensChanged = vi.fn();
    const store = new InMemoryTokenStore();
    const auth = new AuthManager('https://api.newio.dev', { store, onTokensChanged });
    auth.setTokens(fakeJwt(Math.floor(Date.now() / 1000) + 60), 'refresh-old');

    await auth.forceRefresh();

    expect(onTokensChanged).toHaveBeenCalledOnce();
    expect(onTokensChanged).toHaveBeenCalledWith(newToken, 'refresh-new');

    auth.dispose();
  });

  it('should not call onTokensChanged when refresh fails', async () => {
    mockFetch([{ status: 401, body: { message: 'invalid' } }]);

    const onTokensChanged = vi.fn();
    const store = new InMemoryTokenStore();
    const auth = new AuthManager('https://api.newio.dev', { store, onTokensChanged });
    auth.setTokens(fakeJwt(Math.floor(Date.now() / 1000) + 60), 'refresh-old');

    await expect(auth.forceRefresh()).rejects.toThrow(TokenRefreshError);
    expect(onTokensChanged).not.toHaveBeenCalled();

    auth.dispose();
  });
});
