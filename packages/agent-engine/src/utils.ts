import type { AcpConfig, AgentType, SessionStreamSegment } from './types';
import { managedAdapterByType } from './adapters/adapter-spec.js';
import { resolveActiveBinEntry } from './adapters/adapter-store.js';

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

/**
 * Resolve how to spawn an ACP agent, preferring a connector-managed adapter
 * install over a PATH lookup.
 *
 * Resolution order:
 *   1. An explicit `executablePath` override always wins — managed installs are
 *      skipped entirely, so power users (nix, custom wrappers) are unaffected.
 *   2. For a managed type (claude-code/codex) with an active install under
 *      `adaptersRoot`, launch the installed bin via `node <entry>`. The adapters
 *      are node scripts, so this reuses the same system `node` the connector
 *      already requires (see assertNodeAvailable) rather than depending on the
 *      adapter binary being on PATH.
 *   3. Otherwise fall back to the default PATH-based invocation (today's
 *      behavior) — e.g. a user who pre-installed the adapter globally, or the
 *      unmanaged types (cursor/gemini/kiro-cli/custom).
 */
export function resolveSpawn(
  type: AgentType,
  config: AcpConfig,
  adaptersRoot?: string,
): { readonly command: string; readonly args: readonly string[] } {
  const hasOverride = (config.executablePath?.trim().length ?? 0) > 0;
  if (!hasOverride && adaptersRoot !== undefined) {
    const spec = managedAdapterByType(type);
    if (spec) {
      const entry = resolveActiveBinEntry(adaptersRoot, spec.key);
      if (entry !== undefined) {
        // Keep any type-specific args the default invocation would add (none for
        // claude/codex today, but this stays correct if that changes).
        const base = resolveCommand(type, config);
        return { command: 'node', args: [entry, ...base.args] };
      }
    }
  }
  return resolveCommand(type, config);
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
