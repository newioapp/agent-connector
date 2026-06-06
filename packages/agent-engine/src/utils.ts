import type { AcpConfig, AgentType, SessionStreamSegment } from './types';
import { buildClaudeRunCommand } from './claude-acp';
import type { ResolvedAgentCommand } from './claude-acp';

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
export function resolveCommand(type: AgentType, config: AcpConfig): ResolvedAgentCommand {
  if (type === 'kiro-cli') {
    const command = config.executablePath ?? 'kiro-cli';
    const args = config.kiroCliTrustAllTools !== false ? ['acp', '--trust-all-tools'] : ['acp'];
    return { command, args };
  }

  if (type === 'claude-code') {
    // Default: run the claude-agent-acp bundled as a dependency of this package.
    // An explicit executablePath override still takes precedence (power users).
    if (config.executablePath) {
      return { command: config.executablePath, args: [] };
    }
    return buildClaudeRunCommand();
  }

  if (type === 'codex') {
    return { command: config.executablePath ?? 'codex-acp', args: [] };
  }

  if (type === 'cursor') {
    return { command: config.executablePath ?? 'agent', args: ['acp'] };
  }

  if (type === 'gemini') {
    return { command: config.executablePath ?? 'gemini', args: ['--acp'] };
  }

  // custom: user provides the full command string, possibly with args baked in
  if (!config.executablePath) {
    throw new Error('No executable path configured for custom agent type');
  }
  const parts = config.executablePath.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (command === undefined) {
    throw new Error('No executable path configured for custom agent type');
  }
  return { command, args: parts.slice(1) };
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
