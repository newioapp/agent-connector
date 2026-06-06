/**
 * Locating and launching the bundled Claude ACP agent.
 *
 * `@agentclientprotocol/claude-agent-acp` is a runtime dependency of this
 * package, so users no longer need to install it themselves. We resolve its bin
 * entry (`dist/index.js`) and run it with the current executable acting as Node
 * (`ELECTRON_RUN_AS_NODE=1`). Running the *same* bundled, signed native `claude`
 * binary for both authentication and the ACP runtime is what fixes the macOS
 * Keychain failure: the credential's Keychain item ACL only trusts the binary
 * that created it, so the login flow and the runtime must be the same binary.
 *
 * Packaging note (Electron): the claude-agent-acp JS stays *inside* app.asar —
 * `ELECTRON_RUN_AS_NODE` retains Electron's asar support, so its packed JS deps
 * (zod, the ACP/Claude SDKs) resolve fine. The only thing that must be unpacked
 * is the native `claude` binary, because a file inside an asar archive cannot be
 * `exec`'d. We resolve that binary's on-disk (`.unpacked`) path and hand it to
 * claude-agent-acp via `CLAUDE_CODE_EXECUTABLE`, which it honors for both the
 * `--cli` passthrough and the ACP runtime.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** A spawnable command: executable + args + extra env to merge into the child. */
export interface ResolvedAgentCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment variables to merge into the child process env. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Which interactive Claude login flow to run. */
export type ClaudeAuthMethod = 'subscription' | 'console';

/** Absolute path to the bundled claude-agent-acp CLI entry (`dist/index.js`). */
export function resolveClaudeAcpEntry(): string {
  return nodeRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
}

/**
 * Absolute on-disk path to the native `claude` binary, with any `app.asar`
 * segment rewritten to `app.asar.unpacked` so it points at the real executable.
 * Returns undefined if it can't be resolved (e.g. an unusual install) — in that
 * case claude-agent-acp falls back to resolving it itself.
 */
export function resolveClaudeNativeBinary(): string | undefined {
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Resolve relative to claude-agent-acp's own SDK so the platform-specific
  // optional binary package is found even under pnpm's nested layout — mirrors
  // claude-agent-acp's internal claudeCliPath() resolution.
  let sdkRequire: ReturnType<typeof createRequire>;
  try {
    const acpRequire = createRequire(resolveClaudeAcpEntry());
    sdkRequire = createRequire(acpRequire.resolve('@anthropic-ai/claude-agent-sdk'));
  } catch {
    return undefined;
  }
  const candidates =
    process.platform === 'linux'
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return sdkRequire.resolve(candidate).replace('app.asar', 'app.asar.unpacked');
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/** Build the env every bundled-Claude invocation needs (run-as-node + native binary path). */
function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  const binary = resolveClaudeNativeBinary();
  if (binary) {
    env.CLAUDE_CODE_EXECUTABLE = binary;
  }
  return env;
}

/** Command to run the bundled claude-agent-acp ACP server over stdio. */
export function buildClaudeRunCommand(): ResolvedAgentCommand {
  return {
    command: process.execPath,
    args: [resolveClaudeAcpEntry()],
    env: buildClaudeEnv(),
  };
}

/**
 * Command to run the bundled claude-agent-acp interactive login flow.
 *
 * `--cli` makes the entry re-spawn the native `claude` binary with the remaining
 * args, so this becomes `claude auth login --claudeai|--console`.
 */
export function buildClaudeAuthCommand(method: ClaudeAuthMethod): ResolvedAgentCommand {
  const loginFlag = method === 'subscription' ? '--claudeai' : '--console';
  return {
    command: process.execPath,
    args: [resolveClaudeAcpEntry(), '--cli', 'auth', 'login', loginFlag],
    env: buildClaudeEnv(),
  };
}
