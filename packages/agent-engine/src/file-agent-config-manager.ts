/**
 * File-based agent config manager — persists agent configs and tokens to a data directory.
 *
 * Platform-agnostic (pure node:fs + node:os). Used by both the Electron desktop app
 * and the CLI daemon.
 *
 * Files:
 *   config.json        — AgentConfig[] without envVars (0o600)
 *   tokens.json        — Record<string, AgentTokens> (0o600)
 *   envs/<agentId>.env — per-agent environment variables in dotenv format (0o600).
 *                        Kept separate from config.json so secrets live in a
 *                        single, hand-editable file (see `newio agent env edit`).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from './types';
import type { AgentConfigManager, AgentTokens } from './agent-config-manager';
import { serializeEnvVars, parseEnvVars, agentEnvFilePath } from './env-file';
import { getLogger } from '@newio/agent-sdk';

const log = getLogger('file-agent-config-manager');

/** Shape stored in config.json: an AgentConfig minus its envVars, which live in a separate .env file. */
type StoredAgentConfig = Omit<AgentConfig, 'envVars'>;

export class FileAgentConfigManager implements AgentConfigManager {
  private readonly configPath: string;
  private readonly tokensPath: string;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, 'config.json');
    this.tokensPath = join(dataDir, 'tokens.json');
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      log.info(`Created ${this.dataDir}`);
    }
  }

  list(): AgentConfig[] {
    return this.readStored().map((stored) => this.hydrate(stored));
  }

  get(agentId: string): AgentConfig | undefined {
    return this.list().find((a) => a.id === agentId);
  }

  add(input: AddAgentInput): AgentConfig {
    const id = randomUUID();
    const envVars = input.envVars ?? {};
    const stored: StoredAgentConfig = {
      id,
      type: input.type,
      // Display name is left unset here; it's synced from the account on first login.
      newio: { username: input.newioUsername },
      ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode } : {}),
      ...(input.acp ? { acp: input.acp } : {}),
    };
    this.writeStored([...this.readStored(), stored]);
    this.writeEnvVars(id, envVars);
    return { ...stored, envVars };
  }

  update(agentId: string, updates: UpdateAgentInput): AgentConfig {
    const stored = this.readStored();
    const index = stored.findIndex((a) => a.id === agentId);
    const existing = stored[index];
    if (!existing) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const usernameChanged = updates.newioUsername !== undefined && updates.newioUsername !== existing.newio?.username;
    const displayName = updates.displayName ?? existing.newio?.displayName;
    let newio = existing.newio;
    if (usernameChanged) {
      newio = { displayName, ...(updates.newioUsername ? { username: updates.newioUsername } : {}) };
    } else if (updates.displayName !== undefined) {
      newio = { ...existing.newio, displayName: updates.displayName };
    }
    const updated: StoredAgentConfig = {
      ...existing,
      newio,
      ...(updates.sessionMode !== undefined ? { sessionMode: updates.sessionMode } : {}),
      ...(updates.acp !== undefined ? { acp: updates.acp } : {}),
    };
    const copy = [...stored];
    copy[index] = updated;
    this.writeStored(copy);

    if (updates.envVars !== undefined) {
      this.writeEnvVars(agentId, updates.envVars);
    }
    if (usernameChanged) {
      this.clearTokens(agentId);
    }

    return this.hydrate(updated);
  }

  remove(agentId: string): void {
    const stored = this.readStored();
    const filtered = stored.filter((a) => a.id !== agentId);
    if (filtered.length === stored.length) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    this.writeStored(filtered);
    this.deleteEnvVars(agentId);
    this.clearTokens(agentId);
  }

  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const stored = this.readStored();
    const index = stored.findIndex((a) => a.id === agentId);
    const existing = stored[index];
    if (!existing) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: StoredAgentConfig = { ...existing, newio: identity };
    const copy = [...stored];
    copy[index] = updated;
    this.writeStored(copy);
    return this.hydrate(updated);
  }

  getTokens(agentId: string): AgentTokens | undefined {
    const all = this.readJson<Record<string, AgentTokens>>(this.tokensPath, {});
    return agentId in all ? all[agentId] : undefined;
  }

  setTokens(agentId: string, tokens: AgentTokens): void {
    const all = this.readJson<Record<string, AgentTokens>>(this.tokensPath, {});
    this.writeJson(this.tokensPath, { ...all, [agentId]: tokens }, 0o600);
  }

  clearTokens(agentId: string): void {
    const all = this.readJson<Record<string, AgentTokens>>(this.tokensPath, {});
    if (agentId in all) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removed, ...rest } = all;
      this.writeJson(this.tokensPath, rest, 0o600);
    }
  }

  // ---------------------------------------------------------------------------
  // env files
  // ---------------------------------------------------------------------------

  /** Absolute path of an agent's `.env` file. Public so callers (CLI edit) can locate it. */
  envFilePath(agentId: string): string {
    return agentEnvFilePath(this.dataDir, agentId);
  }

  private readEnvVars(agentId: string): Record<string, string> {
    const path = this.envFilePath(agentId);
    try {
      return parseEnvVars(readFileSync(path, 'utf8'));
    } catch (err) {
      if (existsSync(path)) {
        log.warn(`Failed to parse ${path}, treating env as empty`, err);
      }
      return {};
    }
  }

  private writeEnvVars(agentId: string, env: Readonly<Record<string, string>>): void {
    const path = this.envFilePath(agentId);
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(path, serializeEnvVars(env), { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  }

  private deleteEnvVars(agentId: string): void {
    const path = this.envFilePath(agentId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  private hydrate(stored: StoredAgentConfig): AgentConfig {
    return { ...stored, envVars: this.readEnvVars(stored.id) };
  }

  // ---------------------------------------------------------------------------
  // json io
  // ---------------------------------------------------------------------------

  private readStored(): StoredAgentConfig[] {
    return this.readJson<StoredAgentConfig[]>(this.configPath, []);
  }

  private writeStored(configs: readonly StoredAgentConfig[]): void {
    this.writeJson(this.configPath, configs);
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (err) {
      if (existsSync(path)) {
        log.warn(`Failed to parse ${path}, using fallback`, err);
      }
      return fallback;
    }
  }

  private writeJson(path: string, data: unknown, mode?: number): void {
    this.ensureDir();
    const fileMode = mode ?? 0o600;
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: fileMode });
    // mode on writeFileSync only applies when creating the file; enforce it on
    // pre-existing files too (older installs wrote config.json at 0o644).
    chmodSync(path, fileMode);
  }
}
