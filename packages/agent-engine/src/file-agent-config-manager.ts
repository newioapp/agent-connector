/**
 * File-based agent config manager — persists agent configs and tokens to a data directory.
 *
 * Platform-agnostic (pure node:fs + node:os). Used by both the Electron desktop app
 * and the CLI daemon.
 *
 * Layout — each agent owns a directory so every write touches only that agent
 * (no shared read-modify-write file, hence no cross-agent races on background
 * token refresh) and removal is a single `rm -rf`:
 *
 *   agents/<agentId>/config.json        — one StoredAgentConfig (without envVars), 0o600
 *   agents/<agentId>/.credentials.json  — AgentTokens, 0o600
 *   agents/<agentId>/.env               — environment variables in dotenv format, 0o600.
 *                                         Hand-editable via `newio agent env edit`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from './types';
import type { AgentConfigManager, AgentTokens } from './agent-config-manager';
import { serializeEnvVars, parseEnvVars, agentEnvFilePath } from './env-file';
import { assertSafeAgentId, isSafeAgentId } from './agent-id';
import { getLogger } from '@newio/agent-sdk';

const log = getLogger('file-agent-config-manager');

/** Shape stored in config.json: an AgentConfig minus its envVars, which live in a separate .env file. */
type StoredAgentConfig = Omit<AgentConfig, 'envVars'>;

export class FileAgentConfigManager implements AgentConfigManager {
  private readonly dataDir: string;
  private readonly agentsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.agentsDir = join(dataDir, 'agents');
    this.ensureDir(this.agentsDir);
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      log.info(`Created ${dir}`);
    }
  }

  list(): AgentConfig[] {
    return this.listAgentIds()
      .map((id) => this.readStored(id))
      .filter((stored): stored is StoredAgentConfig => stored !== undefined)
      .map((stored) => this.hydrate(stored));
  }

  get(agentId: string): AgentConfig | undefined {
    const stored = this.readStored(agentId);
    return stored ? this.hydrate(stored) : undefined;
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
    this.writeStored(stored);
    this.writeEnvVars(id, envVars);
    return { ...stored, envVars };
  }

  update(agentId: string, updates: UpdateAgentInput): AgentConfig {
    const existing = this.readStored(agentId);
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
    this.writeStored(updated);

    if (updates.envVars !== undefined) {
      this.writeEnvVars(agentId, updates.envVars);
    }
    if (usernameChanged) {
      this.clearTokens(agentId);
    }

    return this.hydrate(updated);
  }

  remove(agentId: string): void {
    // Only remove a known agent (one with a stored config), not any directory
    // that merely exists under agents/. readStored validates the id (path guard)
    // via configPath -> agentDir before any filesystem mutation.
    if (!this.readStored(agentId)) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    // One shot: removes config.json, .credentials.json, .env, and cron.json together.
    rmSync(this.agentDir(agentId), { recursive: true, force: true });
  }

  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const existing = this.readStored(agentId);
    if (!existing) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: StoredAgentConfig = { ...existing, newio: identity };
    this.writeStored(updated);
    return this.hydrate(updated);
  }

  getTokens(agentId: string): AgentTokens | undefined {
    return this.readJson<AgentTokens | undefined>(this.credentialsPath(agentId), undefined);
  }

  setTokens(agentId: string, tokens: AgentTokens): void {
    this.writeJson(this.credentialsPath(agentId), tokens, 0o600);
  }

  clearTokens(agentId: string): void {
    const path = this.credentialsPath(agentId);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // per-agent paths
  // ---------------------------------------------------------------------------

  private agentDir(agentId: string): string {
    // Guard against path traversal: agentId is joined into a filesystem path
    // and may come from untrusted RPC input. Covers config.json, .credentials.json,
    // and remove() (which rmSyncs this directory).
    assertSafeAgentId(agentId);
    return join(this.agentsDir, agentId);
  }

  private configPath(agentId: string): string {
    return join(this.agentDir(agentId), 'config.json');
  }

  private credentialsPath(agentId: string): string {
    return join(this.agentDir(agentId), '.credentials.json');
  }

  /** Absolute path of an agent's `.env` file. Public so callers (CLI edit) can locate it. */
  envFilePath(agentId: string): string {
    assertSafeAgentId(agentId);
    return agentEnvFilePath(this.dataDir, agentId);
  }

  /** Agent IDs with an on-disk config, sorted for a stable listing order. */
  private listAgentIds(): string[] {
    if (!existsSync(this.agentsDir)) {
      return [];
    }
    return (
      readdirSync(this.agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        // Skip stray/unexpected directory names (e.g. .backup) rather than letting
        // configPath() throw on them — one bad dir must not break list().
        .filter(isSafeAgentId)
        .filter((id) => existsSync(this.configPath(id)))
        .sort()
    );
  }

  // ---------------------------------------------------------------------------
  // env files
  // ---------------------------------------------------------------------------

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
    this.ensureDir(dirname(path));
    writeFileSync(path, serializeEnvVars(env), { encoding: 'utf8', mode: 0o600 });
    chmodSync(path, 0o600);
  }

  private hydrate(stored: StoredAgentConfig): AgentConfig {
    return { ...stored, envVars: this.readEnvVars(stored.id) };
  }

  // ---------------------------------------------------------------------------
  // json io
  // ---------------------------------------------------------------------------

  private readStored(agentId: string): StoredAgentConfig | undefined {
    return this.readJson<StoredAgentConfig | undefined>(this.configPath(agentId), undefined);
  }

  private writeStored(stored: StoredAgentConfig): void {
    this.writeJson(this.configPath(stored.id), stored, 0o600);
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

  private writeJson(path: string, data: unknown, mode: number): void {
    this.ensureDir(dirname(path));
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
    // mode on writeFileSync only applies when creating the file; enforce it on
    // pre-existing files too (older installs may have written at 0o644).
    chmodSync(path, mode);
  }
}
