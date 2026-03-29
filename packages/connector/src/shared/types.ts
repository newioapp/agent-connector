/**
 * Shared types used across main, preload, and renderer processes.
 */

export type ThemeSource = 'system' | 'light' | 'dark';

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude' | 'kiro-cli';

export type AgentRuntimeStatus = 'stopped' | 'starting' | 'awaiting_approval' | 'connected' | 'running' | 'error';

export interface ClaudeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt?: string;
}

export interface KiroCliConfig {
  readonly agentName: string;
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

  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface AddAgentInput {
  readonly name: string;
  readonly type: AgentType;
  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface UpdateAgentInput {
  readonly name?: string;
  readonly claude?: ClaudeConfig;
  readonly kiroCli?: KiroCliConfig;
}

export interface AgentStatusInfo {
  readonly id: string;
  readonly config: AgentConfig;
  readonly runtimeStatus: AgentRuntimeStatus;
  readonly error?: string;
}
