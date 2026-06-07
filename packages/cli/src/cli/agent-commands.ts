/**
 * `newio agent …` / `newio agent env …` / `newio status` handlers.
 *
 * Thin wrappers over DaemonConnector RPC. Agent ids may be given as a full id,
 * a unique id prefix, or an exact display name.
 */
import type { DaemonConnector } from '../connector.js';
import type { AddAgentInput, AgentStatusInfo, AgentType, SessionMode, UpdateAgentInput } from '@newio/agent-engine';
import { AuthManager, NewioClient } from '@newio/agent-sdk';
import { withDaemon, openConnection } from '../client/connect.js';
import { resolveConfig, type Stage } from '../paths.js';

const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'kiro-cli', 'codex', 'cursor', 'gemini', 'custom'];
const SESSION_MODES: readonly SessionMode[] = ['isolated', 'shared'];

/** Runtime statuses at which `agent start` is done waiting. */
const TERMINAL_STATUSES = new Set(['running', 'error', 'stopped']);

export const AGENT_TYPE_CHOICES: readonly string[] = AGENT_TYPES;
export const SESSION_MODE_CHOICES: readonly string[] = SESSION_MODES;

function asAgentType(value: string): AgentType {
  const match = AGENT_TYPES.find((t) => t === value);
  if (!match) {
    throw new Error(`Invalid agent type "${value}". Expected one of: ${AGENT_TYPES.join(', ')}`);
  }
  return match;
}

function asSessionMode(value: string): SessionMode {
  const match = SESSION_MODES.find((m) => m === value);
  if (!match) {
    throw new Error(`Invalid session mode "${value}". Expected one of: ${SESSION_MODES.join(', ')}`);
  }
  return match;
}

/** Parse `KEY=VALUE` pairs into a record, throwing on malformed input. */
export function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      throw new Error(`Invalid KEY=VALUE pair: "${pair}"`);
    }
    result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}

/**
 * Resolve a user-supplied query to a single agent id.
 *
 * Resolution order: exact config id → unique id prefix → Newio username
 * (case-insensitive). A username shared by several configs is ambiguous — the
 * user is asked to disambiguate with a config id.
 */
export async function resolveAgentId(connector: DaemonConnector, query: string): Promise<string> {
  const agents = await connector.listAgents();
  const exact = agents.find((a) => a.id === query);
  if (exact) {
    return exact.id;
  }
  const byPrefix = agents.filter((a) => a.id.startsWith(query));
  if (byPrefix.length > 1) {
    throw new Error(`Ambiguous agent id prefix "${query}" — matches ${byPrefix.length} agents.`);
  }
  const [prefixMatch] = byPrefix;
  if (prefixMatch) {
    return prefixMatch.id;
  }
  const queryLower = query.toLowerCase();
  const byUsername = agents.filter((a) => a.config.newio?.username?.toLowerCase() === queryLower);
  if (byUsername.length > 1) {
    const ids = byUsername.map((a) => a.id.slice(0, 8)).join(', ');
    throw new Error(`Username "${query}" is used by ${byUsername.length} configs (${ids}). Use a config id instead.`);
  }
  const [usernameMatch] = byUsername;
  if (usernameMatch) {
    return usernameMatch.id;
  }
  throw new Error(`No agent matching "${query}".`);
}

function printAgentTable(agents: readonly AgentStatusInfo[]): void {
  if (agents.length === 0) {
    console.log('No agents configured. Create one with: newio agent create-account --type <type> --name <name>');
    return;
  }
  const rows = agents.map((a) => ({
    id: a.id.slice(0, 8),
    type: a.config.type,
    // Username fills in after first login; until then show the display name (register path) or a dash.
    username: a.config.newio?.username ?? (a.config.newio?.displayName ? `(${a.config.newio.displayName})` : '—'),
    status: a.error ? `${a.runtimeStatus} (${a.error})` : a.runtimeStatus,
  }));
  const w = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    username: Math.max(8, ...rows.map((r) => r.username.length)),
  };
  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(`${pad('ID', w.id)}  ${pad('TYPE', w.type)}  ${pad('USERNAME', w.username)}  STATUS`);
  for (const r of rows) {
    console.log(`${pad(r.id, w.id)}  ${pad(r.type, w.type)}  ${pad(r.username, w.username)}  ${r.status}`);
  }
}

/** Start an agent and stream status until it reaches a terminal state. */
async function startAndStream(stage: Stage, query: string): Promise<void> {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let agentId = '';

  const connector = await openConnection(stage, {
    onApprovalUrl(id, url) {
      if (id === agentId) {
        console.log(`Approve this agent in your browser:\n  ${url}`);
      }
    },
    onPollAttempt(id) {
      if (id === agentId) {
        process.stdout.write('.');
      }
    },
    onStatusChanged(id, status, error) {
      if (id !== agentId) {
        return;
      }
      console.log(`\n${status}${error ? `: ${error}` : ''}`);
      if (TERMINAL_STATUSES.has(status)) {
        resolveDone();
      }
    },
  });

  try {
    agentId = await resolveAgentId(connector, query);
    await connector.startAgent(agentId);
    await done;
  } finally {
    connector.disconnect();
  }
}

// ---------------------------------------------------------------------------
// agent commands
// ---------------------------------------------------------------------------

export interface AddOptions {
  readonly type: string;
  readonly username: string;
  readonly cwd?: string;
  readonly sessionMode?: string;
}

export interface CreateAccountOptions {
  readonly name: string;
}

export interface UpdateOptions {
  readonly name?: string;
  readonly cwd?: string;
  readonly username?: string;
  readonly sessionMode?: string;
}

export async function agentList(stage: Stage): Promise<void> {
  await withDaemon(stage, async (c) => printAgentTable(await c.listAgents()));
}

/** `agent add` — attach a runner config to an existing account, identified by username. */
export async function agentAdd(stage: Stage, opts: AddOptions): Promise<void> {
  const input: AddAgentInput = {
    type: asAgentType(opts.type),
    newioUsername: opts.username,
    acp: { cwd: opts.cwd ?? process.cwd() },
    ...(opts.sessionMode ? { sessionMode: asSessionMode(opts.sessionMode) } : {}),
  };
  const config = await withDaemon(stage, (c) => c.addAgent(input));
  console.log(`Added agent ${config.id} for @${opts.username}.`);
  console.log(`Start it with: newio agent start ${config.id.slice(0, 8)}`);
}

/**
 * `agent create-account` — register a brand-new Newio agent account. Runs the
 * register + browser-approval flow standalone (no daemon, no runner config); the
 * username is chosen by the owner during approval. Wire up a runner afterwards
 * with `agent add --username <username>`.
 */
export async function agentCreateAccount(opts: CreateAccountOptions): Promise<void> {
  const { apiBaseUrl } = resolveConfig();
  const auth = new AuthManager(apiBaseUrl);
  const handle = await auth.register({ name: opts.name });
  console.log(`Approve this new account in your browser:\n  ${handle.approvalUrl}`);
  await handle.waitForApproval({ onPollAttempt: () => process.stdout.write('.') });
  const client = new NewioClient({ baseUrl: apiBaseUrl, tokenProvider: auth.tokenProvider });
  const me = await client.getMe({});
  console.log(`\nAccount created: @${me.username ?? '(username not set)'} (${me.userId}).`);
  console.log(`Add a runner for it with: newio agent add --type <type> --username ${me.username ?? '<username>'}`);
}

export async function agentRemove(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => c.removeAgent(await resolveAgentId(c, query)));
  console.log('Removed.');
}

export async function agentStart(stage: Stage, query: string): Promise<void> {
  await startAndStream(stage, query);
}

export async function agentStop(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
  console.log('Stopped.');
}

export async function agentRestart(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
  await startAndStream(stage, query);
}

export async function agentInfo(stage: Stage, query: string): Promise<void> {
  const info = await withDaemon(stage, async (c) => c.getAgentInfo(await resolveAgentId(c, query)));
  console.log(info ? JSON.stringify(info, null, 2) : 'No runtime info (agent not running).');
}

export async function agentUpdate(stage: Stage, query: string, opts: UpdateOptions): Promise<void> {
  const updates: UpdateAgentInput = {
    ...(opts.name !== undefined ? { displayName: opts.name } : {}),
    ...(opts.username !== undefined ? { newioUsername: opts.username } : {}),
    ...(opts.sessionMode !== undefined ? { sessionMode: asSessionMode(opts.sessionMode) } : {}),
    ...(opts.cwd !== undefined ? { acp: { cwd: opts.cwd } } : {}),
  };
  await withDaemon(stage, async (c) => c.updateAgent(await resolveAgentId(c, query), updates));
  console.log('Updated.');
}

// ---------------------------------------------------------------------------
// env commands
// ---------------------------------------------------------------------------

async function currentEnv(c: DaemonConnector, agentId: string): Promise<Record<string, string>> {
  const agents = await c.listAgents();
  return { ...(agents.find((a) => a.id === agentId)?.config.envVars ?? {}) };
}

export async function envList(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => {
    const env = await currentEnv(c, await resolveAgentId(c, query));
    const keys = Object.keys(env).sort();
    if (keys.length === 0) {
      console.log('No environment variables set.');
    }
    for (const key of keys) {
      console.log(`${key}=${env[key]}`);
    }
  });
}

export async function envSet(stage: Stage, query: string, pairs: string[]): Promise<void> {
  await withDaemon(stage, async (c) => {
    const agentId = await resolveAgentId(c, query);
    const next = { ...(await currentEnv(c, agentId)), ...parseEnvPairs(pairs) };
    await c.updateAgentEnvVars(agentId, next);
  });
  console.log(`Updated ${pairs.length} variable(s).`);
}

export async function envUnset(stage: Stage, query: string, keys: string[]): Promise<void> {
  await withDaemon(stage, async (c) => {
    const agentId = await resolveAgentId(c, query);
    const current = await currentEnv(c, agentId);
    const remove = new Set(keys);
    const next: Record<string, string> = {};
    for (const [key, val] of Object.entries(current)) {
      if (!remove.has(key)) {
        next[key] = val;
      }
    }
    await c.updateAgentEnvVars(agentId, next);
  });
  console.log(`Removed ${keys.length} variable(s).`);
}

export async function envSync(stage: Stage, query: string, shellArg?: string): Promise<void> {
  await withDaemon(stage, async (c) => {
    const agentId = await resolveAgentId(c, query);
    const shells = await c.listShells();
    const shell = shellArg ?? shells[0];
    if (!shell) {
      throw new Error('No login shell available to sync from.');
    }
    const shellEnv = await c.getShellEnv(shell);
    // Overlay shell-derived vars on existing ones (preserves custom keys).
    const next = { ...(await currentEnv(c, agentId)), ...shellEnv };
    await c.updateAgentEnvVars(agentId, next, shell);
    console.log(`Synced ${Object.keys(shellEnv).length} variable(s) from ${shell}.`);
  });
}

export async function envShells(stage: Stage): Promise<void> {
  const shells = await withDaemon(stage, (c) => c.listShells());
  for (const shell of shells) {
    console.log(shell);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function status(stage: Stage): Promise<void> {
  await withDaemon(stage, async (c) => {
    const version = await c.version();
    console.log(`newio daemon (${stage}): online, version ${version}`);
    // Make the active backend obvious whenever it isn't the default (prod).
    if (stage !== 'prod') {
      const { apiBaseUrl } = resolveConfig();
      console.log(`  stage: ${stage} → ${apiBaseUrl}`);
    }
    console.log('');
    printAgentTable(await c.listAgents());
  });
}
