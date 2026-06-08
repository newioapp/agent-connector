import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { FileAgentConfigManager } from '../src/file-agent-config-manager';

function freshDir(): string {
  const dir = join(tmpdir(), `facm-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path of an agent's directory under the data dir. */
function agentDir(dataDir: string, agentId: string): string {
  return join(dataDir, 'agents', agentId);
}

describe('FileAgentConfigManager env files', () => {
  let dataDir: string;
  let mgr: FileAgentConfigManager;

  beforeEach(() => {
    dataDir = freshDir();
    mgr = new FileAgentConfigManager(dataDir);
  });

  it('stores envVars in a per-agent .env file, not config.json', () => {
    const cfg = mgr.add({ type: 'claude-code', newioUsername: 'bot', envVars: { API_KEY: 'secret', FOO: 'bar' } });

    // .env file exists and holds the vars
    const envPath = mgr.envFilePath(cfg.id);
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toContain('API_KEY=secret');

    // config.json does NOT contain envVars
    const rawConfig = readFileSync(join(agentDir(dataDir, cfg.id), 'config.json'), 'utf8');
    expect(rawConfig).not.toContain('envVars');
    expect(rawConfig).not.toContain('secret');
  });

  it('hydrates envVars from the .env file on read', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot', envVars: { A: '1' } });
    // Fresh instance reads from disk
    const reloaded = new FileAgentConfigManager(dataDir).get(cfg.id);
    expect(reloaded?.envVars).toEqual({ A: '1' });
  });

  it('replaces envVars on update without touching other fields', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot', envVars: { A: '1', B: '2' } });
    const updated = mgr.update(cfg.id, { envVars: { C: '3' } });
    expect(updated.envVars).toEqual({ C: '3' });
    expect(updated.newio?.username).toBe('bot');
    expect(new FileAgentConfigManager(dataDir).get(cfg.id)?.envVars).toEqual({ C: '3' });
  });

  it('leaves the .env file untouched when an update omits envVars', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot', envVars: { A: '1' } });
    mgr.update(cfg.id, { sessionMode: 'shared' });
    expect(mgr.get(cfg.id)?.envVars).toEqual({ A: '1' });
  });

  it('removes the whole agent directory when the agent is removed', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot', envVars: { A: '1' } });
    const dir = agentDir(dataDir, cfg.id);
    expect(existsSync(dir)).toBe(true);
    mgr.remove(cfg.id);
    expect(existsSync(dir)).toBe(false);
    expect(mgr.get(cfg.id)).toBeUndefined();
  });

  it('treats an agent with no .env file as having empty envVars', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    expect(mgr.get(cfg.id)?.envVars).toEqual({});
  });

  it('throws not-found when removing an id with no stored config', () => {
    expect(() => mgr.remove(randomUUID())).toThrow(/not found/);
  });

  it('does not remove a stray directory that has no config.json', () => {
    const strayId = randomUUID();
    mkdirSync(join(dataDir, 'agents', strayId), { recursive: true });
    expect(() => mgr.remove(strayId)).toThrow(/not found/);
    expect(existsSync(join(dataDir, 'agents', strayId))).toBe(true);
  });
});

describe('FileAgentConfigManager tokens', () => {
  let dataDir: string;
  let mgr: FileAgentConfigManager;

  beforeEach(() => {
    dataDir = freshDir();
    mgr = new FileAgentConfigManager(dataDir);
  });

  it('persists tokens to a per-agent .credentials.json file', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    mgr.setTokens(cfg.id, { accessToken: 'access-1', refreshToken: 'refresh-1' });

    const credPath = join(agentDir(dataDir, cfg.id), '.credentials.json');
    expect(existsSync(credPath)).toBe(true);

    // A fresh instance reads them back from disk.
    expect(new FileAgentConfigManager(dataDir).getTokens(cfg.id)).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  });

  it('returns undefined tokens for an agent that has none', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    expect(mgr.getTokens(cfg.id)).toBeUndefined();
  });

  it('clears tokens without removing the agent', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    mgr.setTokens(cfg.id, { accessToken: 'a', refreshToken: 'r' });
    mgr.clearTokens(cfg.id);
    expect(mgr.getTokens(cfg.id)).toBeUndefined();
    expect(mgr.get(cfg.id)).toBeDefined();
  });

  it('clears tokens when the username changes', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    mgr.setTokens(cfg.id, { accessToken: 'a', refreshToken: 'r' });
    mgr.update(cfg.id, { newioUsername: 'bot2' });
    expect(mgr.getTokens(cfg.id)).toBeUndefined();
  });

  it("keeps each agent's tokens isolated", () => {
    const a = mgr.add({ type: 'codex', newioUsername: 'a' });
    const b = mgr.add({ type: 'codex', newioUsername: 'b' });
    mgr.setTokens(a.id, { accessToken: 'a-access', refreshToken: 'a-refresh' });
    mgr.setTokens(b.id, { accessToken: 'b-access', refreshToken: 'b-refresh' });
    expect(mgr.getTokens(a.id)?.accessToken).toBe('a-access');
    expect(mgr.getTokens(b.id)?.accessToken).toBe('b-access');
  });
});

describe('FileAgentConfigManager listing', () => {
  let dataDir: string;
  let mgr: FileAgentConfigManager;

  beforeEach(() => {
    dataDir = freshDir();
    mgr = new FileAgentConfigManager(dataDir);
  });

  it('lists all added agents', () => {
    const a = mgr.add({ type: 'codex', newioUsername: 'a' });
    const b = mgr.add({ type: 'claude-code', newioUsername: 'b' });
    const ids = mgr.list().map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toHaveLength(2);
  });

  it('returns an empty list for a fresh data dir', () => {
    expect(mgr.list()).toEqual([]);
  });

  it('drops a removed agent from the listing', () => {
    const a = mgr.add({ type: 'codex', newioUsername: 'a' });
    mgr.add({ type: 'codex', newioUsername: 'b' });
    mgr.remove(a.id);
    expect(mgr.list().map((c) => c.id)).not.toContain(a.id);
    expect(mgr.list()).toHaveLength(1);
  });
});

describe('FileAgentConfigManager path-traversal safety', () => {
  let dataDir: string;
  let mgr: FileAgentConfigManager;

  beforeEach(() => {
    dataDir = freshDir();
    mgr = new FileAgentConfigManager(dataDir);
  });

  // '..' resolves to dataDir itself; without validation remove() would rmSync it.
  for (const bad of ['..', '../..', 'a/b', '.']) {
    it(`rejects a traversal id ${JSON.stringify(bad)} on remove without touching the filesystem`, () => {
      const sentinel = join(dataDir, 'SENTINEL');
      writeFileSync(sentinel, 'keep me');
      expect(() => mgr.remove(bad)).toThrow(/Invalid agent id/);
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(dataDir)).toBe(true);
    });

    it(`rejects a traversal id ${JSON.stringify(bad)} on get/getTokens/envFilePath`, () => {
      expect(() => mgr.get(bad)).toThrow(/Invalid agent id/);
      expect(() => mgr.getTokens(bad)).toThrow(/Invalid agent id/);
      expect(() => mgr.envFilePath(bad)).toThrow(/Invalid agent id/);
    });
  }
});
