/**
 * Eval scenario types — defines the shape of evaluation scenarios,
 * scripted events, and expectations.
 */
import type { AccountType, ConversationType, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import type { AgentType, SessionMode, IncomingMessage, ContactEvent, CronTriggerEvent } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Evaluation areas
// ---------------------------------------------------------------------------

export type EvalArea =
  | 'context_understanding'
  | 'tool_usage'
  | 'privacy_stranger'
  | 'privacy_contact'
  | 'privacy_peer'
  | 'privacy_with_user_consent'
  | 'prompt_injection'
  | 'response_relevance'
  | 'cross_session_knowledge'
  | 'memory_quality'
  | 'session_lifecycle'
  | 'handoff_quality'
  | 'tone_and_language'
  | 'contact_handling'
  | 'cron_execution'
  | 'instruction_following'
  | 'conversation_type'
  | 'ambiguity';

// ---------------------------------------------------------------------------
// Fixtures — reusable test data
// ---------------------------------------------------------------------------

export interface UserProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly accountType: AccountType;
  readonly relationship: 'owner' | 'peer' | 'in-contact' | 'stranger';
  /** If agent, optional owner info. */
  readonly ownerUsername?: string;
  readonly ownerDisplayName?: string;
}

export interface ConversationSetup {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly members: readonly UserProfile[];
}

export interface ContactSetup {
  readonly username: string;
  readonly displayName: string;
  readonly accountType: AccountType;
}

// ---------------------------------------------------------------------------
// Scripted events — mirrors InboundEvent from agent-engine
// ---------------------------------------------------------------------------

export type ScriptedEvent =
  | { readonly type: 'message'; readonly messages: readonly IncomingMessage[] }
  | { readonly type: 'contact'; readonly events: readonly ContactEvent[] }
  | { readonly type: 'cron'; readonly event: CronTriggerEvent }
  | { readonly type: 'initialization' }
  | { readonly type: 'session_end' }
  | { readonly type: 'memory_update' };

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/** Severity controls whether a failed expectation fails the scenario or is just a warning. */
export type ExpectationSeverity = 'error' | 'warning';

export interface SkipExpectation {
  readonly type: 'skip';
  readonly eventIndex?: number;
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface NoSkipExpectation {
  readonly type: 'no_skip';
  readonly eventIndex?: number;
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface ResponseContainsExpectation {
  readonly type: 'response_contains';
  readonly eventIndex: number;
  readonly contains: readonly string[];
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface ResponseNotContainsExpectation {
  readonly type: 'response_not_contains';
  readonly eventIndex: number;
  readonly notContains: readonly string[];
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface ToolCalledExpectation {
  readonly type: 'tool_called';
  readonly eventIndex?: number;
  readonly tool: string;
  readonly argsContain?: Readonly<Record<string, unknown>>;
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface ToolNotCalledExpectation {
  readonly type: 'tool_not_called';
  readonly eventIndex?: number;
  readonly tool: string;
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export interface LlmJudgeExpectation {
  readonly type: 'llm_judge';
  readonly eventIndex?: number;
  readonly criteria: string;
  readonly context?: string;
  readonly minScore: number;
  readonly severity?: ExpectationSeverity;
  readonly description?: string;
}

export type Expectation =
  | SkipExpectation
  | NoSkipExpectation
  | ResponseContainsExpectation
  | ResponseNotContainsExpectation
  | ToolCalledExpectation
  | ToolNotCalledExpectation
  | LlmJudgeExpectation;

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

export interface ScenarioSetup {
  /** Agent identity for this scenario. */
  readonly agent: {
    readonly userId: string;
    readonly username: string;
    readonly displayName: string;
    readonly ownerId: string;
  };
  /** Owner identity for this scenario. */
  readonly owner: {
    readonly username: string;
    readonly displayName: string;
  };
  readonly initialMemory?: LoadSessionMemoryResponse;
  readonly initialHandoffNote?: string;
  readonly contacts?: readonly ContactSetup[];
  readonly conversations?: readonly ConversationSetup[];
  /** Pre-loaded memory returned by get_memory MCP tool. Keyed by username or conversationId. */
  readonly memoryStore?: Readonly<
    Record<string, { summary: string | null; facts: readonly { factId: string; text: string }[] }>
  >;
}

/** Scenarios can declare 'both' to run in both isolated and shared modes. */
export type ScenarioSessionMode = SessionMode | 'both';

export interface EvalScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly area: EvalArea;
  readonly sessionMode: ScenarioSessionMode;
  readonly setup: ScenarioSetup;
  readonly events: readonly ScriptedEvent[];
  readonly expectations: readonly Expectation[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EvalConfig {
  readonly agentType: AgentType;
  readonly acp: { readonly executablePath?: string; readonly cwd: string };
  readonly model: string;
  readonly promptVersion: string;
  readonly sessionMode: SessionMode | 'both';
  readonly judgeModel: string;
  readonly judgeProvider: 'anthropic' | 'openai';
  readonly judgeApiKey: string;
  readonly runsPerScenario: number;
  /** Filter by area. */
  readonly area?: EvalArea;
  /** Filter by scenario ID. */
  readonly scenarioId?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
  readonly eventIndex?: number;
  readonly result?: unknown;
}

export interface EventTrace {
  readonly eventIndex: number;
  readonly event: ScriptedEvent;
  readonly promptSent: string;
  readonly agentOutput: string;
  readonly isSkip: boolean;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly latencyMs: number;
}

export interface AssertionResult {
  readonly expectation: Expectation;
  readonly passed: boolean;
  readonly severity: ExpectationSeverity;
  readonly reason: string;
  readonly score?: number;
  readonly judgeReasoning?: string;
}

export interface ScenarioRunResult {
  readonly scenarioId: string;
  readonly runIndex: number;
  readonly agentType: AgentType;
  readonly model: string;
  readonly promptVersion: string;
  readonly sessionMode: SessionMode | 'both';
  readonly traces: readonly EventTrace[];
  readonly allToolCalls: readonly ToolCallRecord[];
  readonly assertions: readonly AssertionResult[];
  readonly passed: boolean;
  readonly timestamp: string;
}

export interface ScenarioAggregateResult {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly area: EvalArea;
  readonly runs: readonly ScenarioRunResult[];
  readonly passRate: number;
  readonly meanJudgeScore?: number;
  readonly minJudgeScore?: number;
  readonly maxJudgeScore?: number;
}

export interface EvalReport {
  readonly timestamp: string;
  readonly config: EvalConfig;
  readonly scenarios: readonly ScenarioAggregateResult[];
  readonly summary: {
    readonly totalScenarios: number;
    readonly passedScenarios: number;
    readonly overallPassRate: number;
    readonly byArea: Readonly<Record<EvalArea, { readonly passRate: number; readonly meanScore?: number }>>;
  };
}
