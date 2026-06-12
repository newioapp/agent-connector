/**
 * Interactive eval types — driver MCP interface, scenarios, turns, and reports.
 */
import type { AccountType, ConversationType, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import type { SessionMode, SenderRelationship } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// Driver persona & scenario definition
// ---------------------------------------------------------------------------

export interface DriverPersona {
  readonly username: string;
  readonly displayName: string;
  readonly accountType: AccountType;
  /** The target's perceived relationship to this persona (matches the engine's SenderRelationship). */
  readonly relationship: SenderRelationship;
  readonly personality: string;
  readonly conversationId: string;
  readonly conversationType: ConversationType;
  /** Knowledge available to this persona (for informed red-team). */
  readonly knowledge?: string;
}

export interface InteractiveScenarioSetup {
  readonly agent?: {
    readonly userId: string;
    readonly username: string;
    readonly displayName: string;
  };
  readonly contacts: readonly {
    readonly username: string;
    readonly displayName: string;
    readonly accountType?: AccountType;
  }[];
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly type: ConversationType;
    readonly name: string;
    readonly members: readonly {
      readonly username: string;
      readonly displayName: string;
      readonly accountType: AccountType;
      readonly role?: string;
    }[];
  }[];
  readonly initialMemory?: LoadSessionMemoryResponse;
  readonly initialHandoffNote?: string;
}

export interface InteractiveScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: 'business' | 'technical' | 'social' | 'red_team';
  readonly sessionMode: SessionMode | 'both';

  readonly setup: InteractiveScenarioSetup;

  readonly driver: {
    readonly model?: string;
    readonly personas: readonly DriverPersona[];
    readonly objective: string;
    readonly constraints?: string;
  };

  readonly judge: {
    readonly axes: readonly string[];
    readonly criticalFailures?: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Turn records & trace
// ---------------------------------------------------------------------------

export interface TurnRecord {
  readonly index: number;
  readonly actor: 'driver' | 'target' | 'system';
  readonly persona?: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly text: string;
  readonly toolCalls?: readonly {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly result?: unknown;
  }[];
  readonly timestamp: string;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Judge verdict
// ---------------------------------------------------------------------------

export interface JudgeAxis {
  readonly name: string;
  readonly score: number;
  readonly rationale: string;
}

export interface JudgeHighlight {
  readonly turnIndex: number;
  readonly type: 'good' | 'bad' | 'critical';
  readonly description: string;
}

export interface BattleVerdict {
  readonly overallScore: number;
  readonly taskCompleted: boolean;
  readonly dataLeaked: boolean;
  readonly axes: readonly JudgeAxis[];
  readonly highlights: readonly JudgeHighlight[];
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Battle report (final output)
// ---------------------------------------------------------------------------

export interface BattleReport {
  readonly id: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly scenario: {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly description: string;
    readonly objective: string;
  };
  readonly config: {
    readonly targetModel: string;
    readonly driverModel: string;
    readonly sessionMode: string;
  };
  readonly outcome: {
    readonly declaredBy: 'driver' | 'system';
    readonly result: 'breached' | 'defended' | 'inconclusive' | 'timeout' | 'max_turns';
    readonly reason: string;
  };
  readonly turns: readonly TurnRecord[];
  readonly verdict: BattleVerdict;
}
