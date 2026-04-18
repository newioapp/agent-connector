/**
 * Shared types used across main, preload, and renderer processes.
 */

export type ThemeSource = 'system' | 'light' | 'dark';

export type UpdateMode = 'auto' | 'manual' | 'disabled';

export type UpdateChannel = 'latest' | 'beta';

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude-code' | 'kiro-cli' | 'custom';

/** Resolve the command and arguments to spawn an ACP agent process. */
export function resolveCommand(
  type: AgentType,
  config: AcpConfig,
): { readonly command: string; readonly args: readonly string[] } {
  if (type === 'kiro-cli') {
    const command = config.executablePath ?? 'kiro-cli';
    const args = config.kiroCliTrustAllTools !== false ? ['acp', '--trust-all-tools'] : ['acp'];
    return { command, args };
  }

  if (type === 'claude-code') {
    return { command: config.executablePath ?? 'claude-agent-acp', args: [] };
  }

  // custom: user provides the full command string, possibly with args baked in
  if (!config.executablePath) {
    throw new Error('No executable path configured for custom agent type');
  }
  const parts = config.executablePath.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('No executable path configured for custom agent type');
  }
  const [command, ...rest] = parts;
  return { command, args: rest };
}

export type AgentRuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'awaiting_approval'
  | 'initializing'
  | 'greeting'
  | 'running'
  | 'error';

export interface AcpConfig {
  readonly executablePath?: string;
  readonly cwd: string;
  /** When true, passes --trust-all-tools to the ACP agent (kiro-cli only — skips permission prompts). Default: true. */
  readonly kiroCliTrustAllTools?: boolean;
}

/** Serializable subset of ACP InitializeResponse — discovered at runtime. */
export interface AcpAgentInfo {
  readonly protocolVersion: string;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly agentTitle?: string;
  readonly loadSession?: boolean;
}

/** Newio identity — populated after first registration/login, synced on every start. */
export interface NewioIdentity {
  /** Newio user ID (present once registered). */
  readonly agentId?: string;
  /** Newio username (assigned by owner during approval). */
  readonly username?: string;
  /** Newio display name. */
  readonly displayName?: string;
  /** Newio avatar URL. */
  readonly avatarUrl?: string;
}

export interface AgentConfig {
  readonly id: string;
  readonly type: AgentType;

  /** Newio identity — set after first registration, synced on every start. */
  readonly newio?: NewioIdentity;

  /** Idle timeout for sessions in ms. Sessions with no activity are stopped. Default: 1 hour. */
  readonly sessionIdleTimeoutMs?: number;

  /** Environment variables passed to the agent process. */
  readonly envVars: Readonly<Record<string, string>>;

  readonly acp?: AcpConfig;

  /** ACP agent info — discovered during initialization, persisted for display. */
  readonly acpAgentInfo?: AcpAgentInfo;
}

/** Default session idle timeout: 1 hour. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export interface AddAgentInput {
  readonly displayName: string;
  readonly type: AgentType;
  /** Optional: existing Newio username to login with instead of registering a new agent. */
  readonly newioUsername?: string;
  readonly acp?: AcpConfig;
}

export interface UpdateAgentInput {
  readonly displayName?: string;
  readonly newioUsername?: string;
  readonly envVars?: Readonly<Record<string, string>>;
  readonly acp?: AcpConfig;
}

export interface AgentStatusInfo {
  readonly id: string;
  readonly config: AgentConfig;
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Session stream types
// ---------------------------------------------------------------------------

/** Segment types that the stream aggregates and yields. */
export type SegmentType = 'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update';

/** An aggregated segment yielded by the stream. */
export interface SessionStreamSegment {
  readonly type: SegmentType;
  readonly text: string;
}

export type SessionStatus = 'thinking' | 'typing' | 'tool_calling' | 'idle';

export type SessionStatusListener = (status: SessionStatus) => void;
