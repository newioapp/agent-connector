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
  // The configured executable is split on whitespace for ALL types — the first
  // token is the binary, the rest are extra args. This lets an override be a
  // bare path ("/opt/bin/gemini") or a wrapped command ("node wrapper.js"). For
  // built-in types the type's required ACP args come first and these extra args
  // follow; for custom the split IS the full invocation.
  const override = config.executablePath?.trim().split(/\s+/).filter(Boolean) ?? [];
  const overrideCommand = override[0];
  const overrideArgs = override.slice(1);

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
