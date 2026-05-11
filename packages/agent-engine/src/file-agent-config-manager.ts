/**
 * File-based agent config manager — persists agent configs and tokens to a data directory.
 *
 * Platform-agnostic (pure node:fs + node:os). Used by both the Electron desktop app
 * and a future CLI.
 *
 * Files:
 *   config.json  — AgentConfig[]
 *   tokens.json  — Record<string, AgentTokens>  (mode 0o600)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from './types';
import type { AgentConfigManager, AgentTokens } from './agent-config-manager';
import { getLogger } from '@newio/agent-sdk';

const log = getLogger('file-agent-config-manager');

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
    return this.readJson<AgentConfig[]>(this.configPath, []);
  }

  get(agentId: string): AgentConfig | undefined {
    return this.list().find((a) => a.id === agentId);
  }

  add(input: AddAgentInput): AgentConfig {
    const config: AgentConfig = {
      id: randomUUID(),
      type: input.type,
      newio: {
        displayName: input.displayName,
        ...(input.newioUsername ? { username: input.newioUsername } : {}),
      },
      envVars: input.envVars ?? {},
      ...(input.envVarsShell ? { envVarsShell: input.envVarsShell } : {}),
      ...(input.acp ? { acp: input.acp } : {}),
    };
    const agents = this.list();
    this.writeJson(this.configPath, [...agents, config]);
    return config;
  }

  update(agentId: string, updates: UpdateAgentInput): AgentConfig {
    const agents = this.list();
    const index = agents.findIndex((a) => a.id === agentId);
    const existing = agents[index];
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
    const updated: AgentConfig = {
      ...existing,
      newio,
      ...(updates.envVars !== undefined ? { envVars: updates.envVars } : {}),
      ...(updates.envVarsShell !== undefined ? { envVarsShell: updates.envVarsShell } : {}),
      ...(updates.acp !== undefined ? { acp: updates.acp } : {}),
    };
    const copy = [...agents];
    copy[index] = updated;
    this.writeJson(this.configPath, copy);

    if (usernameChanged) {
      this.clearTokens(agentId);
    }

    return updated;
  }

  remove(agentId: string): void {
    const agents = this.list();
    const filtered = agents.filter((a) => a.id !== agentId);
    if (filtered.length === agents.length) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    this.writeJson(this.configPath, filtered);
    this.clearTokens(agentId);
  }

  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const agents = this.list();
    const index = agents.findIndex((a) => a.id === agentId);
    const existing = agents[index];
    if (!existing) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: AgentConfig = { ...existing, newio: identity };
    const copy = [...agents];
    copy[index] = updated;
    this.writeJson(this.configPath, copy);
    return updated;
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
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: mode ?? 0o644 });
  }
}
