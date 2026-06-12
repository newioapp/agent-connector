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
import { AcpSessionFactory, startUdsServer } from '@newio/agent-engine';
import { getLogger } from '@newio/agent-sdk';
import { PromptFormatterImpl } from '@newio/agent-engine';
import { NewioEvalMcpServer } from '../mcp/v1/server.js';
import { OverridablePromptFormatter } from '../prompts/overridable-prompt-formatter.js';
import { MockBackend } from '../mock-backend.js';
import { MockNewioApp } from '../mock-newio-app.js';
import { ToolInterceptor } from './tool-interceptor.js';
import { buildScenarioData } from './build-scenario-data.js';
import { TraceCollector } from './trace.js';
import type { AgentConfig, PromptFormatter, ToolCallHook, NewioAppForMcp } from '@newio/agent-engine';
import type { Server } from 'net';
import type { EvalConfig, EvalScenario } from '../types.js';
import type { AgentSession } from '@newio/agent-engine';

const log = getLogger('static-runner');

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

  // Build MockBackend from scenario setup
  const backend = new MockBackend();
  backend.loadFrom(buildScenarioData(scenario.setup));

  const mockApp = new MockNewioApp({
    backend,
    userId: scenario.setup.agent.userId,
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
  const mcpServer = new NewioEvalMcpServer({
    app: mockApp as unknown as NewioAppForMcp,
    initiateConversation: () => {},
    // Static harness drives a single bare session (no session manager), so
    // cross-session delegation is a no-op here — same as initiateConversation.
    shareContext: () => {},
    sessionMode: effectiveSessionMode,
    onToolCall,
  });

  const currentConversationId: { id: string | undefined } = { id: undefined };
  mcpServer.setCurrentConversationIdGetter(() => currentConversationId.id);

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

  // Eval is an in-workspace consumer, so it can run the engine's bridge file
  // directly (the engine is always installed here, unlike the published CLI).
  const mcpBridgePath = fileURLToPath(import.meta.resolve('@newio/agent-engine/mcp-bridge'));
  const mcpBridgeCommand = process.execPath;
  const mcpBridgeArgsPrefix = [mcpBridgePath];

  // Build prompt formatter
  const promptFormatter = new OverridablePromptFormatter(
    new PromptFormatterImpl(
      { username: mockApp.identity.username, displayName: mockApp.identity.displayName ?? mockApp.identity.username },
      mockApp.getOwnerInfo(),
      effectiveSessionMode,
    ),
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
    mcpBridgeCommand,
    mcpBridgeArgsPrefix,
    updateConfig: () => Promise.resolve(),
    reportContextWindow: () => Promise.resolve(),
  });

  // Always approve permission requests (pick best "allow" option)
  session.onPermissionRequest((title, options) => {
    const allow =
      options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
    log.info(`[eval] Auto-approving permission request: "${title}" with option: ${allow?.optionId ?? 'allow'}`);
    return Promise.resolve(allow?.optionId ?? 'allow');
  });

  await session.applySessionConfig({ acpModel: config.model });

  return {
    session,
    promptFormatter,
    toolInterceptor,
    traceCollector,
    setCurrentConversationId: (id) => {
      currentConversationId.id = id;
    },
    teardown: async () => {
      mockApp.dispose();
      await sessionFactory.terminate();
      await new Promise<void>((resolve) => {
        udsServer.close(() => resolve());
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
