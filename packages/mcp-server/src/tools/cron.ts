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
        'Schedule a recurring task. The label is your reminder of what to do when it fires. ' +
        'Expression format: "every <N>s|m|h" (e.g. "every 30m", "every 4h").',
      inputSchema: {
        expression: z.string().describe('Interval expression, e.g. "every 30m", "every 4h", "every 90s"'),
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
      return text(`Cron scheduled: ${cronId} — "${label}" (${expression})`);
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
