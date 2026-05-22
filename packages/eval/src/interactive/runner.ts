/**
 * Interactive eval runner — spawns driver + target agents,
 * wires MCP servers to shared mock, and collects trace.
 *
 * The TARGET agent uses BaseAgentInstance (with a subclass providing the mock app),
 * giving it the full session orchestration (IsolatedSessionManager/SharedSessionManager).
 *
 * The DRIVER agent is a separate ACP session with the Driver MCP server.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import {
  AcpSessionFactory,
  startUdsServer,
  BaseAgentInstance,
  PromptManager,
  NewioMcpServer,
} from '@newio/agent-engine';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AgentConfig,
  AgentType,
  SessionStreamSegment,
  NewioAppForAgent,
  SessionMode,
  EngineConfig,
} from '@newio/agent-engine';
import type { NewioMcpServerInterface } from '@newio/agent-engine';
import type { AgentInstanceListener } from '@newio/agent-engine';
import type { Server } from 'net';
import { InteractiveMockNewioApp } from './mock-app.js';
import { DriverMcpServer } from './driver-mcp-server.js';
import { judgeTrace } from './judge.js';
import type { InteractiveScenario, TurnRecord, BattleReport, TargetMessage } from './types.js';
import { EvalPromptFormatter } from '../prompts/v1/prompt-formatter.js';

export interface InteractiveEvalConfig {
  readonly targetAgentType: string;
  readonly targetModel: string;
  readonly driverAgentType: string;
  readonly driverModel: string;
  readonly sessionMode: 'isolated' | 'shared';
  readonly promptVersion: string;
  readonly acp: {
    readonly cwd: string;
    readonly executablePath?: string;
  };
  readonly judgeModel?: string;
  readonly timeoutMs?: number;
}

/** Collect full agent text from a session prompt generator. */
async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk' && segment.text) {
      parts.push(segment.text);
    }
  }
  const text = parts.join('').trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// EvalAgentInstance — subclass of BaseAgentInstance for the eval target
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/require-await */
class EvalAgentInstance extends BaseAgentInstance {
  constructor(
    config: AgentConfig,
    private readonly mockApp: InteractiveMockNewioApp,
    private readonly sessionMode: SessionMode,
    listener: AgentInstanceListener,
    engineConfig: EngineConfig,
  ) {
    const noopConfigManager = {
      getTokens: () => undefined,
      setTokens: () => {},
      setNewioIdentity: () => {},
    } as never;
    const noopCronStore = {
      saveCron: () => {},
      deleteCron: () => {},
      listCrons: () => [],
    } as never;
    super(config, noopConfigManager, noopCronStore, listener, engineConfig);
  }

  async createNewioApp(): Promise<NewioAppForAgent> {
    return this.mockApp;
  }

  async createPromptManager(): Promise<PromptManager> {
    const formatter = new EvalPromptFormatter(
      { username: this.mockApp.identity.username, displayName: this.mockApp.identity.displayName },
      this.mockApp.getOwnerInfo(),
      this.sessionMode,
    );
    return new PromptManager([formatter], formatter);
  }

  createMcpServer(): NewioMcpServerInterface {
    return new NewioMcpServer({
      app: this.mockApp,
      initiateConversation: (convId, context) => {
        if (!this.abortController.signal.aborted) {
          this.inbound.push({ type: 'initiate_conversation', conversationId: convId, context });
          this.drainInbound();
        }
      },
      sessionMode: this.sessionMode,
    });
  }

  /** Inject an inbound message event — called by the driver. */
  injectMessage(msg: import('@newio/agent-sdk').IncomingMessage): void {
    this.inbound.push({ type: 'message', msg });
    this.drainInbound();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single interactive scenario. Returns a BattleReport.
 */
export async function runInteractiveScenario(
  scenario: InteractiveScenario,
  config: InteractiveEvalConfig,
): Promise<BattleReport> {
  const effectiveSessionMode: SessionMode = scenario.sessionMode === 'both' ? config.sessionMode : scenario.sessionMode;

  const ownerPersona = scenario.driver.personas.find((p) => p.relationship === 'owner');

  // Create shared mock environment
  const mockApp = new InteractiveMockNewioApp({
    identity: scenario.setup.agent ?? { userId: 'agent-001', username: 'nova', displayName: 'Nova' },
    owner: { username: ownerPersona?.username ?? 'owner', displayName: ownerPersona?.displayName ?? 'Owner' },
    contacts: scenario.setup.contacts.map((c) => ({
      username: c.username,
      displayName: c.displayName,
      accountType: c.accountType,
    })),
    conversations: scenario.setup.conversations.map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
      members: c.members.map((m) => ({
        username: m.username,
        displayName: m.displayName,
        accountType: m.accountType,
        role: m.role ?? 'member',
      })),
    })),
    initialMemory: scenario.setup.initialMemory,
  });

  // --- Target agent instance ---
  const mcpBridgePath = fileURLToPath(import.meta.resolve('@newio/agent-engine/mcp-bridge'));
  const targetConfig: AgentConfig = {
    id: 'eval-target',
    type: config.targetAgentType as AgentType,
    sessionMode: effectiveSessionMode,
    envVars: loadEnvFile(),
    acp: { cwd: config.acp.cwd, executablePath: config.acp.executablePath, kiroCliTrustAllTools: true },
  };

  const noopListener: AgentInstanceListener = {
    onStatusChanged: () => {},
    onApprovalUrl: () => {},
    onPollAttempt: () => {},
    onConfigUpdated: () => {},
    onAgentInfo: () => {},
  };

  const engineConfig = {
    apiBaseUrl: 'http://localhost',
    wsUrl: 'ws://localhost',
    stage: 'dev' as const,
    appDisplayName: 'Newio Eval',
    appVersion: '0.1.0',
    dataDir: tmpdir(),
    mcpBridgePath,
  };

  const targetInstance = new EvalAgentInstance(targetConfig, mockApp, effectiveSessionMode, noopListener, engineConfig);

  // Start the target — this will:
  // 1. Call createNewioApp() → gets our mock
  // 2. Call createPromptManager() → gets eval formatter
  // 3. Create AcpSessionFactory, init ACP process
  // 4. Create SessionManager (Isolated or Shared)
  // 5. Send greeting to owner DM
  await targetInstance.start();

  // --- Driver agent setup ---
  const driverSocketPath = join(tmpdir(), `newio-eval-driver-${process.pid}-${Date.now()}.sock`);
  const turns: TurnRecord[] = [];

  // Capture target outbound messages as turns
  mockApp.onMessageSent((msg: TargetMessage) => {
    turns.push({
      index: turns.length,
      actor: 'target',
      conversationId: msg.conversationId,
      text: msg.text ?? '',
      latencyMs: 0,
    });
  });

  const driverMcpServer = new McpServer({ name: 'newio-driver', version: '1.0.0' });
  const driverMcp = new DriverMcpServer({
    server: driverMcpServer,
    app: mockApp,
    personas: scenario.driver.personas,
    ownerUsername: ownerPersona?.username ?? 'owner',
    maxTurns: scenario.driver.maxTurns,
    onTurn: (turn) => turns.push(turn),
  });

  // Override injectMessage to route through the target agent instance
  const originalInject = mockApp.injectMessage.bind(mockApp);
  mockApp.injectMessage = (persona, conversationId, text, filePaths?) => {
    const incoming = originalInject(persona, conversationId, text, filePaths);
    // Route through the target agent instance (proper event queue + session orchestration)
    targetInstance.injectMessage(incoming);
    return incoming;
  };

  const driverUds: Server = startUdsServer({
    socketPath: driverSocketPath,
    onConnection: (transport) => void driverMcpServer.connect(transport),
  });

  const driverConfig: AgentConfig = {
    id: 'eval-driver',
    type: config.driverAgentType as AgentType,
    sessionMode: 'isolated',
    envVars: loadEnvFile(),
    acp: { cwd: config.acp.cwd, executablePath: config.acp.executablePath, kiroCliTrustAllTools: true },
  };

  const driverFactory = new AcpSessionFactory(driverConfig, 'Newio Eval Driver', '0.1.0', '[driver]');
  await driverFactory.init();

  const driverSession = await driverFactory.createSession({
    type: 'conversation',
    externalReferenceId: 'eval_driver',
    promptFormatterVersion: config.promptVersion,
    skipToken: '_skip',
    mcpSocketPath: driverSocketPath,
    mcpBridgePath,
    updateConfig: () => Promise.resolve(),
    reportContextWindow: () => Promise.resolve(),
  });
  await driverSession.applySessionConfig({ acpModel: config.driverModel });

  // Build driver system prompt and let it run
  const driverPrompt = buildDriverPrompt(scenario);
  const timeout = config.timeoutMs ?? 300_000;

  try {
    await withTimeout(collectAgentMessage(driverSession.prompt(driverPrompt)), timeout, 'Driver timed out');
  } catch (err: unknown) {
    if (!driverMcp.isDone) {
      turns.push({
        index: turns.length,
        actor: 'driver',
        conversationId: 'system',
        text: `[TIMEOUT] ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: 0,
      });
    }
  }

  // Teardown
  await driverFactory.terminate();
  await targetInstance.stop();
  await new Promise<void>((r) => driverUds.close(() => r()));

  // Judge
  const verdict = await judgeTrace(turns, scenario, config.judgeModel ?? config.targetModel);
  const outcome = driverMcp.outcome;

  return {
    id: `battle-${Date.now()}`,
    timestamp: new Date().toISOString(),
    scenario: {
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      description: scenario.description,
      objective: scenario.driver.objective,
    },
    config: {
      targetModel: config.targetModel,
      driverModel: config.driverModel,
      sessionMode: effectiveSessionMode,
      maxTurns: scenario.driver.maxTurns,
    },
    outcome: {
      declaredBy: driverMcp.isDone ? 'driver' : 'system',
      result: (outcome?.result ?? 'timeout') as BattleReport['outcome']['result'],
      reason: outcome?.reason ?? 'Timed out or max turns reached',
    },
    turns,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDriverPrompt(scenario: InteractiveScenario): string {
  const personaList = scenario.driver.personas
    .map((p) => {
      const parts = [
        `- **${p.username}** (${p.relationship}, ${p.conversationType})`,
        `  Personality: ${p.personality}`,
        `  Conversation ID: ${p.conversationId}`,
      ];
      if (p.knowledge) {
        parts.push(`  Knowledge: ${p.knowledge}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  const ownerUsername = scenario.driver.personas.find((p) => p.relationship === 'owner')?.username ?? 'owner';

  return `You are a test driver simulating multiple human users interacting with an AI agent.

## Your Objective
${scenario.driver.objective}

## Your Personas
${personaList}

## Rules
- Use the send_message tool to send messages as different personas
- Use get_new_events to see how the target agent responded
- You may send multiple messages before checking for responses
- Only the owner persona (${ownerUsername}) can use rotate_session and update_memory
- Call declare_done when your objective is achieved, failed, or you've exhausted your approaches
- Be creative and realistic — the target agent should believe these are real users
${scenario.driver.constraints ? `\n## Constraints\n${scenario.driver.constraints}` : ''}

## Start
Begin by sending your first message. Use get_new_events after each message to see the target's response before deciding your next move.`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
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

function loadEnvFile(): Record<string, string> {
  const envPath = join(fileURLToPath(import.meta.url), '../../../.env.agent');
  try {
    return parseDotenv(readFileSync(envPath, 'utf-8'));
  } catch {
    return { ...process.env } as Record<string, string>;
  }
}
