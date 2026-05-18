/**
 * Cron tools — MCP wrappers over NewioApp cron scheduling methods.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NewioApp } from '@newio/agent-sdk';
import type { ToolCallHook } from '../types.js';
import type { ToolDescriptions } from '../tool-descriptions.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/** Register cron scheduling tools on the MCP server. */
export function registerCronTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const schedule = desc.scheduleCron();
  server.registerTool(
    'schedule_cron',
    {
      description: schedule.description,
      inputSchema: {
        expression: z.string().describe(schedule.params.expression),
        label: z.string().describe(schedule.params.label),
        payload: z.unknown().optional().describe(schedule.params.payload),
      },
    },
    ({ expression, label, payload }) => {
      onToolCall?.('schedule_cron', { expression, label, payload });
      const cronId = `cron_${Date.now().toString(36)}`;
      app.scheduleCron({ cronId, expression, label, payload });
      return text(`Cron scheduled: ${cronId} — "${label}" (${expression})`);
    },
  );

  const cancel = desc.cancelCron();
  server.registerTool(
    'cancel_cron',
    {
      description: cancel.description,
      inputSchema: { cronId: z.string().describe(cancel.params.cronId) },
    },
    ({ cronId }) => {
      onToolCall?.('cancel_cron', { cronId });
      const status = app.cancelCron(cronId);
      if (status === 'not_found') {
        return text(`Cron not found: ${cronId}`);
      }
      return text(`Cron cancelled: ${cronId}`);
    },
  );

  const listCrons = desc.listCrons();
  server.registerTool('list_crons', { description: listCrons.description }, () => {
    onToolCall?.('list_crons', {});
    return json(app.listCrons());
  });
}
