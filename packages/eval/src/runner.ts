/**
 * Scenario runner — orchestrates a single eval scenario execution.
 *
 * Flow: setup mock env → spawn ACP agent → create session → feed events → collect traces → evaluate.
 */
import type { EvalScenario, EvalConfig, ScenarioRunResult, ScriptedEvent, ToolCallRecord } from './types.js';
import type { SessionMode } from '@newio/agent-engine';
import { PromptFormatterImpl, PromptManager } from '@newio/agent-engine';
import type { AgentSession, SessionStreamSegment } from '@newio/agent-engine';
import type { IncomingMessage, ContactEvent, CronTriggerEvent, LoadSessionMemoryResponse } from '@newio/agent-sdk';
import { MockNewioApp, ToolInterceptor } from './mock-environment.js';
import { TraceCollector } from './trace.js';
import { evaluateRuleBasedExpectations } from './assertions.js';

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

export interface RunnerDeps {
  /** Factory for creating ACP sessions. Caller manages lifecycle. */
  readonly sessionFactory: {
    init(): Promise<void>;
    createSession(input: {
      type: 'conversation' | 'contact' | 'cron';
      externalReferenceId: string;
      promptFormatterVersion: string;
      mcpSocketPath: string;
      skipToken: string;
    }): Promise<AgentSession>;
    endSession(correlationId: string): Promise<void>;
    terminate(): Promise<void>;
  };
  readonly mcpSocketPath: string;
}

/**
 * Run a single scenario once. Returns the result including traces and assertion outcomes.
 */
export async function runScenario(
  scenario: EvalScenario,
  config: EvalConfig,
  deps: RunnerDeps,
  runIndex: number,
): Promise<ScenarioRunResult> {
  const sessionMode: SessionMode = scenario.sessionMode === 'both' ? 'isolated' : scenario.sessionMode;

  // Build mock app for prompt formatting
  const mockApp = new MockNewioApp({
    identity: { userId: 'agent_eval', username: 'eval_agent', displayName: 'Eval Agent', ownerId: 'owner_eval' },
    owner: { username: 'eval_owner', displayName: 'Eval Owner' },
    contacts: scenario.setup.contacts?.map((c) => ({ username: c.username, displayName: c.displayName })),
    conversations: scenario.setup.conversations?.map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
    })),
  });

  // Build prompt manager with the requested version
  const formatter = new PromptFormatterImpl(mockApp as never);
  const promptManager = new PromptManager([formatter], formatter);

  const toolInterceptor = new ToolInterceptor();
  const traceCollector = new TraceCollector();

  // Create session
  const session = await deps.sessionFactory.createSession({
    type: 'conversation',
    externalReferenceId: 'eval_session',
    promptFormatterVersion: config.promptVersion,
    mcpSocketPath: deps.mcpSocketPath,
    skipToken: promptManager.skipToken(config.promptVersion),
  });

  // Inject memory context if provided
  if (scenario.setup.memory) {
    const memoryContext = promptManager.formatMemoryContext(
      config.promptVersion,
      scenario.setup.memory as unknown as LoadSessionMemoryResponse,
      scenario.setup.handoffNote,
    );
    if (memoryContext) {
      // Send memory as first prompt turn (agent absorbs it)
      await drainGenerator(session.prompt(memoryContext));
    }
  }

  // Process each scripted event
  for (let i = 0; i < scenario.events.length; i++) {
    const event = scenario.events[i];
    if (!event) {
      continue;
    }
    const startTime = Date.now();

    const promptText = formatEventPrompt(event, i, promptManager, config.promptVersion);
    if (!promptText) {
      continue;
    }

    const conversationId = getConversationId(event);
    const gen = session.prompt(promptText, conversationId);

    // Wrap with timeout
    const { text: agentOutput, toolCalls } = await withTimeout(
      collectOutput(gen, toolInterceptor),
      PROMPT_TIMEOUT_MS,
      `Prompt timed out after ${PROMPT_TIMEOUT_MS}ms for event ${i}`,
    );

    const isSkip = promptManager.isSkip(config.promptVersion, agentOutput);
    const latencyMs = Date.now() - startTime;

    traceCollector.record({ eventIndex: i, event, promptSent: promptText, agentOutput, isSkip, toolCalls, latencyMs });
  }

  // Evaluate assertions
  const traces = traceCollector.getAll();
  const allToolCalls = toolInterceptor.getAll();
  const assertions = evaluateRuleBasedExpectations(scenario.expectations, traces, allToolCalls);
  const passed = assertions.every((a) => a.passed);

  // Clean up session
  await deps.sessionFactory.endSession(session.correlationId);

  return {
    scenarioId: scenario.id,
    runIndex,
    agentType: config.agentType,
    model: config.model,
    promptVersion: config.promptVersion,
    sessionMode,
    traces,
    assertions,
    passed,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventPrompt(
  event: ScriptedEvent,
  index: number,
  promptManager: PromptManager,
  version: string,
): string | undefined {
  switch (event.type) {
    case 'dm':
      return promptManager.formatMessagePrompt(version, [buildDmMessage(event, index)]);
    case 'group_message':
      return promptManager.formatMessagePrompt(version, [buildGroupMessage(event, index)]);
    case 'contact_event':
      return promptManager.formatContactPrompt(version, [buildContactEvent(event)]);
    case 'cron_trigger':
      return promptManager.formatCronPrompt(version, buildCronTrigger(event));
    case 'session_end':
      return promptManager.buildSessionEndPrompt(version);
    case 'memory_update':
      return promptManager.buildMemoryUpdatePrompt(version);
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
