# Agent Evaluation Framework — Task Breakdown

## Phase 1: Foundation (framework + first deterministic evals)

### E1. Package scaffolding
- Create `packages/eval/package.json` (deps: `@newio/agent-engine`, `@anthropic-ai/sdk`, `vitest`, `yaml`, `commander`)
- `tsconfig.json`, `tsup.config.ts`
- Add to pnpm workspace
- Verify `pnpm build` works

### E2. Scenario type definitions
- Define `EvalScenario`, `ScriptedEvent`, `Expectation`, `ScenarioSetup` interfaces in `src/scenarios/types.ts`
- Define `UserProfile`, `ConversationSetup`, `ContactSetup` fixture types
- Define `EvalArea` string union for the 13 areas

### E3. Mock environment — core
- `MockNewioApp`: implements enough of `NewioApp` to satisfy `PromptFormatterImpl` (identity, owner info, contacts, conversations)
- `ToolInterceptor`: wraps MCP tool registrations, records all calls (tool name, args, timestamp), returns configurable canned responses
- `MockMemoryStore`: in-memory implementation of memory read/write (records operations for assertions)

### E4. Trace collector
- `TraceRecorder`: captures per-event data — prompt sent, raw agent output, tool calls made, `_skip` detection
- Serializable to JSON for post-run analysis
- Includes timing (latency per prompt)

### E5. Rule-based assertion engine
- Implement assertion evaluators for each `Expectation` type:
  - `skip` / `no_skip` — check if agent output matches `_skip`
  - `response_contains` / `response_not_contains` — substring checks
  - `tool_called` / `tool_not_called` — check trace for tool invocations
  - `memory_tool_called` — check memory-specific tool calls
- Return pass/fail + reason per assertion

### E6. Scenario runner — single run
- `runScenario(scenario, config)`: sets up mock env → creates agent instance (real ACP) → feeds events sequentially → collects trace → evaluates assertions → returns results
- Handles session startup/teardown
- Timeout handling (kill agent if it takes too long per event)

### E7. First scenarios — Tool Usage (Area 2) & Skip Behavior (Area 4)
- 3-4 scenarios for tool usage:
  - Agent asked to message someone else → uses correct tool
  - Agent responds to DM → does NOT use messaging tools (auto-delivered)
  - Isolated mode: agent uses `initiate_conversation`, not `send_dm`
- 3-4 scenarios for skip behavior:
  - Group message not @mentioning agent → `_skip`
  - Group message @mentioning agent → responds
  - DM → always responds
  - Work Session → proactive response

### E8. CLI entry point (basic)
- `src/index.ts` with `commander`: `--area`, `--scenario`, `--agent-type`, `--runs`
- Loads scenarios, runs them, prints summary table to stdout
- Exit code 1 if any assertion fails below threshold

---

## Phase 2: LLM-as-Judge + Subjective Evals

### E9. Judge implementation
- `src/framework/judge.ts`: direct Anthropic API call (or OpenAI, configurable)
- Takes `JudgeInput` (scenario description, agent output, tool calls, criteria)
- Returns `JudgeResult` (score 1-5, reasoning)
- Retry logic (rate limits), timeout, error handling
- `EVAL_JUDGE_MODEL` env var configuration

### E10. Reporter with scoring
- Summary table: scenario name, area, pass rate (rule-based), mean judge score, min/max
- Per-area aggregate scores
- JSON output for tracking over time
- Highlight regressions (compare against previous results if available)

### E11. Scenarios — Privacy (Area 3)
- Stranger asks about owner's schedule → refuses
- Stranger asks agent to forward a message to owner → reasonable response without leaking info
- Contact asks a borderline question → balanced response

### E12. Scenarios — Tone & Language (Area 8)
- Owner gets priority treatment vs. stranger gets professional distance
- English user → English response
- Chinese user → Chinese response
- Shared mode: consecutive messages in different languages → no bleed
- Ambiguous message, no prior history → English fallback

### E13. Scenarios — Context Understanding (Area 1)
- Information shared in group, recalled in DM
- Shared mode: cross-conversation reference
- Isolated mode: same test but with memory pre-loaded vs. without (measure delta)

---

## Phase 3: Memory & Session Lifecycle Evals

### E14. Scenarios — Memory Quality (Area 6)
- Session-end prompt → agent writes useful facts (not garbage)
- Agent does NOT store transient chatter
- Agent does NOT duplicate existing facts
- Summary updates are concise and meaningful

### E15. Scenarios — Session Lifecycle (Area 7)
- Agent produces coherent handoff note at session end
- New session with handoff + memory resumes coherently
- Agent distinguishes lifecycle prompts from user messages

### E16. Scenarios — Cross-Session Knowledge (Area 5)
- Learn fact in session 1, verify recall in session 2 (via pre-loaded memory)
- Agent uses `get_memory` for unfamiliar participants
- Handoff note captures work-in-progress (not durable facts)

---

## Phase 4: Remaining Areas

### E17. Scenarios — Contact Event Handling (Area 9)
- Friend request from stranger → agent makes decision via tools, outputs `_skip`
- Contact acceptance → agent acknowledges via `dm_owner` or `initiate_conversation`
- Agent never sends text reply for contact events

### E18. Scenarios — Cron Execution (Area 10)
- Cron fires with label "send standup reminder" → agent sends to correct conversation
- Agent outputs `_skip` for cron events
- Agent handles payload correctly

### E19. Scenarios — Instruction Following (Area 11)
- Isolated mode: agent does NOT call `send_dm` (tool not registered)
- Agent does not hallucinate tool names
- Agent does not double-send (reply + tool call to same conversation)

### E20. Scenarios — Conversation Type Discrimination (Area 12)
- Group: only responds when relevant
- DM: always responds
- Work Session: proactive

### E21. Scenarios — Ambiguity (Area 13)
- Conflicting information from two users
- Unclear request → asks for clarification
- Question agent cannot answer → says "I don't know"

---

## Phase 5: CI Integration & Regression Tracking

### E22. Results persistence
- Save results to `results/` as timestamped JSON
- Schema: `{ runId, timestamp, agentType, scenarios: [...], aggregates: {...} }`
- `.gitignore` results directory

### E23. Regression detection
- Compare current run against baseline (stored in `results/baseline.json`)
- Flag if any area's mean score drops by >0.5
- Flag if any rule-based assertion pass rate drops

### E24. CI workflow
- GitHub Actions workflow: runs on prompt changes (`prompt-formatter.ts`, MCP tool files)
- Nightly full run against all areas
- PR check: runs subset of fast/deterministic evals (Phase 1 scenarios only)

---

## Priority Order

For maximum value with minimum effort:

1. **Phase 1** (E1-E8) — Gets you running. Tool usage and skip behavior are the most deterministic and cheapest to test. You'll immediately find bugs in your prompts.

2. **Phase 2** (E9-E13) — Adds the judge. Privacy and language evals will validate the most user-facing behaviors.

3. **Phase 3** (E14-E16) — Memory is the hardest to get right and compounds over time. These evals prevent silent memory quality degradation.

4. **Phase 4** (E17-E21) — Fills out coverage. Lower priority because these behaviors are simpler and less likely to regress.

5. **Phase 5** (E22-E24) — Automation. Only valuable once you have enough scenarios to make regression tracking meaningful.

---

## Estimated Effort

| Phase | Tasks | Effort |
|-------|-------|--------|
| Phase 1 | E1-E8 | 3-4 days |
| Phase 2 | E9-E13 | 2-3 days |
| Phase 3 | E14-E16 | 2 days |
| Phase 4 | E17-E21 | 2-3 days |
| Phase 5 | E22-E24 | 1-2 days |

Total: ~10-14 days for full coverage.
