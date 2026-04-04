/**
 * Shared types used across main, preload, and renderer processes.
 */

export type ThemeSource = 'system' | 'light' | 'dark';

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
  readonly cwd?: string;
}

export interface KiroCliConfig {
  readonly agentName?: string;
  readonly model?: string;
  readonly kiroCliPath?: string;
  readonly cwd?: string;
}

export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly type: AgentType;

  /** Set after first Newio registration. */
  readonly newioAgentId?: string;
  /** Set after first Newio registration (assigned by owner during approval). */
  readonly newioUsername?: string;
  /** Newio display name (synced on every start). */
  readonly newioDisplayName?: string;
  /** Newio avatar URL (synced on every start). */
  readonly newioAvatarUrl?: string;

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
  readonly name: string;
  readonly type: AgentType;
  /** Optional: existing Newio username to login with instead of registering a new agent. */
  readonly newioUsername?: string;
  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface UpdateAgentInput {
  readonly name?: string;
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
