/**
 * Scenario runner — orchestrates a single eval scenario execution.
 *
 * Flow: setup mock env → spawn ACP agent → create session → feed events → collect traces → evaluate.
 */
import type { EvalScenario, EvalConfig, ScenarioRunResult, ScriptedEvent, ToolCallRecord } from './types.js';
import type { PromptFormatter } from '@newio/agent-engine';
import type { SessionStreamSegment } from '@newio/agent-engine';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import { ToolInterceptor } from './mock-environment.js';
import { evaluateRuleBasedExpectations } from './assertions.js';
import { ScenarioRunnerDeps } from './create-runner-deps.js';

/** Timeout for a single prompt turn (ms). */
const PROMPT_TIMEOUT_MS = 120_000;

/** Convert a scripted DM event into an IncomingMessage. */
function buildDmMessage(event: Extract<ScriptedEvent, { type: 'dm' }>, index: number): IncomingMessage {
  return {
    messageId: `msg_${index}`,
    conversationId: event.conversationId ?? `dm_${event.from.username}`,
    conversationType: 'dm',
    senderUserId: event.from.userId,
    senderUsername: event.from.username,
    senderDisplayName: event.from.displayName,
    senderAccountType: event.from.accountType,
    relationship: event.from.relationship,
    isOwnMessage: false,
    text: event.text,
    attachments: event.attachments,
    timestamp: new Date().toISOString(),
    status: 'new',
  };
}

/** Convert a scripted group message into an IncomingMessage. */
function buildGroupMessage(event: Extract<ScriptedEvent, { type: 'group_message' }>, index: number): IncomingMessage {
  return {
    messageId: `msg_${index}`,
    conversationId: event.conversation.conversationId,
    conversationType: event.conversation.type,
    groupName: event.conversation.name,
    senderUserId: event.from.userId,
    senderUsername: event.from.username,
    senderDisplayName: event.from.displayName,
    senderAccountType: event.from.accountType,
    relationship: event.from.relationship,
    isOwnMessage: false,
    text: event.text,
    timestamp: new Date().toISOString(),
    status: 'new',
  };
}

/** Convert a scripted contact event. */
function buildContactEvent(event: Extract<ScriptedEvent, { type: 'contact_event' }>): ContactEvent {
  return {
    type: event.eventType,
    username: event.from.username,
    displayName: event.from.displayName,
    accountType: event.from.accountType,
    ownerUsername: event.from.ownerUsername,
    ownerDisplayName: event.from.ownerDisplayName,
    note: event.note,
    timestamp: new Date().toISOString(),
  };
}

/** Convert a scripted cron trigger. */
function buildCronTrigger(event: Extract<ScriptedEvent, { type: 'cron_trigger' }>): CronTriggerEvent {
  return {
    cronId: event.cronId,
    label: event.label,
    payload: event.payload,
    triggeredAt: new Date().toISOString(),
  };
}

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
  // Inject memory context if provided
  if (scenario.setup.memory) {
    const memoryContext = deps.promptFormatter.formatMemoryContext(
      scenario.setup.memory as unknown as LoadSessionMemoryResponse,
      scenario.setup.handoffNote,
    );
    if (memoryContext) {
      // Send memory as first prompt turn (agent absorbs it)
      await drainGenerator(deps.session.prompt(memoryContext));
    }
  }

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

function formatEventPrompt(event: ScriptedEvent, index: number, promptFormatter: PromptFormatter): string | undefined {
  switch (event.type) {
    case 'dm':
      return promptFormatter.formatMessagePrompt([buildDmMessage(event, index)]);
    case 'group_message':
      return promptFormatter.formatMessagePrompt([buildGroupMessage(event, index)]);
    case 'contact_event':
      return promptFormatter.formatContactPrompt([buildContactEvent(event)]);
    case 'cron_trigger':
      return promptFormatter.formatCronPrompt(buildCronTrigger(event));
    case 'session_end':
      return promptFormatter.buildSessionEndPrompt();
    case 'memory_update':
      return promptFormatter.buildMemoryUpdatePrompt();
  }
}

function getConversationId(event: ScriptedEvent): string | undefined {
  switch (event.type) {
    case 'dm':
      return event.conversationId ?? `dm_${event.from.username}`;
    case 'group_message':
      return event.conversation.conversationId;
    default:
      return undefined;
  }
}

async function drainGenerator(gen: AsyncGenerator<SessionStreamSegment>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _segment of gen) {
    // consume without processing
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
