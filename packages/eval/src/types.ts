/**
 * Eval scenario types — defines the shape of evaluation scenarios,
 * scripted events, and expectations.
 */
import type { AccountType, ConversationType } from '@newio/agent-sdk';
import type { AgentType, SessionMode } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Evaluation areas
// ---------------------------------------------------------------------------

export type EvalArea =
  | 'context_understanding'
  | 'tool_usage'
  | 'privacy'
  | 'response_relevance'
  | 'cross_session_knowledge'
  | 'memory_quality'
  | 'session_lifecycle'
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

export interface MemoryFact {
  readonly factId: string;
  readonly text: string;
}

export interface MemorySummary {
  readonly text: string;
}

export interface MemoryScope {
  readonly summary?: MemorySummary;
  readonly facts: readonly MemoryFact[];
}

export interface MemorySetup {
  readonly global: MemoryScope;
  readonly participants: Readonly<Record<string, MemoryScope>>;
  readonly conversation: MemoryScope;
  readonly topUsers: readonly { readonly scopeId: string; readonly text: string }[];
  readonly topConversations: readonly { readonly scopeId: string; readonly text: string }[];
}

// ---------------------------------------------------------------------------
// Scripted events
// ---------------------------------------------------------------------------

export interface DmEvent {
  readonly type: 'dm';
  readonly from: UserProfile;
  readonly text: string;
  readonly conversationId?: string;
  readonly attachments?: readonly {
    readonly attachmentType: 'image' | 'file';
    readonly fileName: string;
    readonly contentType: string;
    readonly size: number;
    readonly s3Key: string;
  }[];
}

export interface GroupMessageEvent {
  readonly type: 'group_message';
  readonly conversation: ConversationSetup;
  readonly from: UserProfile;
  readonly text: string;
}

export interface ContactEventScripted {
  readonly type: 'contact_event';
  readonly eventType:
    | 'contact.request_received'
    | 'contact.request_accepted'
    | 'contact.request_rejected'
    | 'contact.removed';
  readonly from: UserProfile;
  readonly note?: string;
}

export interface CronTriggerScripted {
  readonly type: 'cron_trigger';
  readonly cronId: string;
  readonly label: string;
  readonly payload?: unknown;
}

export interface SessionEndEvent {
  readonly type: 'session_end';
}

export interface MemoryUpdateEvent {
  readonly type: 'memory_update';
}

export type ScriptedEvent =
  | DmEvent
  | GroupMessageEvent
  | ContactEventScripted
  | CronTriggerScripted
  | SessionEndEvent
  | MemoryUpdateEvent;

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export interface SkipExpectation {
  readonly type: 'skip';
  readonly eventIndex?: number;
  readonly description?: string;
}

export interface NoSkipExpectation {
  readonly type: 'no_skip';
  readonly eventIndex?: number;
  readonly description?: string;
}

export interface ResponseContainsExpectation {
  readonly type: 'response_contains';
  readonly eventIndex: number;
  readonly contains: readonly string[];
  readonly description?: string;
}

export interface ResponseNotContainsExpectation {
  readonly type: 'response_not_contains';
  readonly eventIndex: number;
  readonly notContains: readonly string[];
  readonly description?: string;
}

export interface ToolCalledExpectation {
  readonly type: 'tool_called';
  readonly eventIndex?: number;
  readonly tool: string;
  readonly argsContain?: Readonly<Record<string, unknown>>;
  readonly description?: string;
}

export interface ToolNotCalledExpectation {
  readonly type: 'tool_not_called';
  readonly eventIndex?: number;
  readonly tool: string;
  readonly description?: string;
}

export interface LlmJudgeExpectation {
  readonly type: 'llm_judge';
  readonly eventIndex?: number;
  readonly criteria: string;
  readonly minScore: number;
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
  readonly memory?: MemorySetup;
  readonly handoffNote?: string;
  readonly contacts?: readonly ContactSetup[];
  readonly conversations?: readonly ConversationSetup[];
}

export interface EvalScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly area: EvalArea;
  readonly sessionMode: SessionMode;
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
  readonly sessionMode: SessionMode;
  readonly judgeModel: string;
  readonly judgeApiKeyEnvVar: string;
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
  readonly sessionMode: SessionMode;
  readonly traces: readonly EventTrace[];
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
