import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { FileAgentConfigManager } from '../src/file-agent-config-manager';

function freshDir(): string {
  const dir = join(tmpdir(), `facm-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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
    const rawConfig = readFileSync(join(dataDir, 'config.json'), 'utf8');
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

  it('deletes the .env file when the agent is removed', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot', envVars: { A: '1' } });
    const envPath = mgr.envFilePath(cfg.id);
    expect(existsSync(envPath)).toBe(true);
    mgr.remove(cfg.id);
    expect(existsSync(envPath)).toBe(false);
  });

  it('migrates legacy inline envVars from config.json into a .env file', () => {
    const id = randomUUID();
    // Write a legacy config.json with inline envVars (pre-split format).
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify([{ id, type: 'codex', newio: { username: 'bot' }, envVars: { LEGACY: 'yes' } }]),
      'utf8',
    );

    // Constructing the manager migrates it.
    const migrated = new FileAgentConfigManager(dataDir);
    expect(migrated.get(id)?.envVars).toEqual({ LEGACY: 'yes' });

    // config.json no longer carries envVars; the .env file does.
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).not.toContain('envVars');
    expect(readFileSync(migrated.envFilePath(id), 'utf8')).toContain('LEGACY=yes');
  });

  it('treats an agent with no .env file as having empty envVars', () => {
    const cfg = mgr.add({ type: 'codex', newioUsername: 'bot' });
    expect(mgr.get(cfg.id)?.envVars).toEqual({});
  });
});
