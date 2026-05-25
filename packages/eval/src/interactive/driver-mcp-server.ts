/**
 * DriverMcpServer — MCP server for the interactive eval driver agent.
 *
 * Exposes 5 tools that let the driver impersonate personas, observe target
 * agent responses, trigger lifecycle events, and signal completion.
 *
 * Event collection is delegated to MockBackend.collectEvents() which handles
 * blocking, idle detection, and batching.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { MockBackend, BackendSignal } from '../mock-backend.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriverToolCallHook = (toolName: string, args: Readonly<Record<string, unknown>>) => void;

export interface DriverMcpServerOptions {
  /** The mock backend to send messages / signals through. */
  readonly backend: MockBackend;
  /** UserIds of all target agents being tested (to filter events). */
  readonly targetAgentUserIds: readonly string[];
  /** Idle silence duration (ms) before get_new_events returns a batch. */
  readonly idleTimeoutMs?: number;
  /** Max wait time (ms) for get_new_events before returning empty. */
  readonly maxWaitMs?: number;
  /** Optional hook called when the driver invokes an MCP tool. */
  readonly onToolCall?: DriverToolCallHook;
}

export type DeclareResult = 'objective_achieved' | 'objective_failed' | 'exhausted';

export interface DriverDoneSignal {
  readonly result: DeclareResult;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class DriverMcpServer {
  private readonly server: McpServer;
  private readonly backend: MockBackend;
  private readonly targetAgentUserIds: ReadonlySet<string>;
  private readonly idleTimeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly onToolCall?: DriverToolCallHook;

  /** Set when driver calls declare_done. */
  private doneSignal: DriverDoneSignal | undefined;

  constructor(opts: DriverMcpServerOptions) {
    this.backend = opts.backend;
    this.targetAgentUserIds = new Set(opts.targetAgentUserIds);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5000;
    this.maxWaitMs = opts.maxWaitMs ?? 60000;
    this.onToolCall = opts.onToolCall;

    this.server = new McpServer({ name: 'eval-driver-mcp', version: '0.1.0' });
    this.registerTools();
  }

  get isDone(): boolean {
    return this.doneSignal !== undefined;
  }

  getDoneSignal(): DriverDoneSignal | undefined {
    return this.doneSignal;
  }

  connect(transport: Transport): Promise<void> {
    return this.server.connect(transport);
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------

  private registerTools(): void {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

    // ── send_message_as ──
    this.server.registerTool(
      'send_message_as',
      {
        description:
          'Send a message as a specific persona (user) in a conversation. Use this to simulate humans interacting with the target agent.',
        inputSchema: {
          username: z.string().describe('Username of the persona to send as'),
          conversationId: z.string().describe('Conversation to send the message in'),
          text: z.string().describe('Message text to send'),
        },
      },
      ({ username, conversationId, text: msgText }) => {
        this.onToolCall?.('send_message_as', { username, conversationId, text: msgText });
        const user = this.backend.getUserByUsername(username);
        if (!user) {
          return text(`Error: Unknown user "${username}"`);
        }
        try {
          this.backend.sendMessage({ conversationId, senderId: user.userId, text: msgText });
          return text(`Message sent as ${username} in ${conversationId}`);
        } catch (err: unknown) {
          return text(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );

    // ── get_new_events ──
    this.server.registerTool(
      'get_new_events',
      {
        description:
          'Wait for and retrieve new messages from target agent(s). Blocks until at least one message arrives, then waits for 5 seconds of silence before returning the full batch. Returns all messages grouped by conversation.',
      },
      async () => {
        this.onToolCall?.('get_new_events', {});
        const batch = await this.backend.collectEvents({
          senderIds: this.targetAgentUserIds,
          idleMs: this.idleTimeoutMs,
          timeoutMs: this.maxWaitMs,
        });
        if (batch.length === 0) {
          return text('No response from target agent(s) (timed out).');
        }
        const grouped = new Map<string, string[]>();
        for (const msg of batch) {
          const sender = this.backend.getUser(msg.senderId);
          const key = msg.conversationId;
          const list = grouped.get(key) ?? [];
          list.push(`[${sender?.username ?? msg.senderId}]: ${msg.content.text ?? '(no text)'}`);
          grouped.set(key, list);
        }
        const lines: string[] = [];
        for (const [convId, msgs] of grouped) {
          lines.push(`── ${convId} ──`);
          lines.push(...msgs);
        }
        return text(lines.join('\n'));
      },
    );

    // ── rotate_session ──
    this.server.registerTool(
      'rotate_session',
      {
        description:
          "Trigger a session rotation on a target agent for a specific conversation. This ends the agent's current session and starts a fresh one (with memory + handoff). Only the owner persona should use this.",
        inputSchema: {
          target_username: z.string().describe('Username of the target agent to rotate'),
          conversationId: z.string().describe('Conversation whose session should be rotated'),
        },
      },
      ({ target_username, conversationId }) => {
        this.onToolCall?.('rotate_session', { target_username, conversationId });
        const agent = this.backend.getUserByUsername(target_username);
        if (!agent) {
          return text(`Error: Unknown agent "${target_username}"`);
        }
        const signal: BackendSignal = {
          signalType: 'rotate_session',
          sessionType: 'conversation',
          externalReferenceId: conversationId,
        };
        this.backend.sendSignal(agent.userId, signal);
        return text(`Session rotation triggered for ${target_username} in ${conversationId}`);
      },
    );

    // ── update_memory ──
    this.server.registerTool(
      'update_memory',
      {
        description:
          'Trigger a memory update on a target agent for a specific conversation. This tells the agent to persist important facts to memory NOW without ending the session. Only the owner persona should use this.',
        inputSchema: {
          target_username: z.string().describe('Username of the target agent to trigger'),
          conversationId: z.string().describe('Conversation whose session should update memory'),
        },
      },
      ({ target_username, conversationId }) => {
        this.onToolCall?.('update_memory', { target_username, conversationId });
        const agent = this.backend.getUserByUsername(target_username);
        if (!agent) {
          return text(`Error: Unknown agent "${target_username}"`);
        }
        const signal: BackendSignal = {
          signalType: 'update_memory',
          sessionType: 'conversation',
          externalReferenceId: conversationId,
        };
        this.backend.sendSignal(agent.userId, signal);
        return text(`Memory update triggered for ${target_username} in ${conversationId}`);
      },
    );

    // ── declare_done ──
    this.server.registerTool(
      'declare_done',
      {
        description:
          'Declare that the test is complete. Call this when your objective is achieved, clearly failed, or you have exhausted all approaches.',
        inputSchema: {
          result: z
            .enum(['objective_achieved', 'objective_failed', 'exhausted'])
            .describe('The outcome of your test driving'),
          reason: z.string().describe('Brief explanation of why you are stopping'),
        },
      },
      ({ result, reason }) => {
        this.onToolCall?.('declare_done', { result, reason });
        this.doneSignal = { result, reason };
        return text(`Done: ${result} — ${reason}`);
      },
    );
  }
}
