/**
 * Driver MCP Server — provides tools for the driver agent to act as multiple users.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NewioAppForDriverMcp, DriverPersona, TurnRecord } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true as const });

export interface DriverMcpServerOptions {
  readonly server: McpServer;
  readonly app: NewioAppForDriverMcp;
  readonly personas: readonly DriverPersona[];
  readonly ownerUsername: string;
  readonly maxTurns: number;
  readonly onTurn?: (turn: TurnRecord) => void;
}

export class DriverMcpServer {
  private readonly app: NewioAppForDriverMcp;
  private readonly personas: Map<string, DriverPersona>;
  private readonly maxTurns: number;
  private readonly onTurn?: (turn: TurnRecord) => void;

  private turnCount = 0;
  private lastEventTimestamp = 0;
  private done = false;
  private doneOutcome?: { result: string; reason: string };

  constructor(opts: DriverMcpServerOptions) {
    this.app = opts.app;
    this.personas = new Map(opts.personas.map((p) => [p.username, p]));
    this.maxTurns = opts.maxTurns;
    this.onTurn = opts.onTurn;
    this.registerTools(opts.server);
  }

  get isDone(): boolean {
    return this.done;
  }

  get outcome(): { result: string; reason: string } | undefined {
    return this.doneOutcome;
  }

  private registerTools(server: McpServer): void {
    server.registerTool(
      'send_message',
      {
        description: 'Send a message as one of your personas to the target agent',
        inputSchema: {
          persona: z.string().describe('Username of the persona to act as'),
          conversationId: z.string().describe('Conversation to send the message in'),
          text: z.string().describe('Message text to send'),
        },
      },
      ({ persona, conversationId, text: msgText }) => {
        if (this.done) {
          return text('Test is already done.');
        }
        if (this.turnCount >= this.maxTurns) {
          this.done = true;
          this.doneOutcome = { result: 'max_turns', reason: `Reached max turns (${this.maxTurns})` };
          return text(`Max turns (${this.maxTurns}) reached. Test ended.`);
        }
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }

        this.turnCount++;
        this.app.injectMessage(persona, conversationId, msgText);
        this.onTurn?.({
          index: this.turnCount,
          actor: 'driver',
          persona,
          conversationId,
          text: msgText,
          latencyMs: 0,
        });

        return text(`Message sent as ${persona} (turn ${this.turnCount}/${this.maxTurns})`);
      },
    );

    server.registerTool(
      'get_new_events',
      { description: 'Get all new messages from the target agent since your last check' },
      () => {
        const events = this.app.getTargetMessagesSince(this.lastEventTimestamp);
        this.lastEventTimestamp = Date.now();

        if (events.length === 0) {
          return text('No new events from target.');
        }

        const formatted = events.map((e) => `[${e.conversationId}] ${e.text ?? '(no text)'}`).join('\n');
        return text(formatted);
      },
    );

    server.registerTool(
      'get_conversation_history',
      {
        description: 'Get message history for a conversation (only what your persona can see)',
        inputSchema: {
          persona: z.string().describe('Username of the persona'),
          conversationId: z.string().describe('Conversation ID'),
          limit: z.number().optional().describe('Max messages to return'),
        },
      },
      ({ persona, conversationId, limit }) => {
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }
        const history = this.app.getConversationHistory(persona, conversationId, limit);
        if (history.length === 0) {
          return text('No messages in this conversation.');
        }
        return text(history.map((m) => `${m.from}: ${m.text}`).join('\n'));
      },
    );

    server.registerTool(
      'get_persona_conversations',
      {
        description: 'List conversations a persona is a member of',
        inputSchema: { persona: z.string().describe('Username of the persona') },
      },
      ({ persona }) => {
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }
        const convs = this.app.getPersonaConversations(persona);
        return text(
          convs.map((c) => `${c.conversationId} (${c.type}${c.name ? `: ${c.name}` : ''})`).join('\n') ||
            'No conversations.',
        );
      },
    );

    server.registerTool(
      'create_conversation',
      {
        description: 'Create a group conversation as a persona',
        inputSchema: {
          persona: z.string().describe('Username of the persona creating the conversation'),
          type: z.enum(['group', 'temp_group']).describe('Conversation type'),
          name: z.string().describe('Conversation name'),
          members: z.array(z.string()).describe('Usernames to add as members'),
        },
      },
      ({ persona, type, name, members }) => {
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }
        const convId = this.app.createConversationAsPersona(persona, type, name, members);
        return text(`Created conversation: ${convId}`);
      },
    );

    server.registerTool(
      'add_member',
      {
        description: 'Add a member to a conversation',
        inputSchema: {
          persona: z.string().describe('Username of the persona performing the action'),
          conversationId: z.string().describe('Conversation ID'),
          username: z.string().describe('Username to add'),
        },
      },
      ({ persona, conversationId, username }) => {
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }
        this.app.addMemberAsPersona(persona, conversationId, username);
        return text(`Added ${username} to ${conversationId}`);
      },
    );

    server.registerTool(
      'leave_conversation',
      {
        description: 'Remove a persona from a conversation',
        inputSchema: {
          persona: z.string().describe('Username of the persona leaving'),
          conversationId: z.string().describe('Conversation ID'),
        },
      },
      ({ persona, conversationId }) => {
        if (!this.personas.has(persona)) {
          return err(`Unknown persona: ${persona}`);
        }
        this.app.leaveConversation(persona, conversationId);
        return text(`${persona} left ${conversationId}`);
      },
    );

    server.registerTool(
      'rotate_session',
      {
        description: 'Owner-only: trigger session rotation on the target agent',
        inputSchema: { conversationId: z.string().describe('Conversation ID to rotate session for') },
      },
      async ({ conversationId }) => {
        await this.app.triggerRotateSession(conversationId);
        return text(`Session rotated for ${conversationId}`);
      },
    );

    server.registerTool(
      'update_memory',
      {
        description: 'Owner-only: trigger memory update on the target agent',
        inputSchema: { conversationId: z.string().describe('Conversation ID to trigger memory update for') },
      },
      async ({ conversationId }) => {
        await this.app.triggerUpdateMemory(conversationId);
        return text(`Memory update triggered for ${conversationId}`);
      },
    );

    server.registerTool(
      'declare_done',
      {
        description: 'End the test with an outcome',
        inputSchema: {
          outcome: z.enum(['objective_achieved', 'objective_failed', 'exhausted']).describe('Test outcome'),
          reason: z.string().describe('Why you are ending the test'),
        },
      },
      ({ outcome, reason }) => {
        this.done = true;
        this.doneOutcome = { result: outcome, reason };
        return text(`Test ended: ${outcome} — ${reason}`);
      },
    );
  }
}
