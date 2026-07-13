/**
 * `newio agent …` / `newio agent env …` / `newio status` handlers.
 *
 * Thin wrappers over DaemonConnector RPC. An agent may be referenced by its
 * Newio username, its full config id, or a unique config-id prefix.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';
import type { DaemonConnector } from '../connector.js';
import type {
  AcpConfig,
  AddAgentInput,
  AgentErrorCode,
  AgentStatusInfo,
  AgentType,
  SessionMode,
  UpdateAgentInput,
} from '@newio/agent-engine';
import { agentEnvFilePath, captureEnv, asEnvSyncMode, DEFAULT_ENV_SYNC_MODE } from '@newio/agent-engine';
import { AuthManager, NewioClient } from '@newio/agent-sdk';
import { withDaemon, openConnection } from '../client/connect.js';
import { resolveConfig, getDaemonPaths, stageSuffix, type Stage } from '../paths.js';
import { printApprovalUrl } from './qr.js';

const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'kiro-cli', 'codex', 'cursor', 'gemini', 'custom'];
const SESSION_MODES: readonly SessionMode[] = ['chat-shared', 'isolated', 'shared'];

/** Runtime statuses at which `agent start` is done waiting. */
const TERMINAL_STATUSES = new Set(['running', 'error', 'stopped']);

export const AGENT_TYPE_CHOICES: readonly string[] = AGENT_TYPES;
export const SESSION_MODE_CHOICES: readonly string[] = SESSION_MODES;

// Help text for the `--session-mode` option. Newlines put each mode on its own
// line in `--help`; commander wraps+indents the continuation lines to the
// description column (a `\n` followed by text, not spaces, isn't treated as
// pre-formatted). `chat-shared` is the shipped default; the others experimental.
export const SESSION_MODE_DESCRIPTION =
  'session mode (default: chat-shared)\n' +
  'chat-shared: DMs, group chats, and contact events share one session, while each work session and cron job gets its own\n' +
  'isolated [experimental]: one session per conversation\n' +
  'shared [experimental]: a single session across all events';

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

/** Existence/type of a candidate working directory — abstracts `fs` for testing. */
export interface CwdStat {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

function statCwdSync(path: string): CwdStat {
  try {
    return { exists: true, isDirectory: statSync(path).isDirectory() };
  } catch {
    return { exists: false, isDirectory: false };
  }
}

/**
 * Resolve a user-supplied `--cwd` to an absolute path, validating up front that
 * it exists and is a directory. A missing/invalid cwd otherwise surfaces much
 * later at spawn time as a misleading "node not in PATH" error (#277), so reject
 * it here with a message that names the offending path. When `cwd` is omitted the
 * current directory is used as-is (it always exists). `stat` is injectable for tests.
 */
export function resolveAgentCwd(cwd: string | undefined, stat: (path: string) => CwdStat = statCwdSync): string {
  if (cwd === undefined) {
    return process.cwd();
  }
  const resolved = resolve(cwd);
  const { exists, isDirectory } = stat(resolved);
  if (!exists) {
    throw new Error(`cwd does not exist: ${resolved}`);
  }
  if (!isDirectory) {
    throw new Error(`cwd is not a directory: ${resolved}`);
  }
  return resolved;
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
  if (errorCode === 'invalid_working_directory') {
    return `Set a valid working directory, then restart: newio agent update ${agentId.slice(0, 8)} --cwd <path>`;
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
export function formatStatus(a: AgentStatusInfo): string {
  return a.wsStatus === 'reconnecting' || a.wsStatus === 'disconnected'
    ? `${a.runtimeStatus} · ${a.wsStatus}`
    : a.runtimeStatus;
}

/**
 * Machine-readable view of an agent's status for `--json` output. A stable field
 * set automated callers parse instead of scraping the human table — optional
 * fields (approvalUrl/error/errorCode/hint/wsStatus) are present only when set.
 */
export interface AgentJson {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly type: string;
  readonly status: AgentStatusInfo['runtimeStatus'];
  readonly sessionMode: string;
  readonly cwd: string | null;
  readonly approvalUrl?: string;
  readonly error?: string;
  readonly errorCode?: string;
  readonly hint?: string;
  readonly wsStatus?: string;
}

export function agentToJson(a: AgentStatusInfo): AgentJson {
  const hint = remediationHint(a.errorCode, a.id);
  return {
    id: a.id,
    username: a.config.newio?.username ?? null,
    displayName: a.config.newio?.displayName ?? null,
    type: a.config.type,
    status: a.runtimeStatus,
    sessionMode: a.config.sessionMode ?? 'chat-shared',
    cwd: a.config.acp?.cwd ?? null,
    ...(a.approvalUrl ? { approvalUrl: a.approvalUrl } : {}),
    ...(a.error ? { error: a.error } : {}),
    ...(a.errorCode ? { errorCode: a.errorCode } : {}),
    ...(hint ? { hint } : {}),
    ...(a.wsStatus ? { wsStatus: a.wsStatus } : {}),
  };
}

/** Toggles for the optional `agent list` columns (both hidden by default). */
export interface AgentTableOptions {
  /** Append the DESCRIPTION column (the agent's error/detail, empty when healthy). */
  readonly desc?: boolean;
  /** Append the CWD column (the agent's working directory). */
  readonly cwd?: boolean;
  /** Emit machine-readable JSON (one object per agent) instead of the table. */
  readonly json?: boolean;
}

interface TableColumn {
  readonly header: string;
  readonly value: (a: AgentStatusInfo) => string;
}

/**
 * Build the `agent list` table — header, one row per agent, and the
 * remediation-hint block — as printable lines.
 *
 * SESSION-MODE shows the effective default (`chat-shared`) when `config.sessionMode`
 * is unset, never blank. DESCRIPTION (the error text) and CWD are opt-in via flags;
 * errors stay visible without DESCRIPTION through the STATUS cell and the hint block.
 */
export function buildAgentTable(agents: readonly AgentStatusInfo[], options: AgentTableOptions = {}): string[] {
  if (agents.length === 0) {
    return ['No agents configured. Add one with: newio agent add --type <type> --username <username>'];
  }
  const columns: TableColumn[] = [
    { header: 'ID', value: (a) => a.id.slice(0, 8) },
    { header: 'NAME', value: (a) => a.config.newio?.displayName ?? '—' },
    { header: 'TYPE', value: (a) => a.config.type },
    { header: 'USERNAME', value: (a) => a.config.newio?.username ?? '—' },
    // The process status, plus the WebSocket health when the link is degraded.
    { header: 'STATUS', value: formatStatus },
    { header: 'SESSION-MODE', value: (a) => a.config.sessionMode ?? 'chat-shared' },
  ];
  // CWD before DESCRIPTION: the error text is variable-length and best kept last.
  if (options.cwd) {
    columns.push({ header: 'CWD', value: (a) => a.config.acp?.cwd ?? '' });
  }
  if (options.desc) {
    // The full (possibly multi-line) error, trimmed to its first line so the table stays aligned.
    columns.push({ header: 'DESCRIPTION', value: (a) => (a.error ? firstLine(a.error) : '') });
  }
  const sized = columns.map((col) => ({
    ...col,
    width: Math.max(col.header.length, ...agents.map((a) => col.value(a).length)),
  }));
  const formatRow = (cell: (col: TableColumn) => string): string =>
    sized
      .map((col) => cell(col).padEnd(col.width))
      .join('  ')
      .trimEnd();

  const lines = [formatRow((col) => col.header)];
  for (const a of agents) {
    lines.push(formatRow((col) => col.value(a)));
  }
  // Actionable hints for agents stuck in a known error state.
  const hints = new Set(
    agents.map((a) => remediationHint(a.errorCode, a.id)).filter((h): h is string => h !== undefined),
  );
  if (hints.size > 0) {
    lines.push('');
    for (const hint of hints) {
      lines.push(`  → ${hint}`);
    }
  }
  return lines;
}

function printAgentTable(agents: readonly AgentStatusInfo[], options: AgentTableOptions = {}): void {
  for (const line of buildAgentTable(agents, options)) {
    console.log(line);
  }
}

/**
 * Start an agent and stream its progress.
 *
 * Blocking (default): waits until the agent reaches a terminal state
 * (running/error/stopped), printing the approval URL and status as they arrive.
 * `nonBlocking`: returns as soon as the approval URL is emitted OR a terminal
 * state is reached — whichever comes first — so an automated caller isn't held
 * by the (human-gated) approval long-poll. `json`: suppresses the human URL /
 * status stream and emits a single {@link AgentJson} object at return.
 */
async function startAndStream(stage: Stage, query: string, opts: StartOptions = {}): Promise<void> {
  const { nonBlocking = false, json = false } = opts;
  const human = !json;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let agentId = '';
  // Fallback if the record hasn't persisted approvalUrl by the time we re-read it.
  let seenApprovalUrl: string | undefined;

  const connector = await openConnection(stage, {
    onApprovalUrl(id, url) {
      if (id !== agentId) {
        return;
      }
      seenApprovalUrl = url;
      if (human) {
        printApprovalUrl('Approve this agent in your browser:', url);
      }
      // The approval URL is the actionable result; don't wait out the poll.
      if (nonBlocking) {
        resolveDone();
      }
    },
    onPollAttempt(id) {
      // Progress dots are interactive-only; skip when non-blocking or emitting JSON.
      if (id === agentId && human && !nonBlocking) {
        process.stdout.write('.');
      }
    },
    onStatusChanged(id, status, error, errorCode) {
      if (id !== agentId) {
        return;
      }
      if (human) {
        console.log(`\n${status}${error ? `: ${error}` : ''}`);
        const hint = remediationHint(errorCode, agentId);
        if (hint) {
          console.log(`  → ${hint}`);
        }
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
    if (json) {
      const info = (await connector.listAgents()).find((a) => a.id === agentId);
      if (info) {
        const view = agentToJson(info);
        console.log(
          JSON.stringify(seenApprovalUrl && !view.approvalUrl ? { ...view, approvalUrl: seenApprovalUrl } : view),
        );
      }
    }
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
  /** Session mode: chat-shared (default), or experimental isolated/shared. */
  readonly sessionMode?: string;
  readonly envSync?: string;
}

export interface CreateAccountOptions {
  readonly name: string;
  /** Return after printing the approval URL instead of waiting for approval. */
  readonly nonBlocking?: boolean;
  /** Emit a single machine-readable JSON object instead of human output. */
  readonly json?: boolean;
}

export interface UpdateOptions {
  readonly name?: string;
  readonly cwd?: string;
  /** Executable to spawn (replaces the prior launch config). */
  readonly command?: string;
  /** Args for `command` (commander collects repeated --arg into an array). */
  readonly arg?: readonly string[];
  readonly username?: string;
  /** Session mode: chat-shared (default), or experimental isolated/shared. */
  readonly sessionMode?: string;
}

export interface StartOptions {
  /**
   * Return as soon as the approval URL is available (or a terminal status is
   * reached) instead of blocking on the approval long-poll. Default: blocking.
   */
  readonly nonBlocking?: boolean;
  /** Emit a single machine-readable JSON object instead of human output. */
  readonly json?: boolean;
}

export async function agentList(stage: Stage, options: AgentTableOptions = {}): Promise<void> {
  await withDaemon(stage, async (c) => {
    const agents = await c.listAgents();
    if (options.json) {
      console.log(JSON.stringify(agents.map(agentToJson)));
    } else {
      printAgentTable(agents, options);
    }
  });
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
  const cwd = resolveAgentCwd(opts.cwd);
  const mode = opts.envSync ? asEnvSyncMode(opts.envSync) : DEFAULT_ENV_SYNC_MODE;
  const envVars = captureEnv(mode);
  const config = await withDaemon(stage, async (c) => {
    const input: AddAgentInput = {
      type,
      newioUsername: opts.username,
      acp: { cwd, ...launch },
      envVars,
      ...(opts.sessionMode ? { sessionMode: asSessionMode(opts.sessionMode) } : {}),
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
  const { nonBlocking = false, json = false } = opts;
  const human = !json;
  const { apiBaseUrl } = resolveConfig();
  const auth = new AuthManager(apiBaseUrl);
  try {
    const handle = await auth.register({ name: opts.name });
    if (human) {
      printApprovalUrl('Approve this new account in your browser:', handle.approvalUrl);
    }
    if (nonBlocking) {
      if (json) {
        console.log(JSON.stringify({ status: 'awaiting_approval', approvalUrl: handle.approvalUrl }));
      }
      return;
    }
    await handle.waitForApproval({ onPollAttempt: human ? () => process.stdout.write('.') : () => {} });
    const client = new NewioClient({ baseUrl: apiBaseUrl, tokenProvider: auth.tokenProvider });
    const me = await client.getMe({});
    if (json) {
      console.log(JSON.stringify({ status: 'created', username: me.username ?? null, userId: me.userId }));
    } else {
      console.log(`\nAccount created: @${me.username ?? '(username not set)'} (${me.userId}).`);
    }
  } finally {
    // Approval scheduled a token-refresh timer that keeps the event loop alive.
    // This command is one-shot (no daemon, no saved tokens), so tear it down to let the process exit.
    auth.dispose();
  }
}

export async function agentRemove(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => c.removeAgent(await resolveAgentId(c, query)));
  console.log('Removed.');
}

export async function agentStart(stage: Stage, query: string, opts: StartOptions = {}): Promise<void> {
  await startAndStream(stage, query, opts);
}

export async function agentStop(stage: Stage, query: string): Promise<void> {
  await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
  console.log('Stopped.');
}

export async function agentRestart(stage: Stage, query: string, opts: StartOptions = {}): Promise<void> {
  await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
  await startAndStream(stage, query, opts);
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
      const cwd = opts.cwd !== undefined ? resolveAgentCwd(opts.cwd) : undefined;
      const agents = await c.listAgents();
      const existing = agents.find((a) => a.id === agentId)?.config.acp;
      acp = mergeAcpUpdate({ ...opts, cwd }, existing);
    }
    const updates: UpdateAgentInput = {
      ...(opts.name !== undefined ? { displayName: opts.name } : {}),
      ...(opts.username !== undefined ? { newioUsername: opts.username } : {}),
      ...(opts.sessionMode !== undefined ? { sessionMode: asSessionMode(opts.sessionMode) } : {}),
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

export async function status(stage: Stage, opts: { readonly json?: boolean } = {}): Promise<void> {
  await withDaemon(stage, async (c) => {
    const version = await c.version();
    const agents = await c.listAgents();
    if (opts.json) {
      const { apiBaseUrl } = resolveConfig();
      console.log(
        JSON.stringify({ daemon: { online: true, version, stage, apiBaseUrl }, agents: agents.map(agentToJson) }),
      );
      return;
    }
    console.log(`newio daemon${stageSuffix(stage)}: online, version ${version}`);
    // Make the active backend obvious whenever it isn't the default (prod).
    if (stage !== 'prod') {
      const { apiBaseUrl } = resolveConfig();
      console.log(`  stage: ${stage} → ${apiBaseUrl}`);
    }
    console.log('');
    printAgentTable(agents);
  });
}
