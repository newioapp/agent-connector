/**
 * File-based agent config manager — persists agent configs and tokens to ~/.newio/connector/.
 *
 * Platform-agnostic (pure node:fs + node:os). Used by both the Electron desktop app
 * and a future CLI.
 *
 * Files:
 *   ~/.newio/connector/config.json  — AgentConfig[]
 *   ~/.newio/connector/tokens.json  — Record<string, AgentTokens>  (mode 0o600)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentConfig, AddAgentInput, UpdateAgentInput, NewioIdentity } from './types';
import type { AgentConfigManager, AgentTokens } from './agent-config-manager';
import { Logger } from './logger';

const log = new Logger('file-agent-config-manager');

/** Shared data directory for all Newio connector apps (desktop + CLI). */
export const NEWIO_DIR = join(homedir(), '.newio', 'connector');

const CONFIG_PATH = join(NEWIO_DIR, 'config.json');
const TOKENS_PATH = join(NEWIO_DIR, 'tokens.json');

/** Create the data directory if it doesn't exist. */
export function ensureNewioDir(): void {
  if (!existsSync(NEWIO_DIR)) {
    mkdirSync(NEWIO_DIR, { recursive: true, mode: 0o700 });
    log.info(`Created ${NEWIO_DIR}`);
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown, mode?: number): void {
  ensureNewioDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

export class FileAgentConfigManager implements AgentConfigManager {
  list(): AgentConfig[] {
    return readJson<AgentConfig[]>(CONFIG_PATH, []);
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
      envVars: {},
      ...(input.acp ? { acp: input.acp } : {}),
    };
    const agents = this.list();
    writeJson(CONFIG_PATH, [...agents, config]);
    return config;
  }

  update(agentId: string, updates: UpdateAgentInput): AgentConfig {
    const agents = this.list();
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const existing = agents[index];
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
    writeJson(CONFIG_PATH, copy);

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
    writeJson(CONFIG_PATH, filtered);
    this.clearTokens(agentId);
  }

  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const agents = this.list();
    const index = agents.findIndex((a) => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    const updated: AgentConfig = { ...agents[index], newio: identity };
    const copy = [...agents];
    copy[index] = updated;
    writeJson(CONFIG_PATH, copy);
    return updated;
  }

  getTokens(agentId: string): AgentTokens | undefined {
    const all = readJson<Record<string, AgentTokens>>(TOKENS_PATH, {});
    return agentId in all ? all[agentId] : undefined;
  }

  setTokens(agentId: string, tokens: AgentTokens): void {
    const all = readJson<Record<string, AgentTokens>>(TOKENS_PATH, {});
    writeJson(TOKENS_PATH, { ...all, [agentId]: tokens }, 0o600);
  }

  clearTokens(agentId: string): void {
    const all = readJson<Record<string, AgentTokens>>(TOKENS_PATH, {});
    if (agentId in all) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to omit key
      const { [agentId]: _removed, ...rest } = all;
      writeJson(TOKENS_PATH, rest, 0o600);
    }
  }
}
