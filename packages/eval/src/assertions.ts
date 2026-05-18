/**
 * Rule-based assertion engine — evaluates deterministic expectations against traces.
 */
import type { Expectation, AssertionResult, EventTrace, ToolCallRecord } from './types.js';

/** Evaluate a single expectation against collected traces. */
export function evaluateExpectation(
  expectation: Expectation,
  traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
): AssertionResult {
  const severity = expectation.severity ?? 'error';
  let result: Omit<AssertionResult, 'severity'>;
  switch (expectation.type) {
    case 'skip':
      result = evaluateSkip(expectation, traces);
      break;
    case 'no_skip':
      result = evaluateNoSkip(expectation, traces);
      break;
    case 'response_contains':
      result = evaluateResponseContains(expectation, traces);
      break;
    case 'response_not_contains':
      result = evaluateResponseNotContains(expectation, traces);
      break;
    case 'tool_called':
      result = evaluateToolCalled(expectation, traces, allToolCalls);
      break;
    case 'tool_not_called':
      result = evaluateToolNotCalled(expectation, traces, allToolCalls);
      break;
    case 'llm_judge':
      result = { expectation, passed: true, reason: 'Deferred to LLM judge' };
      break;
  }
  return { ...result, severity };
}

/** Evaluate all non-judge expectations. Returns results array. */
export function evaluateRuleBasedExpectations(
  expectations: readonly Expectation[],
  traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
): readonly AssertionResult[] {
  return expectations.filter((e) => e.type !== 'llm_judge').map((e) => evaluateExpectation(e, traces, allToolCalls));
}

// ---------------------------------------------------------------------------
// Individual evaluators
// ---------------------------------------------------------------------------

type PartialResult = Omit<AssertionResult, 'severity'>;

function evaluateSkip(
  expectation: Extract<Expectation, { type: 'skip' }>,
  traces: readonly EventTrace[],
): PartialResult {
  const trace = resolveTrace(expectation.eventIndex, traces);
  if (!trace) {
    return { expectation, passed: false, reason: `No trace found for event index ${expectation.eventIndex ?? 'last'}` };
  }
  if (trace.isSkip) {
    return { expectation, passed: true, reason: 'Agent correctly output _skip' };
  }
  return { expectation, passed: false, reason: `Expected _skip but got: "${truncate(trace.agentOutput)}"` };
}

function evaluateNoSkip(
  expectation: Extract<Expectation, { type: 'no_skip' }>,
  traces: readonly EventTrace[],
): PartialResult {
  const trace = resolveTrace(expectation.eventIndex, traces);
  if (!trace) {
    return { expectation, passed: false, reason: `No trace found for event index ${expectation.eventIndex ?? 'last'}` };
  }
  if (!trace.isSkip) {
    return { expectation, passed: true, reason: 'Agent responded (did not skip)' };
  }
  return { expectation, passed: false, reason: 'Expected a response but agent output _skip' };
}

function evaluateResponseContains(
  expectation: Extract<Expectation, { type: 'response_contains' }>,
  traces: readonly EventTrace[],
): PartialResult {
  const trace = resolveTrace(expectation.eventIndex, traces);
  if (!trace) {
    return { expectation, passed: false, reason: `No trace found for event index ${expectation.eventIndex}` };
  }
  const output = trace.agentOutput.toLowerCase();
  const missing = expectation.contains.filter((s) => !output.includes(s.toLowerCase()));
  if (missing.length === 0) {
    return { expectation, passed: true, reason: 'Response contains all expected strings' };
  }
  return { expectation, passed: false, reason: `Response missing: ${missing.map((s) => `"${s}"`).join(', ')}` };
}

function evaluateResponseNotContains(
  expectation: Extract<Expectation, { type: 'response_not_contains' }>,
  traces: readonly EventTrace[],
): PartialResult {
  const trace = resolveTrace(expectation.eventIndex, traces);
  if (!trace) {
    return { expectation, passed: false, reason: `No trace found for event index ${expectation.eventIndex}` };
  }
  const output = trace.agentOutput.toLowerCase();
  const found = expectation.notContains.filter((s) => output.includes(s.toLowerCase()));
  if (found.length === 0) {
    return { expectation, passed: true, reason: 'Response does not contain any forbidden strings' };
  }
  return {
    expectation,
    passed: false,
    reason: `Response unexpectedly contains: ${found.map((s) => `"${s}"`).join(', ')}`,
  };
}

function evaluateToolCalled(
  expectation: Extract<Expectation, { type: 'tool_called' }>,
  _traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
): PartialResult {
  const calls =
    expectation.eventIndex !== undefined
      ? allToolCalls.filter((c) => c.eventIndex === expectation.eventIndex)
      : allToolCalls;

  const matching = calls.filter((c) => c.tool === expectation.tool);
  if (matching.length === 0) {
    return { expectation, passed: false, reason: `Tool "${expectation.tool}" was never called` };
  }

  if (expectation.argsContain) {
    const expected = expectation.argsContain;
    const hasMatch = matching.some((c) => argsMatch(c.args, expected));
    if (!hasMatch) {
      return { expectation, passed: false, reason: `Tool "${expectation.tool}" called but args don't match expected` };
    }
  }

  return { expectation, passed: true, reason: `Tool "${expectation.tool}" was called with expected args` };
}

function evaluateToolNotCalled(
  expectation: Extract<Expectation, { type: 'tool_not_called' }>,
  _traces: readonly EventTrace[],
  allToolCalls: readonly ToolCallRecord[],
): PartialResult {
  const calls =
    expectation.eventIndex !== undefined
      ? allToolCalls.filter((c) => c.eventIndex === expectation.eventIndex)
      : allToolCalls;

  const matching = calls.filter((c) => c.tool === expectation.tool);
  if (matching.length === 0) {
    return { expectation, passed: true, reason: `Tool "${expectation.tool}" was correctly not called` };
  }
  return {
    expectation,
    passed: false,
    reason: `Tool "${expectation.tool}" was called ${matching.length} time(s) but should not have been`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTrace(eventIndex: number | undefined, traces: readonly EventTrace[]): EventTrace | undefined {
  if (eventIndex !== undefined) {
    return traces.find((t) => t.eventIndex === eventIndex);
  }
  return traces[traces.length - 1];
}

function argsMatch(actual: Readonly<Record<string, unknown>>, expected: Readonly<Record<string, unknown>>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    const actualVal = actual[key];
    if (typeof value === 'string' && typeof actualVal === 'string') {
      if (!actualVal.toLowerCase().includes(value.toLowerCase())) {
        return false;
      }
    } else if (JSON.stringify(actualVal) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
}

function truncate(text: string, maxLen = 80): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + '...';
}
