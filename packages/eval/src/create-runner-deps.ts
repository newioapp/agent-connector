/**
 * Creates RunnerDeps for end-to-end eval execution.
 *
 * Wires a real AcpSessionFactory + UDS MCP server with onToolCall hook
 * that feeds into the ToolInterceptor.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import { AcpSessionFactory, NewioMcpServer, startUdsServer } from '@newio/agent-engine';
import { ExperimentalPromptFormatter } from './prompts/experimental/prompt-formatter.js';
import { ExperimentalToolDescriptions } from './mcp/experimental-tool-descriptions.js';
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
    identity: scenario.setup.agent,
    owner: scenario.setup.owner,
    contacts: scenario.setup.contacts?.map((c) => ({ username: c.username, displayName: c.displayName })),
    conversations: scenario.setup.conversations?.map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
    })),
    memoryStore: scenario.setup.memoryStore,
  });

  // Hook: every MCP tool call gets recorded in the interceptor
  const onToolCall: ToolCallHook = (toolName, args) => {
    toolInterceptor.record(toolName, args as Record<string, unknown>);
  };

  // Resolve effective session mode (scenario may declare 'both', config has the resolved mode)
  const effectiveSessionMode = scenario.sessionMode === 'both' ? config.sessionMode : scenario.sessionMode;
  if (effectiveSessionMode === 'both') {
    throw new Error('effectiveSessionMode must be resolved to isolated or shared before creating deps');
  }

  // Create MCP server with hook, backed by mock app
  const mcpServer = new NewioMcpServer({
    app: mockApp as unknown as NewioApp,
    initiateConversation: () => {},
    sessionMode: effectiveSessionMode,
    onToolCall,
    toolDescriptions: new ExperimentalToolDescriptions(),
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
    sessionMode: effectiveSessionMode,
    envVars: loadEnvFile(),
    acp: {
      cwd: config.acp.cwd,
      executablePath: config.acp.executablePath,
      kiroCliTrustAllTools: true,
    },
  };

  const mcpBridgePath = fileURLToPath(import.meta.resolve('@newio/agent-engine/mcp-bridge'));

  // Build prompt manager with the requested version
  const promptFormatter = new ExperimentalPromptFormatter(
    { username: mockApp.identity.username, displayName: mockApp.identity.displayName },
    mockApp.getOwnerInfo(),
    effectiveSessionMode,
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
    mcpBridgePath,
    updateConfig: () => Promise.resolve(),
    reportContextWindow: () => Promise.resolve(),
  });

  await session.applySessionConfig({ acpModel: config.model });

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

/** Load environment variables from packages/eval/.env.agent file. Falls back to process.env if not found. */
function loadEnvFile(): Record<string, string> {
  const envPath = join(fileURLToPath(import.meta.url), '../../.env.agent');
  try {
    const content = readFileSync(envPath, 'utf-8');
    return parseDotenv(content);
  } catch {
    return { ...process.env } as Record<string, string>;
  }
}
