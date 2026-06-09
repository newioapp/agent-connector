import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentInstanceImpl } from '../src/agent-instance-impl';
import type { AgentConfigManager } from '../src/agent-config-manager';
import type { AgentInstanceListener } from '../src/agent-instance';
import type { AgentConfig, AgentType, AcpConfig } from '../src/types';
import type { CronStore } from '../src/cron-store';
import type { EngineConfig } from '../src/engine-config';
import { adaptersRoot, setActiveVersion, versionDir } from '../src/adapters/adapter-store';

const CODEX_PKG = '@zed-industries/codex-acp';
const ENOENT: NodeJS.ErrnoException = Object.assign(new Error('spawn codex-acp ENOENT'), { code: 'ENOENT' });

let tmp: string;
let ensure: ReturnType<typeof vi.fn>;

function build(opts: {
  readonly type: AgentType;
  readonly acp?: AcpConfig;
  readonly withEnsure?: boolean;
}): AgentInstanceImpl {
  const config: AgentConfig = { id: 'agent-1', type: opts.type, envVars: {}, ...(opts.acp ? { acp: opts.acp } : {}) };
  const engineConfig: EngineConfig = {
    apiBaseUrl: '',
    wsUrl: '',
    stage: 'dev',
    appDisplayName: 'Test',
    appVersion: '0.0.1',
    dataDir: tmp,
    mcpBridgeCommand: 'node',
    mcpBridgeArgsPrefix: ['/tmp/bridge.js'],
    ...(opts.withEnsure === false ? {} : { ensureAdapterInstalled: ensure }),
  };
  const listener = {
    onStatusChanged: vi.fn(),
    onApprovalUrl: vi.fn(),
    onPollAttempt: vi.fn(),
    onConfigUpdated: vi.fn(),
    onAgentInfo: vi.fn(),
  } satisfies AgentInstanceListener;
  return new AgentInstanceImpl(config, {} as AgentConfigManager, {} as CronStore, listener, engineConfig);
}

/** Call the private tryAutoInstallAdapter, mirroring the file's other private-method tests. */
function tryAutoInstall(instance: AgentInstanceImpl, err: unknown): Promise<boolean> {
  const fn = (instance as unknown as Record<string, (e: unknown) => Promise<boolean>>)['tryAutoInstallAdapter']!;
  return fn.call(instance, err);
}

function fakeCodexInstall(): void {
  const root = adaptersRoot(tmp);
  const pkgDir = join(versionDir(root, 'codex', '0.16.0'), 'node_modules', CODEX_PKG);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ bin: { 'codex-acp': 'bin/codex-acp.js' } }));
  setActiveVersion(root, 'codex', '0.16.0');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'auto-install-'));
  ensure = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('AgentInstanceImpl.tryAutoInstallAdapter', () => {
  it('installs a missing managed adapter on ENOENT and signals a retry', async () => {
    const instance = build({ type: 'codex' });
    expect(await tryAutoInstall(instance, ENOENT)).toBe(true);
    expect(ensure).toHaveBeenCalledWith('codex');
  });

  it('does nothing for a non-ENOENT error', async () => {
    const instance = build({ type: 'codex' });
    expect(await tryAutoInstall(instance, new Error('boom'))).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does nothing when the connector has no installer wired', async () => {
    const instance = build({ type: 'codex', withEnsure: false });
    expect(await tryAutoInstall(instance, ENOENT)).toBe(false);
  });

  it('does nothing when an executablePath override is set', async () => {
    const instance = build({ type: 'codex', acp: { cwd: '/tmp', executablePath: '/usr/local/bin/codex-acp' } });
    expect(await tryAutoInstall(instance, ENOENT)).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does nothing for an unmanaged agent type', async () => {
    const instance = build({ type: 'kiro-cli' });
    expect(await tryAutoInstall(instance, ENOENT)).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does not reinstall when the adapter is already installed (e.g. ENOENT is really a missing node)', async () => {
    fakeCodexInstall();
    const instance = build({ type: 'codex' });
    expect(await tryAutoInstall(instance, ENOENT)).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });
});
