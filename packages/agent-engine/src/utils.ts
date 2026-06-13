import type { AcpConfig, AgentType, SessionStreamSegment } from './types';

export async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk') {
      parts.push(segment.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

/** Resolve the command and arguments to spawn an ACP agent process. */
export function resolveCommand(
  type: AgentType,
  config: AcpConfig,
): { readonly command: string; readonly args: readonly string[] } {
  // Prefer the path-safe `command` + `args`. Fall back to the legacy
  // `executablePath`, which is split on whitespace (first token = binary, rest =
  // extra args) and so can't represent a path/arg containing spaces. For built-in
  // types the type's required ACP args come first and the override args follow;
  // for custom the override IS the full invocation.
  let overrideCommand: string | undefined;
  let overrideArgs: readonly string[];
  if (config.command !== undefined && config.command.length > 0) {
    overrideCommand = config.command;
    overrideArgs = config.args ?? [];
  } else {
    const override = config.executablePath?.trim().split(/\s+/).filter(Boolean) ?? [];
    overrideCommand = override[0];
    overrideArgs = override.slice(1);
  }

  if (type === 'kiro-cli') {
    const command = overrideCommand ?? 'kiro-cli';
    const baseArgs = config.kiroCliTrustAllTools !== false ? ['acp', '--trust-all-tools'] : ['acp'];
    return { command, args: [...baseArgs, ...overrideArgs] };
  }

  if (type === 'claude-code') {
    return { command: overrideCommand ?? 'claude-agent-acp', args: overrideArgs };
  }

  if (type === 'codex') {
    return { command: overrideCommand ?? 'codex-acp', args: overrideArgs };
  }

  if (type === 'cursor') {
    return { command: overrideCommand ?? 'agent', args: ['acp', ...overrideArgs] };
  }

  if (type === 'gemini') {
    return { command: overrideCommand ?? 'gemini', args: ['--acp', ...overrideArgs] };
  }

  // custom: the override is the entire invocation — no built-in binary or args.
  if (overrideCommand === undefined) {
    throw new Error('No executable path configured for custom agent type');
  }
  return { command: overrideCommand, args: overrideArgs };
}

/**
 * Race a promise against a timeout. Resolves with the promise's value, or
 * rejects with a `TimeoutError` once `ms` elapses if it hasn't settled. The
 * timer is always cleared so it never keeps the event loop alive. Used to bound
 * best-effort ACP RPCs (e.g. session/close during shutdown) so a dead or
 * unresponsive child process can't wedge teardown forever.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Timed out after ${ms}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Extract a human-readable message from an unknown error (handles Error instances and plain objects). */
export function extractErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const obj = err as Record<string, unknown>;
    // ACP errors may have a more detailed message in data.message
    if (typeof obj.data === 'object' && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      if (typeof data.message === 'string') {
        return data.message;
      }
    }
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof obj.message === 'string') {
      return obj.message;
    }
  }
  return String(err);
}
