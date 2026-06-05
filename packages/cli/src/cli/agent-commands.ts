/**
 * `newio agent …` and `newio agent env …` commands.
 *
 * Thin wrappers over DaemonConnector RPC. Agent ids may be given as a full id,
 * a unique id prefix, or an exact display name.
 */
import type { DaemonConnector } from '../connector.js';
import type { AddAgentInput, AgentStatusInfo, AgentType, SessionMode, UpdateAgentInput } from '@newio/agent-engine';
import { withDaemon, openConnection } from '../client/connect.js';
import { extractOption, extractStage } from './args.js';

const AGENT_TYPES: readonly AgentType[] = ['claude-code', 'kiro-cli', 'codex', 'cursor', 'gemini', 'custom'];
const SESSION_MODES: readonly SessionMode[] = ['isolated', 'shared'];

/** Runtime statuses at which `agent start` is done waiting. */
const TERMINAL_STATUSES = new Set(['running', 'error', 'stopped']);

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

/** Resolve a user-supplied query to a single agent id. */
export async function resolveAgentId(connector: DaemonConnector, query: string): Promise<string> {
  const agents = await connector.listAgents();
  const exact = agents.find((a) => a.id === query);
  if (exact) {
    return exact.id;
  }
  const byPrefix = agents.filter((a) => a.id.startsWith(query));
  if (byPrefix.length > 1) {
    throw new Error(`Ambiguous agent "${query}" — matches ${byPrefix.length} agents.`);
  }
  const [prefixMatch] = byPrefix;
  if (prefixMatch) {
    return prefixMatch.id;
  }
  const [nameMatch, ...otherNames] = agents.filter((a) => a.config.newio?.displayName === query);
  if (nameMatch && otherNames.length === 0) {
    return nameMatch.id;
  }
  throw new Error(`No agent matching "${query}".`);
}

function printAgentTable(agents: readonly AgentStatusInfo[]): void {
  if (agents.length === 0) {
    console.log('No agents configured. Add one with: newio agent add --type <type> --name <name>');
    return;
  }
  const rows = agents.map((a) => ({
    id: a.id.slice(0, 8),
    type: a.config.type,
    name: a.config.newio?.displayName ?? '—',
    status: a.error ? `${a.runtimeStatus} (${a.error})` : a.runtimeStatus,
  }));
  const w = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
  };
  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(`${pad('ID', w.id)}  ${pad('TYPE', w.type)}  ${pad('NAME', w.name)}  STATUS`);
  for (const r of rows) {
    console.log(`${pad(r.id, w.id)}  ${pad(r.type, w.type)}  ${pad(r.name, w.name)}  ${r.status}`);
  }
}

function buildAgentInput(args: string[]): { input: AddAgentInput; rest: string[] } {
  let rest = args;
  const name = extractOption(rest, ['--name']);
  rest = name.rest;
  const type = extractOption(rest, ['--type']);
  rest = type.rest;
  const cwd = extractOption(rest, ['--cwd']);
  rest = cwd.rest;
  const username = extractOption(rest, ['--username']);
  rest = username.rest;
  const sessionMode = extractOption(rest, ['--session-mode']);
  rest = sessionMode.rest;

  if (type.value === undefined) {
    throw new Error('--type is required (one of: ' + AGENT_TYPES.join(', ') + ').');
  }
  if (name.value === undefined) {
    throw new Error('--name is required.');
  }
  const input: AddAgentInput = {
    displayName: name.value,
    type: asAgentType(type.value),
    acp: { cwd: cwd.value ?? process.cwd() },
    ...(username.value ? { newioUsername: username.value } : {}),
    ...(sessionMode.value ? { sessionMode: asSessionMode(sessionMode.value) } : {}),
  };
  return { input, rest };
}

function buildAgentUpdate(args: string[]): UpdateAgentInput {
  let rest = args;
  const name = extractOption(rest, ['--name']);
  rest = name.rest;
  const cwd = extractOption(rest, ['--cwd']);
  rest = cwd.rest;
  const username = extractOption(rest, ['--username']);
  rest = username.rest;
  const sessionMode = extractOption(rest, ['--session-mode']);
  rest = sessionMode.rest;

  return {
    ...(name.value !== undefined ? { displayName: name.value } : {}),
    ...(username.value !== undefined ? { newioUsername: username.value } : {}),
    ...(sessionMode.value !== undefined ? { sessionMode: asSessionMode(sessionMode.value) } : {}),
    ...(cwd.value !== undefined ? { acp: { cwd: cwd.value } } : {}),
  };
}

/** Start an agent and stream status until it reaches a terminal state. */
async function startAndStream(stage: Parameters<typeof openConnection>[0], query: string): Promise<void> {
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

async function runEnvSubcommand(
  stage: Parameters<typeof withDaemon>[0],
  sub: string | undefined,
  args: string[],
): Promise<void> {
  const [query, ...rest] = args;
  if (query === undefined && sub !== undefined) {
    throw new Error(`Usage: newio agent env ${sub} <agent>`);
  }

  await withDaemon(stage, async (connector) => {
    const agentId = await resolveAgentId(connector, query ?? '');
    const agents = await connector.listAgents();
    const current = agents.find((a) => a.id === agentId)?.config.envVars ?? {};

    switch (sub) {
      case 'list': {
        const keys = Object.keys(current).sort();
        if (keys.length === 0) {
          console.log('No environment variables set.');
        }
        for (const key of keys) {
          console.log(`${key}=${current[key]}`);
        }
        return;
      }
      case 'set': {
        const next: Record<string, string> = { ...current, ...parseEnvPairs(rest) };
        await connector.updateAgentEnvVars(agentId, next);
        console.log(`Updated ${rest.length} variable(s).`);
        return;
      }
      case 'unset': {
        const remove = new Set(rest);
        const next: Record<string, string> = {};
        for (const [key, val] of Object.entries(current)) {
          if (!remove.has(key)) {
            next[key] = val;
          }
        }
        await connector.updateAgentEnvVars(agentId, next);
        console.log(`Removed ${rest.length} variable(s).`);
        return;
      }
      case 'sync': {
        const { value: shellArg } = extractOption(rest, ['--shell']);
        const shells = await connector.listShells();
        const shell = shellArg ?? shells[0];
        if (!shell) {
          throw new Error('No login shell available to sync from.');
        }
        const shellEnv = await connector.getShellEnv(shell);
        // Overlay shell-derived vars on existing ones (preserves custom keys).
        await connector.updateAgentEnvVars(agentId, { ...current, ...shellEnv }, shell);
        console.log(`Synced ${Object.keys(shellEnv).length} variable(s) from ${shell}.`);
        return;
      }
      default:
        throw new Error(`Unknown env command: ${sub ?? '(none)'}`);
    }
  });
}

/** `newio env shells` — list login shells available for env sync. */
export async function runEnvShells(rawArgs: string[]): Promise<void> {
  const { stage } = extractStage(rawArgs);
  const shells = await withDaemon(stage, (c) => c.listShells());
  for (const shell of shells) {
    console.log(shell);
  }
}

/** `newio status` — daemon health + agent overview. */
export async function runStatus(rawArgs: string[]): Promise<void> {
  const { stage } = extractStage(rawArgs);
  await withDaemon(stage, async (c) => {
    const version = await c.version();
    console.log(`newio daemon (${stage}): online, version ${version}\n`);
    printAgentTable(await c.listAgents());
  });
}

export async function runAgentCommand(sub: string | undefined, rawArgs: string[]): Promise<void> {
  const { stage, rest: args } = extractStage(rawArgs);

  switch (sub) {
    case undefined:
    case 'list':
      await withDaemon(stage, async (c) => printAgentTable(await c.listAgents()));
      return;
    case 'add': {
      const { input } = buildAgentInput(args);
      const config = await withDaemon(stage, (c) => c.addAgent(input));
      console.log(`Added agent ${config.id} (${config.newio?.displayName ?? input.displayName}).`);
      console.log(`Start it with: newio agent start ${config.id.slice(0, 8)}`);
      return;
    }
    case 'remove': {
      const [query] = args;
      if (!query) {
        throw new Error('Usage: newio agent remove <agent>');
      }
      await withDaemon(stage, async (c) => c.removeAgent(await resolveAgentId(c, query)));
      console.log('Removed.');
      return;
    }
    case 'start': {
      const [query] = args;
      if (!query) {
        throw new Error('Usage: newio agent start <agent>');
      }
      await startAndStream(stage, query);
      return;
    }
    case 'stop': {
      const [query] = args;
      if (!query) {
        throw new Error('Usage: newio agent stop <agent>');
      }
      await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
      console.log('Stopped.');
      return;
    }
    case 'restart': {
      const [query] = args;
      if (!query) {
        throw new Error('Usage: newio agent restart <agent>');
      }
      await withDaemon(stage, async (c) => c.stopAgent(await resolveAgentId(c, query)));
      await startAndStream(stage, query);
      return;
    }
    case 'info': {
      const [query] = args;
      if (!query) {
        throw new Error('Usage: newio agent info <agent>');
      }
      const info = await withDaemon(stage, async (c) => c.getAgentInfo(await resolveAgentId(c, query)));
      console.log(info ? JSON.stringify(info, null, 2) : 'No runtime info (agent not running).');
      return;
    }
    case 'update': {
      const [query, ...updateArgs] = args;
      if (!query) {
        throw new Error('Usage: newio agent update <agent> [--name ...] [--cwd ...] [--session-mode ...]');
      }
      const updates = buildAgentUpdate(updateArgs);
      await withDaemon(stage, async (c) => c.updateAgent(await resolveAgentId(c, query), updates));
      console.log('Updated.');
      return;
    }
    case 'env': {
      const [envSub, ...envArgs] = args;
      await runEnvSubcommand(stage, envSub, envArgs);
      return;
    }
    default:
      throw new Error(`Unknown agent command: ${sub}`);
  }
}
