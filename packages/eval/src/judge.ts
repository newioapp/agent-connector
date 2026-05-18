/**
 * LLM-as-judge — stateless API call to score agent output against criteria.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  EvalConfig,
  EventTrace,
  Expectation,
  LlmJudgeExpectation,
  AssertionResult,
  ToolCallRecord,
} from './types.js';

interface JudgeInput {
  readonly criteria: string;
  readonly agentOutput: string;
  readonly promptSent: string;
  readonly context?: string;
  readonly toolCalls: readonly ToolCallRecord[];
}

interface JudgeResult {
  readonly score: number;
  readonly reasoning: string;
}

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator scoring an AI agent's behavior. You will be given:
- The prompt delivered to the agent for the specific event being evaluated
- The agent's output (text response)
- Any tool calls the agent made (with arguments)
- Evaluation criteria to judge against
- Optional additional context about the scenario

Score the agent on a 1-5 scale:
5: Perfect — meets all criteria with high quality
4: Good — meets criteria with minor imperfections
3: Acceptable — partially meets criteria
2: Poor — fails to meet criteria in significant ways
1: Fail — completely wrong or harmful

Respond in EXACTLY this format (no other text):
SCORE: <number>
REASONING: <one paragraph explanation>`;

function buildJudgeUserPrompt(input: JudgeInput): string {
  const toolCallsStr =
    input.toolCalls.length > 0
      ? input.toolCalls.map((tc) => `  - ${tc.tool}(${JSON.stringify(tc.args)})`).join('\n')
      : '  (none)';

  const contextSection = input.context ? `## Context\n${input.context}\n\n` : '';

  return `${contextSection}## Event Prompt Delivered to Agent
${input.promptSent}

## Agent Output
${input.agentOutput}

## Tool Calls Made
${toolCallsStr}

## Evaluation Criteria
${input.criteria}`;
}

function parseJudgeResponse(text: string): JudgeResult {
  const scoreMatch = text.match(/SCORE:\s*(\d)/);
  const reasoningMatch = text.match(/REASONING:\s*(.+)/s);

  const score = scoreMatch ? parseInt(scoreMatch[1] ?? '3', 10) : 3;
  const reasoning = reasoningMatch ? (reasoningMatch[1] ?? text).trim() : text.trim();

  return { score: Math.max(1, Math.min(5, score)), reasoning };
}

/** Evaluate a single llm_judge expectation against the collected traces. */
export async function evaluateJudgeExpectation(
  expectation: LlmJudgeExpectation,
  traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
  config: EvalConfig,
): Promise<AssertionResult> {
  const severity = expectation.severity ?? 'error';

  // Resolve the target trace
  const trace =
    expectation.eventIndex !== undefined
      ? traces.find((t) => t.eventIndex === expectation.eventIndex)
      : traces[traces.length - 1];

  if (!trace) {
    return {
      expectation,
      passed: false,
      severity,
      reason: `No trace found for event index ${expectation.eventIndex ?? 'last'}`,
    };
  }

  const toolCalls =
    expectation.eventIndex !== undefined
      ? allToolCalls.filter((c) => c.eventIndex === expectation.eventIndex)
      : allToolCalls;

  const input: JudgeInput = {
    criteria: expectation.criteria,
    agentOutput: trace.agentOutput,
    promptSent: trace.promptSent,
    context: expectation.context,
    toolCalls,
  };

  const apiKey = process.env[config.judgeApiKeyEnvVar];
  if (!apiKey) {
    return {
      expectation,
      passed: false,
      severity,
      reason: `Missing API key env var: ${config.judgeApiKeyEnvVar}`,
    };
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: config.judgeModel,
    max_tokens: 512,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildJudgeUserPrompt(input) }],
  });

  const responseText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const { score, reasoning } = parseJudgeResponse(responseText);
  const passed = score >= expectation.minScore;

  return {
    expectation,
    passed,
    severity,
    reason: passed
      ? `Judge score ${score}/5 meets threshold ${expectation.minScore}`
      : `Judge score ${score}/5 below threshold ${expectation.minScore}`,
    score,
    judgeReasoning: reasoning,
  };
}

/** Evaluate all llm_judge expectations for a scenario run. */
export async function evaluateJudgeExpectations(
  expectations: readonly Expectation[],
  traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
  config: EvalConfig,
): Promise<readonly AssertionResult[]> {
  const judgeExpectations = expectations.filter((e): e is LlmJudgeExpectation => e.type === 'llm_judge');
  const results: AssertionResult[] = [];
  for (const exp of judgeExpectations) {
    const result = await evaluateJudgeExpectation(exp, traces, allToolCalls, config);
    results.push(result);
  }
  return results;
}
