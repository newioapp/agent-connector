import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  waitForApproval: vi.fn(),
  dispose: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('@newio/agent-sdk', () => ({
  AuthManager: class {
    constructor(readonly baseUrl: string) {}
    register(input: { name: string }): unknown {
      return mocks.register(input);
    }
    dispose(): void {
      mocks.dispose();
    }
    tokenProvider = (): string => 'access-token';
  },
  NewioClient: class {
    constructor(readonly opts: unknown) {}
    getMe(input: unknown): unknown {
      return mocks.getMe(input);
    }
  },
}));

import { createAccount } from '../../src/main/create-account';

describe('createAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({
      agentId: 'agent-1',
      approvalUrl: 'https://approve.example',
      waitForApproval: mocks.waitForApproval,
    });
    mocks.waitForApproval.mockResolvedValue(undefined);
  });

  it('registers, surfaces the approval URL, and returns the assigned username', async () => {
    mocks.getMe.mockResolvedValue({ userId: 'agent-1', username: 'nova' });
    const onApprovalUrl = vi.fn();

    const result = await createAccount('https://api.dev', 'My Agent', onApprovalUrl);

    expect(mocks.register).toHaveBeenCalledWith({ name: 'My Agent' });
    expect(onApprovalUrl).toHaveBeenCalledWith('https://approve.example');
    expect(mocks.waitForApproval).toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(result).toEqual({ username: 'nova', agentId: 'agent-1' });
  });

  it('throws if the approved account has no username', async () => {
    mocks.getMe.mockResolvedValue({ userId: 'agent-1' });
    await expect(createAccount('https://api.dev', 'My Agent', vi.fn())).rejects.toThrow(/no username/i);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
