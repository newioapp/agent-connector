/**
 * Creates RunnerDeps for end-to-end eval execution.
 *
 * Wires a real AcpSessionFactory + UDS MCP server with onToolCall hook
 * that feeds into the ToolInterceptor.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { AcpSessionFactory, NewioMcpServer, PromptFormatterImpl, startUdsServer } from '@newio/agent-engine';
import type { AgentConfig, PromptFormatter, ToolCallHook } from '@newio/agent-engine';
import type { NewioApp } from '@newio/agent-sdk';
import type { Server } from 'net';
import type { EvalConfig, EvalScenario } from './types.js';
import { ToolInterceptor } from './mock-environment.js';
import { MockNewioApp } from './mock-environment.js';
import type { AgentSession } from '@newio/agent-engine';
import { TraceCollector } from './trace.js';

export interface ScenarioRunnerDeps {
  /** Tool interceptor populated by MCP server hook. Source of truth for tool call assertions. */
  readonly toolInterceptor: ToolInterceptor;

  readonly traceCollector: TraceCollector;

  readonly session: AgentSession;

  readonly promptFormatter: PromptFormatter;

  readonly setCurrentConversationId: (id: string | undefined) => void;

  /** Tear down everything (ACP process + UDS server). */
  teardown(): Promise<void>;
}

export async function createScenarioRunnerDeps(
  config: EvalConfig,
  scenario: EvalScenario,
): Promise<ScenarioRunnerDeps> {
  const socketPath = join(tmpdir(), `newio-eval-${process.pid}-${Date.now()}.sock`);
  const toolInterceptor = new ToolInterceptor();
  const traceCollector = new TraceCollector();

  const mockApp = new MockNewioApp({
    identity: {
      userId: '9c7547be-8e6e-435d-a3a5-f1e776719750',
      username: 'evalagent',
      displayName: 'Eval Agent',
      ownerId: '54ec54aa-f1dc-4d73-930e-6be51d6c5b6a',
    },
    owner: { username: 'evalowner', displayName: 'Eval Owner' },
    contacts: scenario.setup.contacts?.map((c) => ({ username: c.username, displayName: c.displayName })),
    conversations: scenario.setup.conversations?.map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
    })),
  });

  // Hook: every MCP tool call gets recorded in the interceptor
  const onToolCall: ToolCallHook = (toolName, args) => {
    toolInterceptor.record(toolName, args as Record<string, unknown>);
  };

  // Create MCP server with hook, backed by mock app
  const mcpServer = new NewioMcpServer({
    app: mockApp as unknown as NewioApp,
    initiateConversation: () => {},
    sessionMode: scenario.sessionMode,
    onToolCall,
  });

  const currentConversationId: { id: string | undefined } = {
    id: undefined,
  };
  mcpServer.setCurrentConversationIdGetter(() => {
    return currentConversationId.id;
  });

  // Start UDS server
  const udsServer: Server = startUdsServer({
    socketPath,
    onConnection: (transport) => {
      void mcpServer.connect(transport);
    },
  });

  // Build AcpSessionFactory config
  const agentConfig: AgentConfig = {
    id: 'eval-agent',
    type: config.agentType,
    sessionMode: scenario.sessionMode,
    envVars: {},
    acp: {
      cwd: config.acp.cwd,
      executablePath: config.acp.executablePath,
    },
  };

  // Build prompt manager with the requested version
  const promptFormatter = new PromptFormatterImpl(
    { username: mockApp.identity.username, displayName: mockApp.identity.displayName },
    mockApp.getOwnerInfo(),
  );

  const sessionFactory = new AcpSessionFactory(agentConfig, 'Newio Connector Eval', '0.1.0', '[eval]');

  // Init the ACP process
  await sessionFactory.init();

  const session = await sessionFactory.createSession({
    type: 'conversation',
    externalReferenceId: 'eval_session',
    promptFormatterVersion: config.promptVersion,
    skipToken: promptFormatter.skipToken,
    mcpSocketPath: socketPath,
    updateConfig: () => Promise.resolve(),
    reportContextWindow: () => Promise.resolve(),
  });

  return {
    session: session,
    promptFormatter: promptFormatter,
    toolInterceptor,
    traceCollector,
    setCurrentConversationId: (id) => {
      currentConversationId.id = id;
    },
    teardown: async () => {
      await sessionFactory.terminate();
      await new Promise<void>((resolve) => {
        udsServer.close(() => {
          resolve();
        });
      });
    },
  };
}
