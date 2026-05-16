# Agent Evaluation Framework — Design Document

Last updated: 2026-05-16

## Overview

A systematic evaluation framework for testing agent behavior when orchestrated by the agent-engine. Evals exercise real ACP agents (Claude Code, Kiro CLI, Codex, etc.) against scripted messaging scenarios, scoring their responses with both rule-based assertions and LLM-as-judge.

## Goals

1. Measure agent quality across well-defined behavioral dimensions
2. Detect regressions when prompts (`PromptFormatterImpl`) or MCP tools change
3. Compare behavior between session modes (isolated vs. shared)
4. Provide actionable data for prompt tuning and future agent development

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Eval Runner                          │
│                                                         │
│  ┌─────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │Scenario │───►│ Mock Newio   │───►│ Real ACP Agent│  │
│  │ Script  │    │ Environment  │    │ (claude, etc) │  │
│  └─────────┘    └──────────────┘    └───────────────┘  │
│                         │                     │         │
│                         ▼                     ▼         │
│               ┌──────────────────────────────────┐      │
│               │      Trace Collector             │      │
│               │ (events fed, output, tool calls) │      │
│               └──────────────────┬───────────────┘      │
│                                  │                      │
│                    ┌─────────────┴─────────────┐        │
│                    ▼                           ▼        │
│           ┌──────────────┐           ┌──────────────┐   │
│           │ Rule-Based   │           │ LLM-as-Judge │   │
│           │ Assertions   │           │  (API call)  │   │
│           └──────────────┘           └──────────────┘   │
│                    │                           │        │
│                    └─────────────┬─────────────┘        │
│                                  ▼                      │
│                         ┌──────────────┐                │
│                         │    Report    │                │
│                         └──────────────┘                │
└─────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Real agents, mock backend** — The ACP agent (Claude Code, Kiro CLI, etc.) is real. The Newio environment (messages arriving, tool call interception) is mocked. This tests the actual agent behavior with the real system prompt.

2. **LLM-as-judge from day 1** — Direct LLM API calls (not ACP) for scoring. Stateless, single prompt→response. Judge model configured via env var (`EVAL_JUDGE_MODEL`).

3. **Separate package** — Lives at `packages/eval`, depends on `@newio/agent-engine`. Not shipped to users.

4. **Statistical runs** — Each scenario runs 3-5 times. Report mean + variance to account for non-determinism.

## Evaluation Areas

### Area 1: Multi-User, Multi-Conversation Context Understanding

Can the agent track who said what, in which conversation, and reference information across conversations?

- Shared mode: all context in one session — should perform well
- Isolated mode: must rely on memory — measure degradation

Example: Alice says something in a group, then DMs the agent about it. Agent should reference the group context.

### Area 2: Correct Tool Usage

Does the agent call the right MCP tool for the task?

- Uses `send_dm` / `dm_owner` (shared) or `initiate_conversation` (isolated) for cross-conversation messaging
- Does NOT use messaging tools to reply to the current conversation (auto-delivered)
- Calls memory tools appropriately during session-end prompts
- Uses contact tools (not text reply) for contact events

### Area 3: Privacy Protection

Does the agent protect the owner's private information from strangers?

- Refuses to share owner's schedule, messages, or personal details with non-contacts
- Does not fetch owner's conversations when asked by strangers
- Handles social engineering attempts gracefully

### Area 4: Response Relevance & Skip Behavior

Does the agent respond only when appropriate?

- DMs → always respond
- Groups → only when @mentioned or clearly relevant, otherwise `_skip`
- Work Sessions (temp_group) → proactive participation
- Contact events → always `_skip` (response discarded), act via tools
- Cron events → always `_skip`, act via tools

### Area 5: Cross-Session Knowledge Sharing (Isolated Mode)

How well does the memory system bridge sessions?

- Facts learned in session A are retrievable in session B
- Agent calls `add_memory` for durable facts at session end
- Handoff notes capture current state of work (not durable facts)
- Agent uses `get_memory` tool to fetch context about new participants

### Area 6: Memory Management Quality

Does the agent write useful, well-structured memory?

- Follows 4-gate framework: future utility, novelty, factual, safe
- Facts are self-contained, third-person, no pronouns
- Summaries stay under 8 lines
- Does not store transient chatter, duplicates, or sensitive credentials
- Does not overwrite good summaries with worse ones

### Area 7: Session Lifecycle Behavior

Does the agent handle session transitions gracefully?

- Produces useful handoff notes (2-4 sentences, current state of work)
- Resumes coherently with only memory + handoff (no conversation history)
- Responds to `buildSessionEndPrompt` and `buildMemoryUpdatePrompt` correctly
- Does not confuse lifecycle prompts with user messages

### Area 8: Tone, Relationship & Language Calibration

Does the agent adjust behavior based on relationship, account type, and language?

- Owner messages get priority treatment
- Strangers get professional distance
- Sibling agents get peer-like interaction
- **Language matching**: responds in the language the user writes in
- **Language switching**: in shared mode, correctly switches language between consecutive messages from different users (no bleed)
- **Fallback**: defaults to English if no prior history and language is ambiguous

Language resolution order:
1. Match the language the user is currently writing in
2. If ambiguous, use the language from previous conversations (memory)
3. If no prior history, default to English

### Area 9: Contact Event Handling

Does the agent make sensible decisions on contact events?

- Understands that text reply is discarded — must act via tools only
- Makes reasonable accept/reject decisions on friend requests
- Notifies owner (via `dm_owner` or `initiate_conversation`) when appropriate
- Outputs `_skip` as instructed

### Area 10: Cron Execution Correctness

Does the agent execute scheduled tasks correctly?

- Uses the right tools based on cron label and payload
- Sends messages to the correct conversation
- Outputs `_skip` (response is discarded)
- Handles payloads correctly

### Area 11: Instruction Following & Tool Boundaries

Does the agent stay within its available tool set?

- In isolated mode: does NOT try to call `send_dm`/`dm_owner` (unavailable)
- Does not invent tool names that aren't registered
- Follows "your reply is auto-delivered" rule — no double-sending
- Does not hallucinate tool parameters or capabilities

### Area 12: Conversation Type Discrimination

Does the agent follow per-type behavioral rules?

- DM → always respond
- Group → selective (@mention or clearly relevant)
- temp_group (Work Session) → proactive, contributing

### Area 13: Graceful Degradation Under Ambiguity

How does the agent handle unclear or conflicting input?

- Asks for clarification when appropriate
- Makes reasonable assumptions and states them
- Says "I don't know" rather than hallucinating
- Handles conflicting information from different users

## Scenario Definition Format

```typescript
interface EvalScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly area: EvalArea;
  readonly sessionMode: 'isolated' | 'shared' | 'both';

  /** Pre-loaded state before events are fed. */
  readonly setup: ScenarioSetup;

  /** Ordered sequence of events to feed into the engine. */
  readonly events: readonly ScriptedEvent[];

  /** What to check after each event or at the end. */
  readonly expectations: readonly Expectation[];
}

interface ScenarioSetup {
  readonly memory?: LoadSessionMemoryResponse;
  readonly handoffNote?: string;
  readonly contacts?: ContactSetup[];
  readonly conversations?: ConversationSetup[];
}

type ScriptedEvent =
  | { readonly type: 'dm'; readonly from: UserProfile; readonly text: string; readonly attachments?: Attachment[] }
  | { readonly type: 'group_message'; readonly conversation: ConversationSetup; readonly from: UserProfile; readonly text: string }
  | { readonly type: 'contact_event'; readonly event: ContactEvent }
  | { readonly type: 'cron_trigger'; readonly job: CronTriggerEvent }
  | { readonly type: 'session_end' }
  | { readonly type: 'memory_update' };

type Expectation =
  | { readonly type: 'skip'; readonly eventIndex?: number }
  | { readonly type: 'no_skip'; readonly eventIndex?: number }
  | { readonly type: 'response_contains'; readonly eventIndex: number; readonly contains: readonly string[] }
  | { readonly type: 'response_not_contains'; readonly eventIndex: number; readonly notContains: readonly string[] }
  | { readonly type: 'tool_called'; readonly tool: string; readonly argsContain?: Record<string, unknown> }
  | { readonly type: 'tool_not_called'; readonly tool: string }
  | { readonly type: 'memory_tool_called'; readonly tool: string; readonly argsContain?: Record<string, unknown> }
  | { readonly type: 'llm_judge'; readonly eventIndex?: number; readonly criteria: string; readonly minScore: number };
```

## Mock Environment

The mock replaces the Newio backend, NOT the ACP agent.

### What is mocked:
- `NewioApp` — constructed with scripted identity, contacts, conversations
- MCP tool execution — tool calls are intercepted and recorded; return canned responses
- WebSocket events — not needed (events are fed directly)
- Memory API — in-memory store that records reads/writes

### What is real:
- ACP process (the actual agent binary)
- `PromptFormatterImpl` (system instruction generation)
- `EventQueue` (batching logic)
- Session lifecycle (idle timeout, context pressure simulation)

## Judge Design

Stateless LLM API call. No ACP, no sessions.

```typescript
interface JudgeInput {
  readonly scenario: string;
  readonly systemPrompt: string;
  readonly eventsDelivered: string;
  readonly agentOutput: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly criteria: string;
}

interface JudgeResult {
  readonly score: number;       // 1-5
  readonly reasoning: string;
}
```

Judge model configured via `EVAL_JUDGE_MODEL` env var (e.g., `claude-sonnet-4-20250514`).

Scoring rubric:
- 5: Perfect — meets all criteria with high quality
- 4: Good — meets criteria with minor imperfections
- 3: Acceptable — partially meets criteria
- 2: Poor — fails to meet criteria in significant ways
- 1: Fail — completely wrong or harmful

## Execution Model

- Each scenario runs N times (default: 3, configurable)
- Report: mean score, min, max, variance per scenario
- Rule-based assertions: pass rate (e.g., 3/3 passed)
- LLM-judge assertions: mean score must meet `minScore` threshold
- Full trace saved per run (events, outputs, tool calls, scores)

## CLI Interface

```bash
# Run all scenarios
pnpm --filter @newio/eval run eval

# Run a specific area
pnpm --filter @newio/eval run eval --area tool_usage

# Run a specific scenario
pnpm --filter @newio/eval run eval --scenario "dm-reply-no-double-send"

# Run with specific agent type
pnpm --filter @newio/eval run eval --agent-type claude-code

# Run with more repetitions for statistical confidence
pnpm --filter @newio/eval run eval --runs 5
```

## Configuration

```typescript
interface EvalConfig {
  /** Agent type to test (claude-code, kiro-cli, codex, etc.). */
  readonly agentType: AgentType;
  /** ACP executable config. */
  readonly acp: AcpConfig;
  /** Model to set on the ACP session (e.g., 'claude-sonnet-4-20250514', 'o3'). */
  readonly model: string;
  /** Prompt formatter version to use (e.g., '1.0.0', '2.0.0'). */
  readonly promptVersion: string;
  /** Session mode override (or 'both' to test both). */
  readonly sessionMode: 'isolated' | 'shared' | 'both';
  /** Judge model identifier. */
  readonly judgeModel: string;
  /** Judge API key env var name. */
  readonly judgeApiKeyEnvVar: string;
  /** Number of runs per scenario (default: 3). */
  readonly runsPerScenario: number;
}
```

### Multi-Axis Evaluation

Results are keyed by the tuple `(agentType, model, promptVersion, sessionMode)`. This enables three comparison modes:

| Comparison | Fixed | Varied | Purpose |
|---|---|---|---|
| Model comparison | agentType, promptVersion | model | Which model follows your instructions best? |
| Prompt comparison | agentType, model | promptVersion | Did the new prompt version improve behavior? |
| Agent comparison | model, promptVersion | agentType | Does Kiro CLI vs Claude Code behave differently? |

The runner applies `model` via `AcpSessionConfigHandler` (same mechanism the connector uses in production) and selects the prompt formatter via `PromptManager.findCompatiblePromptFormatter(promptVersion)`.

```bash
# Compare models on the same prompt
pnpm eval --agent-type claude-code --model claude-sonnet-4-20250514 --prompt-version 1.0.0
pnpm eval --agent-type claude-code --model claude-opus-4-20250514 --prompt-version 1.0.0

# Compare prompt versions on the same model
pnpm eval --agent-type claude-code --model claude-sonnet-4-20250514 --prompt-version 1.0.0
pnpm eval --agent-type claude-code --model claude-sonnet-4-20250514 --prompt-version 2.0.0

# Compare agent types with identical prompt+model
pnpm eval --agent-type claude-code --model claude-sonnet-4-20250514 --prompt-version 1.0.0
pnpm eval --agent-type kiro-cli --model claude-sonnet-4-20250514 --prompt-version 1.0.0
```

Results file naming: `results/{agentType}_{model}_{promptVersion}_{timestamp}.json`

## Directory Structure

```
packages/eval/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── DESIGN.md                    # This document
├── TASKS.md                     # Implementation task breakdown
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── config.ts                # Eval configuration
│   ├── framework/
│   │   ├── runner.ts            # Orchestrates scenario execution
│   │   ├── mock-environment.ts  # Mock NewioApp + MCP tool interceptor
│   │   ├── judge.ts             # LLM-as-judge API wrapper
│   │   ├── trace.ts            # Trace recording (events, outputs, scores)
│   │   ├── assertions.ts       # Rule-based assertion engine
│   │   └── reporter.ts         # Results formatting + summary
│   ├── scenarios/
│   │   ├── types.ts             # Scenario/expectation type definitions
│   │   ├── context-understanding/
│   │   ├── tool-usage/
│   │   ├── privacy/
│   │   ├── response-relevance/
│   │   ├── cross-session-knowledge/
│   │   ├── memory-quality/
│   │   ├── session-lifecycle/
│   │   ├── tone-and-language/
│   │   ├── contact-handling/
│   │   ├── cron-execution/
│   │   ├── instruction-following/
│   │   ├── conversation-type/
│   │   └── ambiguity/
│   └── helpers/
│       ├── fixtures.ts          # Reusable user profiles, conversations
│       └── scenario-loader.ts   # Load scenarios from files
└── results/                     # .gitignored — run outputs
```
