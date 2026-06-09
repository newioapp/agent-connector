/**
 * Managed ACP adapters — the npm-distributed agent adapters the connector can
 * install and version on the user's behalf, so they don't have to be present on
 * PATH before an agent starts.
 *
 * Only adapters published as self-contained npm packages belong here. The other
 * agent types (cursor/gemini/kiro-cli/custom) are launched from PATH or an
 * explicit executable override and are intentionally NOT managed.
 *
 * Both adapters need their full dependency tree to run — claude-agent-acp pulls
 * regular deps, codex-acp resolves a platform-specific prebuilt binary via
 * optionalDependencies — so installs go through a real dependency-tree resolver
 * (see the CLI's adapter installer), not a bare tarball extract.
 */
import type { AgentType } from '../types.js';

export interface ManagedAdapterSpec {
  /** Short, user-facing key used on the CLI (`newio adapter install <key>`). */
  readonly key: string;
  /** The agent type this adapter backs. */
  readonly type: AgentType;
  /** npm package name to install. */
  readonly pkg: string;
  /** The package's bin name (its entry under `bin/` in package.json). */
  readonly bin: string;
}

export const MANAGED_ADAPTERS: readonly ManagedAdapterSpec[] = [
  {
    key: 'claude',
    type: 'claude-code',
    pkg: '@agentclientprotocol/claude-agent-acp',
    bin: 'claude-agent-acp',
  },
  {
    key: 'codex',
    type: 'codex',
    pkg: '@zed-industries/codex-acp',
    bin: 'codex-acp',
  },
];

/** The friendly keys, e.g. for CLI `.choices(...)`. */
export const MANAGED_ADAPTER_KEYS: readonly string[] = MANAGED_ADAPTERS.map((a) => a.key);

/** Resolve a managed adapter by its friendly key (`claude`/`codex`), or undefined. */
export function managedAdapterByKey(key: string): ManagedAdapterSpec | undefined {
  return MANAGED_ADAPTERS.find((a) => a.key === key);
}

/** Resolve the managed adapter backing an agent type, or undefined if the type isn't managed. */
export function managedAdapterByType(type: AgentType): ManagedAdapterSpec | undefined {
  return MANAGED_ADAPTERS.find((a) => a.type === type);
}
