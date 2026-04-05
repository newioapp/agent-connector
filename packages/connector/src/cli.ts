#!/usr/bin/env npx tsx
/**
 * CLI script to launch a single agent instance outside of Electron.
 *
 * Usage:
 *   npx tsx src/cli.ts --agent <agentId>
 *
 * Agents are hardcoded below — edit the AGENTS array to configure.
 */
import type { AgentConfigManager, AgentTokens } from './core/agent-config-manager';
import { AgentRuntimeManager } from './core/agent-runtime-manager';
import { SessionStore } from './core/session-store';
import type { AgentRuntimeStatus, AgentConfig, NewioIdentity } from './core/types';
import { setLogHandler } from '@newio/sdk';
import { join } from 'path';
import { mkdirSync } from 'fs';

// Route SDK logs through console at debug level
setLogHandler((level, name, message, args) => {
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}] [sdk:${name}]`;
  console[level](prefix, message, ...args);
});

// ---------------------------------------------------------------------------
// Hardcoded agent configs — edit these
// ---------------------------------------------------------------------------

const AGENTS: AgentConfig[] = [
  // {
  //   id: 'claude-1',
  //   type: 'claude-code',
  //   newio: { username: 'my-agent', displayName: 'My Claude Agent' },
  //   claude: { apiKey: 'sk-ant-...', model: 'claude-sonnet-4-20250514' },
  // },
  {
    id: 'kiro-1',
    type: 'kiro-cli',
    newio: { username: 'kiro', displayName: 'Kiro' },
    envVars: {},
    kiroCli: { agentName: 'pineapple', cwd: '/Users/pineapple/workspace/conduit' },
  },
];

// ---------------------------------------------------------------------------
// In-memory config manager (no Electron dependency)
// ---------------------------------------------------------------------------

class InMemoryConfigManager implements AgentConfigManager {
  private readonly configs: AgentConfig[] = [...AGENTS];
  private readonly tokens = new Map<string, AgentTokens>();

  list(): AgentConfig[] {
    return this.configs;
  }

  get(agentId: string): AgentConfig | undefined {
    return this.configs.find((a) => a.id === agentId);
  }

  add(): AgentConfig {
    throw new Error('Not supported in CLI mode');
  }

  update(): AgentConfig {
    throw new Error('Not supported in CLI mode');
  }

  remove(): void {
    throw new Error('Not supported in CLI mode');
  }

  setNewioIdentity(agentId: string, identity: NewioIdentity): AgentConfig {
    const idx = this.configs.findIndex((a) => a.id === agentId);
    if (idx === -1) {
      throw new Error(`Agent ${agentId} not found.`);
    }
    this.configs[idx] = { ...this.configs[idx], newio: identity };
    return this.configs[idx];
  }

  getTokens(agentId: string): AgentTokens | undefined {
    return this.tokens.get(agentId);
  }

  setTokens(agentId: string, tokens: AgentTokens): void {
    this.tokens.set(agentId, tokens);
  }

  clearTokens(agentId: string): void {
    this.tokens.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const configManager = new InMemoryConfigManager();
const dataDir = join(process.env.HOME ?? '/tmp', '.newio-connector');
mkdirSync(dataDir, { recursive: true });
const sessionStore = new SessionStore(join(dataDir, 'sessions.db'));

const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');
const agentId = agentIdx !== -1 ? args[agentIdx + 1] : undefined;

if (!agentId) {
  const agents = configManager.list();
  if (agents.length === 0) {
    console.log('No agents configured. Edit the AGENTS array in src/cli.ts.');
  } else {
    console.log('Configured agents:\n');
    for (const a of agents) {
      console.log(
        `  ${a.id}  ${a.newio?.displayName ?? a.type} (${a.type})${a.newio?.username ? `  @${a.newio.username}` : ''}`,
      );
    }
    console.log('\nUsage: npx tsx src/cli.ts --agent <agentId>');
  }
  process.exit(0);
}

const config = configManager.get(agentId);
if (!config) {
  console.error(`Agent "${agentId}" not found.`);
  process.exit(1);
}

console.log(`Starting agent: ${config.newio?.displayName ?? config.type} (${config.type})`);
const runtime = new AgentRuntimeManager(configManager, sessionStore, {
  onStatusChanged(id: string, status: AgentRuntimeStatus, error?: string) {
    console.log(`[${id}] status: ${status}${error ? ` — ${error}` : ''}`);
  },
  onApprovalUrl(_id: string, url: string) {
    console.log(`\nApproval required — open this URL:\n  ${url}\n`);
  },
  onPollAttempt() {
    // no-op in CLI
  },
  onConfigUpdated() {
    // no-op in CLI
  },
});

runtime.start(agentId);

// Graceful shutdown
function shutdown(): void {
  console.log('\nStopping agent...');
  void runtime.stopAll().then(() => {
    sessionStore.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
