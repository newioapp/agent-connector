/**
 * Scenario runner — orchestrates a single eval scenario execution.
 *
 * Flow: setup mock env → spawn ACP agent → create session → feed events → collect traces → evaluate.
 */
import type { EvalScenario, EvalConfig, ScenarioRunResult, ScriptedEvent, ToolCallRecord } from './types.js';
import type { PromptFormatter } from '@newio/agent-engine';
import type { SessionStreamSegment } from '@newio/agent-engine';
import { ToolInterceptor } from './mock-environment.js';
import { evaluateRuleBasedExpectations } from './assertions.js';
import { ScenarioRunnerDeps } from './create-runner-deps.js';

/** Timeout for a single prompt turn (ms). */
const PROMPT_TIMEOUT_MS = 120_000;

/** Collect all agent message chunks from a session prompt generator. */
async function collectOutput(
  gen: AsyncGenerator<SessionStreamSegment>,
  toolInterceptor: ToolInterceptor,
): Promise<{ text: string; toolCalls: readonly ToolCallRecord[] }> {
  const startIdx = toolInterceptor.count;
  const parts: string[] = [];

  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk') {
      parts.push(segment.text);
    } else if (segment.type === 'tool_call') {
      // Tool calls are captured by the interceptor via MCP server hooks.
      // We also record them here for trace completeness.
      toolInterceptor.record(segment.toolCallId ?? 'unknown_tool', { text: segment.text }, segment.toolCallStatus);
    }
  }

  const text = parts.join('').trim();
  const toolCalls = toolInterceptor.getSince(startIdx);
  return { text, toolCalls };
}

/**
 * Run a single scenario once. Returns the result including traces and assertion outcomes.
 */
export async function runScenario(
  scenario: EvalScenario,
  config: EvalConfig,
  deps: ScenarioRunnerDeps,
  runIndex: number,
): Promise<ScenarioRunResult> {
  // Inject system instruction + memory context (mirrors provideContext in IsolatedSessionAgentInstance)
  const instruction = deps.promptFormatter.buildNewioInstruction();
  const memoryContext = scenario.setup.initialMemory
    ? deps.promptFormatter.formatMemoryContext(scenario.setup.initialMemory, scenario.setup.initialHandoffNote)
    : undefined;
  const fullInstruction = memoryContext ? `${instruction.prompt}\n\n${memoryContext}` : instruction.prompt;

  const initStart = Date.now();
  const initResult = await withTimeout(
    collectOutput(deps.session.prompt(fullInstruction), deps.toolInterceptor),
    PROMPT_TIMEOUT_MS,
    'Initialization prompt timed out',
  );
  deps.traceCollector.record({
    eventIndex: -1,
    event: { type: 'initialization' },
    promptSent: fullInstruction,
    agentOutput: initResult.text,
    isSkip: false,
    toolCalls: initResult.toolCalls,
    latencyMs: Date.now() - initStart,
  });

  // Process each scripted event
  for (let i = 0; i < scenario.events.length; i++) {
    const event = scenario.events[i];
    if (!event) {
      continue;
    }
    const startTime = Date.now();

    const promptText = formatEventPrompt(event, i, deps.promptFormatter);
    if (!promptText) {
      continue;
    }

    const conversationId = getConversationId(event);
    deps.setCurrentConversationId(conversationId);
    let agentOutput: string;
    let toolCalls: readonly ToolCallRecord[];
    try {
      const gen = deps.session.prompt(promptText, conversationId);
      const result = await withTimeout(
        collectOutput(gen, deps.toolInterceptor),
        PROMPT_TIMEOUT_MS,
        `Prompt timed out after ${PROMPT_TIMEOUT_MS}ms for event ${i}`,
      );
      agentOutput = result.text;
      toolCalls = result.toolCalls;
    } finally {
      deps.setCurrentConversationId(undefined);
    }

    const isSkip = deps.promptFormatter.isSkip(agentOutput);
    const latencyMs = Date.now() - startTime;

    deps.traceCollector.record({
      eventIndex: i,
      event,
      promptSent: promptText,
      agentOutput,
      isSkip,
      toolCalls,
      latencyMs,
    });
  }

  // Evaluate assertions
  const traces = deps.traceCollector.getAll();
  const allToolCalls = deps.toolInterceptor.getAll();
  const assertions = evaluateRuleBasedExpectations(scenario.expectations, traces, allToolCalls);
  const passed = assertions.every((a) => a.passed);

  return {
    scenarioId: scenario.id,
    runIndex,
    agentType: config.agentType,
    model: config.model,
    promptVersion: config.promptVersion,
    sessionMode: scenario.sessionMode,
    traces,
    assertions,
    passed,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventPrompt(event: ScriptedEvent, _index: number, promptFormatter: PromptFormatter): string | undefined {
  switch (event.type) {
    case 'message':
      return promptFormatter.formatMessagePrompt(event.messages);
    case 'contact':
      return promptFormatter.formatContactPrompt(event.events);
    case 'cron':
      return promptFormatter.formatCronPrompt(event.event);
    case 'session_end':
      return promptFormatter.buildSessionEndPrompt();
    case 'memory_update':
      return promptFormatter.buildMemoryUpdatePrompt();
  }
}

function getConversationId(event: ScriptedEvent): string | undefined {
  switch (event.type) {
    case 'message':
      return event.messages[0]?.conversationId;
    default:
      return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
