/**
 * Interactive eval types — driver MCP interface, scenarios, turns, and reports.
 */
import type { IncomingMessage, AccountType, ConversationType, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import type { SessionMode } from '@newio/agent-engine';

// ---------------------------------------------------------------------------
// NewioAppForDriverMcp — the contract the Driver MCP server requires
// ---------------------------------------------------------------------------

/** A message sent by the target agent that the driver can observe. */
export interface TargetMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly text?: string;
  readonly toolCalls?: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
  readonly timestamp: number;
}

/**
 * Interface that decouples the Driver MCP server from the mock environment.
 * Focused on: injecting messages as users, reading target output, and owner controls.
 */
export interface NewioAppForDriverMcp {
  // ── Message injection ──
  /** Inject a message into the target's event pipeline as a specific user. */
  injectMessage(persona: string, conversationId: string, text: string, filePaths?: readonly string[]): IncomingMessage;

  // ── Target observation ──
  /** Get all messages sent by the target since the given timestamp. */
  getTargetMessagesSince(sinceTimestamp: number): readonly TargetMessage[];

  // ── Conversation management (as a user) ──
  /** Get conversations a persona is a member of. */
  getPersonaConversations(
    persona: string,
  ): readonly { readonly conversationId: string; readonly type: string; readonly name?: string }[];

  /** Get message history for a conversation (what the persona can see). */
  getConversationHistory(
    persona: string,
    conversationId: string,
    limit?: number,
  ): readonly { readonly from: string; readonly text: string; readonly timestamp: number }[];

  /** Create a group conversation as a persona. */
  createConversationAsPersona(
    persona: string,
    type: 'group' | 'temp_group',
    name: string,
    memberUsernames: readonly string[],
  ): string;

  /** Add a member to a conversation. */
  addMemberAsPersona(persona: string, conversationId: string, username: string): void;

  /** Remove persona from a conversation. */
  leaveConversation(persona: string, conversationId: string): void;

  // ── Owner controls ──
  /** Trigger session rotation on the target agent for a conversation. */
  triggerRotateSession(conversationId: string): Promise<void>;

  /** Trigger memory update on the target agent for a conversation. */
  triggerUpdateMemory(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Driver persona & scenario definition
// ---------------------------------------------------------------------------

export interface DriverPersona {
  readonly username: string;
  readonly displayName: string;
  readonly accountType: AccountType;
  readonly relationship: 'owner' | 'friend' | 'stranger';
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
    readonly name?: string;
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
    readonly maxTurns: number;
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
  readonly actor: 'driver' | 'target';
  readonly persona?: string;
  readonly conversationId: string;
  readonly conversationType?: string;
  readonly text: string;
  readonly toolCalls?: readonly {
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly result?: unknown;
  }[];
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
    readonly maxTurns: number;
  };
  readonly outcome: {
    readonly declaredBy: 'driver' | 'system';
    readonly result: 'objective_achieved' | 'objective_failed' | 'exhausted' | 'timeout' | 'max_turns';
    readonly reason: string;
  };
  readonly turns: readonly TurnRecord[];
  readonly verdict: BattleVerdict;
}
