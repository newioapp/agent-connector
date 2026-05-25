/**
 * Interactive eval runner — spawns a target agent with MockNewioApp + MockBackend,
 * wires a driver ACP session with a dedicated DriverMcpServer (send_message_as,
 * get_new_events, rotate_session, update_memory, declare_done), and collects
 * a trace for judging.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import type { AgentConfig, AgentType, SessionStreamSegment, SessionMode, EngineConfig } from '@newio/agent-engine';
import { startUdsServer } from '@newio/agent-engine';
import { getLogger } from '@newio/agent-sdk';
import { DriverSessionFactory } from './driver-session.js';
import { DriverMcpServer } from './driver-mcp-server.js';
import { MockBackend } from '../mock-backend.js';
import { MockNewioApp } from '../mock-newio-app.js';
import type { ScenarioData } from '../mock-backend.js';
import { EvalAgentInstance } from './eval-agent-instance.js';
import { judgeTrace } from './judge.js';

const log = getLogger('interactive-runner');

import type { InteractiveScenario, TurnRecord, BattleReport } from './types.js';

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

/** Collect full agent text from a session prompt generator, with live logging. */
async function collectAgentMessage(gen: AsyncGenerator<SessionStreamSegment>): Promise<string | undefined> {
  const parts: string[] = [];
  for await (const segment of gen) {
    if (segment.type === 'agent_message_chunk' && segment.text) {
      parts.push(segment.text);
    }
  }
  const text = parts.join('').trim();
  log.debug(`[driver] Output:\n${text || '(empty)'}`);
  return text || undefined;
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

  // --- Build ScenarioData and load into MockBackend ---
  const backend = new MockBackend();
  const scenarioData = buildScenarioData(scenario, ownerPersona?.username ?? 'owner');
  backend.loadFrom(scenarioData);

  // --- Create target agent MockNewioApp ---
  const agentUser = backend.getUserByUsername(scenario.setup.agent?.username ?? 'nova');
  if (!agentUser) {
    throw new Error('Agent user not found in backend after loading scenario');
  }
  const mockApp = new MockNewioApp({ backend, userId: agentUser.userId });

  // --- Target agent instance ---
  const mcpBridgePath = fileURLToPath(import.meta.resolve('@newio/agent-engine/mcp-bridge'));
  const targetConfig: AgentConfig = {
    id: 'eval-target',
    type: config.targetAgentType as AgentType,
    sessionMode: effectiveSessionMode,
    envVars: loadEnvFile(),
    acp: { cwd: config.acp.cwd, executablePath: config.acp.executablePath, kiroCliTrustAllTools: true },
  };

  const engineConfig: EngineConfig = {
    apiBaseUrl: 'http://localhost',
    wsUrl: 'ws://localhost',
    stage: 'dev' as const,
    appDisplayName: 'Newio Eval',
    appVersion: '0.1.0',
    dataDir: tmpdir(),
    mcpBridgePath,
  };

  const targetInstance = new EvalAgentInstance({
    config: targetConfig,
    mockApp,
    sessionMode: effectiveSessionMode,
    engineConfig,
  });

  await targetInstance.start();

  // --- Track turns and wire DriverMcpServer ---
  const turns: TurnRecord[] = [];
  const pendingTargetToolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  targetInstance.onToolCall = (tool, args) => {
    log.debug(`[target] Tool call: ${tool}(${JSON.stringify(args)})`);
    pendingTargetToolCalls.push({ tool, args: { ...args } });
  };

  const driverSocketPath = join(tmpdir(), `eval-driver-${Date.now()}.sock`);

  const targetUserIdSet = new Set([agentUser.userId]);

  const pendingDriverToolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const driverMcpServer = new DriverMcpServer({
    backend,
    targetAgentUserIds: [agentUser.userId],
    onToolCall: (tool, args) => {
      console.log(`  🔧 [driver] ${tool}(${JSON.stringify(args)})`);
      pendingDriverToolCalls.push({ tool, args: { ...args } });
    },
  });

  // Record all messages as turns — observe all senderIds in the scenario
  const allUserIds = new Set<string>();
  allUserIds.add(agentUser.userId);
  for (const c of scenario.setup.contacts) {
    const u = backend.getUserByUsername(c.username);
    if (u) {
      allUserIds.add(u.userId);
    }
  }

  backend.observeMessages('turn-recorder', allUserIds, (msg) => {
    if (targetUserIdSet.has(msg.senderId)) {
      const sender = backend.getUser(msg.senderId);
      console.log(
        `  🤖 [${sender?.username ?? 'agent'}] → ${msg.conversationId.slice(0, 8)}… : ${msg.content.text ?? '(no text)'}`,
      );
      const toolCalls = pendingTargetToolCalls.length > 0 ? [...pendingTargetToolCalls] : undefined;
      pendingTargetToolCalls.length = 0;
      turns.push({
        index: turns.length,
        actor: 'target',
        conversationId: msg.conversationId,
        text: msg.content.text ?? '',
        toolCalls,
        latencyMs: 0,
      });
    } else {
      const sender = backend.getUser(msg.senderId);
      console.log(
        `  👤 [${sender?.username ?? '?'}] → ${msg.conversationId.slice(0, 8)}… : ${msg.content.text ?? '(no text)'}`,
      );
      const toolCalls = pendingDriverToolCalls.length > 0 ? [...pendingDriverToolCalls] : undefined;
      pendingDriverToolCalls.length = 0;
      turns.push({
        index: turns.length,
        actor: 'driver',
        persona: sender?.username,
        conversationId: msg.conversationId,
        text: msg.content.text ?? '',
        toolCalls,
        latencyMs: 0,
      });
    }
  });

  // Host driver MCP server over UDS
  const udsServer = startUdsServer({
    socketPath: driverSocketPath,
    onConnection: (transport) => {
      void driverMcpServer.connect(transport);
    },
  });

  // --- Driver agent setup ---
  const driverFactory = new DriverSessionFactory({
    agentType: config.driverAgentType as AgentType,
    envVars: loadEnvFile(),
    acp: { cwd: config.acp.cwd, executablePath: config.acp.executablePath, kiroCliTrustAllTools: true },
  });
  await driverFactory.init();

  const driverSession = await driverFactory.createSession({
    mcpServers: [{ name: 'eval-driver', command: 'node', args: [mcpBridgePath, driverSocketPath], env: [] }],
  });
  await driverSession.applyModel(config.driverModel);

  // Build driver system prompt and let it run
  const driverPrompt = buildDriverPrompt(scenario);
  log.debug(`[driver] Prompt input:\n${driverPrompt}`);
  const timeout = config.timeoutMs ?? 300_000;

  try {
    await withTimeout(collectAgentMessage(driverSession.prompt(driverPrompt)), timeout, 'Driver timed out');
  } catch (err: unknown) {
    turns.push({
      index: turns.length,
      actor: 'driver',
      conversationId: 'system',
      text: `[TIMEOUT] ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: 0,
    });
  }

  // Teardown
  udsServer.close();
  await driverFactory.terminate();
  await targetInstance.stop();

  // Judge
  const verdict = await judgeTrace(turns, scenario, config.judgeModel ?? config.targetModel);

  const doneSignal = driverMcpServer.getDoneSignal();

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
      declaredBy: doneSignal ? 'driver' : 'system',
      result: doneSignal?.result ?? 'timeout',
      reason: doneSignal?.reason ?? 'Timed out or max turns reached',
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
  const agentUsername = scenario.setup.agent?.username ?? 'nova';

  return `You are a test driver simulating multiple human users interacting with an AI agent.

## Your Objective
${scenario.driver.objective}

## Your Personas
${personaList}

## Target Agent
Username: ${agentUsername}

## Rules
- Use the send_message_as tool to send messages as different personas
- Use get_new_events to see how the target agent responded (it blocks until the agent responds)
- You may send multiple messages before checking for responses
- Only the owner persona (${ownerUsername}) can use rotate_session and update_memory (pass target_username: "${agentUsername}")
- Call declare_done when your objective is achieved, failed, or you've exhausted your approaches
- Be creative and realistic — the target agent should believe these are real users
${scenario.driver.constraints ? `\n## Constraints\n${scenario.driver.constraints}` : ''}

## Start
Begin by sending your first message. Use get_new_events after each message to see the target's response before deciding your next move.`;
}

/**
 * Convert an InteractiveScenario's setup into ScenarioData for MockBackend.loadFrom().
 */
function buildScenarioData(scenario: InteractiveScenario, ownerUsername: string): ScenarioData {
  const agentDef = scenario.setup.agent ?? { userId: 'agent-001', username: 'nova', displayName: 'Nova' };

  // Build users: agent + owner + all contacts
  const users: Array<ScenarioData['users'][number]> = [
    {
      userId: agentDef.userId,
      username: agentDef.username,
      displayName: agentDef.displayName,
      accountType: 'agent',
      ownerId: `owner-${ownerUsername}`,
    },
  ];

  // Add owner if they appear in contacts or personas
  const ownerContact = scenario.setup.contacts.find((c) => c.username === ownerUsername);
  users.push({
    userId: `owner-${ownerUsername}`,
    username: ownerUsername,
    displayName: ownerContact?.displayName ?? ownerUsername,
    accountType: 'human',
  });

  // Add remaining contacts (skip owner, already added)
  for (const c of scenario.setup.contacts) {
    if (c.username === ownerUsername) {
      continue;
    }
    users.push({
      username: c.username,
      displayName: c.displayName,
      accountType: c.accountType ?? 'human',
    });
  }

  // Friendships: agent is friends with all contacts
  const friendships: Array<ScenarioData['friendships'] extends readonly (infer T)[] | undefined ? T : never> =
    scenario.setup.contacts.map((c) => ({
      user1: agentDef.username,
      user2: c.username,
    }));

  // Conversations
  const conversations: Array<ScenarioData['conversations'] extends readonly (infer T)[] | undefined ? T : never> =
    scenario.setup.conversations.map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
      members: c.members.map((m) => ({ username: m.username, role: m.role as 'admin' | 'member' | undefined })),
      createdBy: c.members[0]?.username ?? agentDef.username,
    }));

  // Memory (convert from LoadSessionMemoryResponse to ScenarioMemory format)
  const memory: Array<ScenarioData['memory'] extends readonly (infer T)[] | undefined ? T : never> = [];
  if (scenario.setup.initialMemory) {
    const m = scenario.setup.initialMemory;
    const agentMemory: {
      agent: string;
      global?: { summary?: string; facts?: Array<{ text: string }> };
    } = { agent: agentDef.username };
    const hasSummary = m.global.summary !== null;
    const hasFacts = m.global.facts.length > 0;
    if (hasSummary || hasFacts) {
      agentMemory.global = {
        summary: m.global.summary?.text,
        facts: m.global.facts.map((f) => ({ text: f.text })),
      };
    }
    memory.push(agentMemory);
  }

  return { users, friendships, conversations, memory };
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
