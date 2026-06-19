/**
 * `newio agent …` / `newio agent env …` / `newio status` handlers.
 *
 * Thin wrappers over DaemonConnector RPC. Agent ids may be given as a full id,
 * a unique id prefix, or an exact display name.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import type { DaemonConnector } from '../connector.js';
import type {
  AcpConfig,
  AddAgentInput,
  AgentErrorCode,
  AgentStatusInfo,
  AgentType,
  UpdateAgentInput,
} from '@newio/agent-engine';
import { agentEnvFilePath, captureEnv, asEnvSyncMode, DEFAULT_ENV_SYNC_MODE } from '@newio/agent-engine';
import { AuthManager, NewioClient } from '@newio/agent-sdk';
import { withDaemon, openConnection } from '../client/connect.js';
import { resolveConfig, getDaemonPaths, stageSuffix, type Stage } from '../paths.js';
import { printApprovalUrl } from './qr.js';

const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'kiro-cli', 'codex', 'cursor', 'gemini', 'custom'];

/** Runtime statuses at which `agent start` is done waiting. */
const TERMINAL_STATUSES = new Set(['running', 'error', 'stopped']);

export const AGENT_TYPE_CHOICES: readonly string[] = AGENT_TYPES;

function asAgentType(value: string): AgentType {
  const match = AGENT_TYPES.find((t) => t === value);
  if (!match) {
    throw new Error(`Invalid agent type "${value}". Expected one of: ${AGENT_TYPES.join(', ')}`);
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

// Env capture (`basic`/`all` filter) is shared with the desktop app — see
// @newio/agent-engine. The CLI always runs inside the user's interactive shell,
// so `process.env` is already fully sourced; it filters that directly, with no
// shell spawn. The desktop, launched from the Dock without a sourced env, does
// the login-shell sourcing itself (packages/connector/src/main/shell-env.ts).
export { ENV_SYNC_MODES } from '@newio/agent-engine';

/** First line of a (possibly multi-line) error message — for tight table cells. */
export function firstLine(message: string): string {
  const idx = message.indexOf('\n');
  return idx === -1 ? message : message.slice(0, idx);
}

/** CLI-side remediation hint for a known error category (engine stays UI-neutral). */
export function remediationHint(errorCode: AgentErrorCode | undefined, agentId: string): string | undefined {
  if (errorCode === 'invalid_environment') {
    return `Fix this agent's environment, then restart: newio agent env edit ${agentId.slice(0, 8)}`;
  }
  return undefined;
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

/**
 * Render the STATUS cell: the process-level runtime status, with the live
 * WebSocket health appended when the realtime link is degraded (e.g. `running ·
 * reconnecting`). Mirrors the desktop app, which surfaces only the dropped /
 * reconnecting states — a healthy link adds no noise and shows just the status.
 */
function formatStatus(a: AgentStatusInfo): string {
  return a.wsStatus === 'reconnecting' || a.wsStatus === 'disconnected'
    ? `${a.runtimeStatus} · ${a.wsStatus}`
    : a.runtimeStatus;
}

function printAgentTable(agents: readonly AgentStatusInfo[]): void {
  if (agents.length === 0) {
    console.log('No agents configured. Add one with: newio agent add --type <type> --username <username>');
    return;
  }
  const rows = agents.map((a) => ({
    id: a.id.slice(0, 8),
    name: a.config.newio?.displayName ?? '—',
    type: a.config.type,
    username: a.config.newio?.username ?? '—',
    // The process status, plus the WebSocket health when the link is degraded.
    // The full (possibly multi-line) error goes in DESCRIPTION, trimmed to its
    // first line so the table stays aligned.
    status: formatStatus(a),
    description: a.error ? firstLine(a.error) : '',
  }));
  const w = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    username: Math.max(8, ...rows.map((r) => r.username.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };
  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(
    `${pad('ID', w.id)}  ${pad('NAME', w.name)}  ${pad('TYPE', w.type)}  ${pad('USERNAME', w.username)}  ${pad('STATUS', w.status)}  DESCRIPTION`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, w.id)}  ${pad(r.name, w.name)}  ${pad(r.type, w.type)}  ${pad(r.username, w.username)}  ${pad(r.status, w.status)}  ${r.description}`.trimEnd(),
    );
  }
  // Actionable hints for agents stuck in a known error state.
  const hints = new Set(
    agents.map((a) => remediationHint(a.errorCode, a.id)).filter((h): h is string => h !== undefined),
  );
  if (hints.size > 0) {
    console.log('');
    for (const hint of hints) {
      console.log(`  → ${hint}`);
    }
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
        printApprovalUrl('Approve this agent in your browser:', url);
      }
    },
    onPollAttempt(id) {
      if (id === agentId) {
        process.stdout.write('.');
      }
    },
    onStatusChanged(id, status, error, errorCode) {
      if (id !== agentId) {
        return;
      }
      console.log(`\n${status}${error ? `: ${error}` : ''}`);
      const hint = remediationHint(errorCode, agentId);
      if (hint) {
        console.log(`  → ${hint}`);
      }
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
  /** Executable to spawn (for custom agents, or to override a built-in type's binary). */
  readonly command?: string;
  /** Args for `command` (commander collects repeated --arg into an array). */
  readonly arg?: readonly string[];
  readonly envSync?: string;
}

export interface CreateAccountOptions {
  readonly name: string;
}

export interface UpdateOptions {
  readonly name?: string;
  readonly cwd?: string;
  /** Executable to spawn (replaces the prior launch config). */
  readonly command?: string;
  /** Args for `command` (commander collects repeated --arg into an array). */
  readonly arg?: readonly string[];
  readonly username?: string;
}

export async function agentList(stage: Stage): Promise<void> {
  await withDaemon(stage, async (c) => printAgentTable(await c.listAgents()));
}

/** `agent add` — attach a runner config to an existing account, identified by username. */
export async function agentAdd(stage: Stage, opts: AddOptions): Promise<void> {
  // Capture from the CLI's own environment up front (client-side); the daemon's
  // service environment is sparse and must not be the source.
  const type = asAgentType(opts.type);
  const hasCommand = typeof opts.command === 'string' && opts.command.length > 0;
  if (type === 'custom' && !hasCommand) {
    throw new Error('A custom agent requires --command <path> [--arg <value>…].');
  }
  const launch: Pick<AcpConfig, 'command' | 'args'> = hasCommand ? { command: opts.command, args: opts.arg ?? [] } : {};
  const mode = opts.envSync ? asEnvSyncMode(opts.envSync) : DEFAULT_ENV_SYNC_MODE;
  const envVars = captureEnv(mode);
  const config = await withDaemon(stage, async (c) => {
    const input: AddAgentInput = {
      type,
      newioUsername: opts.username,
      acp: { cwd: opts.cwd ?? process.cwd(), ...launch },
      envVars,
    };
    return c.addAgent(input);
  });
  console.log(`Added agent ${config.id} for @${opts.username}.`);
  console.log(`Synced ${Object.keys(config.envVars).length} environment variable(s) (${mode}).`);
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
  printApprovalUrl('Approve this new account in your browser:', handle.approvalUrl);
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

/** Whether the update opts carry a new launch override (--command/--arg). */
export function hasLaunchOverride(opts: Pick<UpdateOptions, 'command'>): boolean {
  return typeof opts.command === 'string' && opts.command.length > 0;
}

/**
 * Build the replacement `acp` for an update. The config manager replaces `acp`
 * wholesale, so this preserves the launch fields the user didn't change: a new
 * --command/--arg replaces the prior launch config; otherwise the existing
 * command/args (or a legacy executablePath set elsewhere) are carried forward intact.
 */
export function mergeAcpUpdate(
  opts: Pick<UpdateOptions, 'cwd' | 'command' | 'arg'>,
  existing: AcpConfig | undefined,
): AcpConfig {
  const cwd = opts.cwd ?? existing?.cwd ?? process.cwd();
  const newCommand = typeof opts.command === 'string' && opts.command.length > 0;
  let launch: Pick<AcpConfig, 'command' | 'args' | 'executablePath'>;
  if (newCommand) {
    launch = { command: opts.command, args: opts.arg ?? [] };
  } else {
    launch = {
      ...(existing?.command !== undefined ? { command: existing.command } : {}),
      ...(existing?.args !== undefined ? { args: existing.args } : {}),
      ...(existing?.executablePath !== undefined ? { executablePath: existing.executablePath } : {}),
    };
  }
  return {
    cwd,
    ...launch,
    ...(existing?.kiroCliTrustAllTools !== undefined ? { kiroCliTrustAllTools: existing.kiroCliTrustAllTools } : {}),
  };
}

export async function agentUpdate(stage: Stage, query: string, opts: UpdateOptions): Promise<void> {
  await withDaemon(stage, async (c) => {
    const agentId = await resolveAgentId(c, query);
    // `acp` is replaced wholesale by the config manager, so merge with the
    // existing config to avoid wiping the fields the user didn't pass.
    let acp: AcpConfig | undefined;
    if (opts.cwd !== undefined || hasLaunchOverride(opts)) {
      const agents = await c.listAgents();
      const existing = agents.find((a) => a.id === agentId)?.config.acp;
      acp = mergeAcpUpdate(opts, existing);
    }
    const updates: UpdateAgentInput = {
      ...(opts.name !== undefined ? { displayName: opts.name } : {}),
      ...(opts.username !== undefined ? { newioUsername: opts.username } : {}),
      ...(acp !== undefined ? { acp } : {}),
    };
    await c.updateAgent(agentId, updates);
  });
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

export async function envSync(stage: Stage, query: string, modeArg?: string): Promise<void> {
  const mode = modeArg ? asEnvSyncMode(modeArg) : DEFAULT_ENV_SYNC_MODE;
  const captured = captureEnv(mode);
  await withDaemon(stage, async (c) => {
    const agentId = await resolveAgentId(c, query);
    // Sync is authoritative: the agent's environment becomes EXACTLY what was
    // captured from this shell. Existing vars are cleared — stale entries from a
    // previous sync (e.g. an earlier `--mode all`) and keys added via `env set`
    // are dropped, so the result is reproducible. Re-apply custom keys with
    // `env set` after a sync.
    const previousCount = Object.keys(await currentEnv(c, agentId)).length;
    await c.updateAgentEnvVars(agentId, captured);
    const capturedCount = Object.keys(captured).length;
    console.log(
      `Synced ${capturedCount} variable(s) (${mode}) from the current environment, replacing ${previousCount} existing variable(s).`,
    );
  });
}

/** `env print` — dump what a sync mode would capture from the CLI's environment, without touching any agent. */
export function envPrint(modeArg?: string): void {
  const mode = modeArg ? asEnvSyncMode(modeArg) : DEFAULT_ENV_SYNC_MODE;
  const env = captureEnv(mode);
  const keys = Object.keys(env).sort();
  if (keys.length === 0) {
    console.log(`No environment variables resolved (${mode}).`);
    return;
  }
  for (const key of keys) {
    console.log(`${key}=${env[key]}`);
  }
}

/** Open the agent's `.env` file in `$VISUAL`/`$EDITOR`. Changes apply on the agent's next start. */
export async function envEdit(stage: Stage, query: string): Promise<void> {
  const { agentId, running } = await withDaemon(stage, async (c) => {
    const id = await resolveAgentId(c, query);
    const info = (await c.listAgents()).find((a) => a.id === id);
    const isRunning = info !== undefined && info.runtimeStatus !== 'stopped' && info.runtimeStatus !== 'error';
    return { agentId: id, running: isRunning };
  });

  const filePath = agentEnvFilePath(getDaemonPaths(stage).dataDir, agentId);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, '# Environment variables for this agent (KEY=VALUE per line).\n', { mode: 0o600 });
  }

  await openInEditor(filePath);
  console.log(`Saved ${filePath}.`);
  if (running) {
    console.log(`Restart the agent to apply changes: newio agent restart ${agentId.slice(0, 8)}`);
  }
}

/** Spawn the user's editor on a file, inheriting stdio, and resolve when it exits. */
function openInEditor(filePath: string): Promise<void> {
  const editor = process.env['VISUAL'] || process.env['EDITOR'] || 'vi';
  const parts = editor.split(/\s+/).filter((p) => p.length > 0);
  const command = parts[0] ?? 'vi';
  const args = [...parts.slice(1), filePath];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Editor "${editor}" exited with code ${code}.`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function status(stage: Stage): Promise<void> {
  await withDaemon(stage, async (c) => {
    const version = await c.version();
    console.log(`newio daemon${stageSuffix(stage)}: online, version ${version}`);
    // Make the active backend obvious whenever it isn't the default (prod).
    if (stage !== 'prod') {
      const { apiBaseUrl } = resolveConfig();
      console.log(`  stage: ${stage} → ${apiBaseUrl}`);
    }
    console.log('');
    printAgentTable(await c.listAgents());
  });
}
