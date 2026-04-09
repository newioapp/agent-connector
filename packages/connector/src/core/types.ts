/**
 * Shared types used across main, preload, and renderer processes.
 */

export type ThemeSource = 'system' | 'light' | 'dark';

export type UpdateMode = 'auto' | 'manual' | 'disabled';

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude-code' | 'kiro-cli';

export type AgentRuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'awaiting_approval'
  | 'initializing'
  | 'greeting'
  | 'running'
  | 'error';

export interface ClaudeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly userPrompt?: string;
  readonly nodePath?: string;
  readonly claudeCodeCliPath?: string;
  readonly cwd: string;
}

export interface KiroCliConfig {
  readonly agentName?: string;
  readonly model?: string;
  readonly kiroCliPath?: string;
  readonly cwd: string;
  /** When true, passes --trust-all-tools to kiro-cli (skips permission prompts). Default: true. */
  readonly trustAllTools?: boolean;
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

  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

/** Default session idle timeout: 1 hour. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export interface AddAgentInput {
  readonly displayName: string;
  readonly type: AgentType;
  /** Optional: existing Newio username to login with instead of registering a new agent. */
  readonly newioUsername?: string;
  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface UpdateAgentInput {
  readonly displayName?: string;
  readonly newioUsername?: string;
  readonly envVars?: Readonly<Record<string, string>>;
  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface AgentStatusInfo {
  readonly id: string;
  readonly config: AgentConfig;
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly error?: string;
}
