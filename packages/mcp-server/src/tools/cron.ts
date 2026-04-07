/**
 * Cron tools — MCP wrappers over NewioApp cron scheduling methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/sdk';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register cron scheduling tools on the MCP server. */
export function registerCronTools(server: McpServer, app: NewioApp, getSessionId: () => string | undefined): void {
  server.registerTool(
    'schedule_cron',
    {
      description:
        'Schedule a task. Supports recurring intervals and one-shot fixed-time triggers.\n' +
        'Recurring: "every <N>s|m|h" (e.g. "every 30m", "every 4h").\n' +
        'One-shot ISO: "at <ISO-8601>" (e.g. "at 2026-04-09T12:00:00Z").\n' +
        'One-shot with timezone: "at <YYYY-MM-DD> <HH:MM> [AM|PM] <timezone>" ' +
        '(e.g. "at 2026-04-10 10:00 AM America/New_York").',
      inputSchema: {
        expression: z
          .string()
          .describe(
            'Schedule expression. Examples: "every 30m", "at 2026-04-09T12:00:00Z", "at 2026-04-10 10:00 AM America/New_York"',
          ),
        label: z.string().describe('Human-readable description of what this cron job should do when it fires'),
        payload: z
          .unknown()
          .optional()
          .describe('Optional structured data to pass to your future self when the job fires'),
      },
    },
    ({ expression, label, payload }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return text('Error: no session context — cannot schedule cron');
      }
      const cronId = `cron_${Date.now().toString(36)}`;
      app.scheduleCron({ cronId, expression, newioSessionId: sessionId, label, payload });
      const def = app.listCrons().find((c) => c.cronId === cronId);
      const detail = def?.triggerAt ? `fires at ${def.triggerAt}` : expression;
      return text(`Cron scheduled: ${cronId} — "${label}" (${detail})`);
    },
  );

  server.registerTool(
    'cancel_cron',
    {
      description: 'Cancel a scheduled cron job by its ID',
      inputSchema: {
        cronId: z.string().describe('The cron job ID returned by schedule_cron'),
      },
    },
    ({ cronId }) => {
      app.cancelCron(cronId);
      return text(`Cron cancelled: ${cronId}`);
    },
  );

  server.registerTool('list_crons', { description: 'List all active cron jobs for this agent' }, () => {
    return json(app.listCrons());
  });
}
