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
      const handle = await auth.login({ username: 'my-agent' });

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
      const auth = new AuthManager('https://api.newio.dev', store);
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
    it('should store tokens and make them available via tokenProvider', () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = fakeJwt(exp);

      const auth = new AuthManager('https://api.newio.dev');
      auth.setTokens(accessToken, 'refresh-1');

      expect(auth.getAccessToken()).toBe(accessToken);
      expect(auth.getRefreshToken()).toBe('refresh-1');
      expect(auth.tokenProvider()).toBe(accessToken);

      auth.dispose();
    });
  });

  describe('tokenProvider', () => {
    it('should throw when not authenticated', () => {
      const auth = new AuthManager('https://api.newio.dev');
      expect(() => auth.tokenProvider()).toThrow(TokenRefreshError);
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

      const auth = new AuthManager('https://api.newio.dev', store);
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

      const auth = new AuthManager('https://api.newio.dev', store);

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

      const auth = new AuthManager('https://api.newio.dev', store);
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

      const auth = new AuthManager('https://api.newio.dev', store);
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
});
