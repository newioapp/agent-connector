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

export function registerCronTools(
  server: McpServer,
  app: NewioApp,
  desc: ToolDescriptions,
  onToolCall?: ToolCallHook,
): void {
  const sc = desc.scheduleCron();
  server.registerTool(
    sc.toolName,
    {
      description: sc.description,
      inputSchema: {
        expression: z.string().describe(sc.params.expression),
        label: z.string().describe(sc.params.label),
        payload: z.unknown().optional().describe(sc.params.payload),
      },
    },
    ({ expression, label, payload }) => {
      onToolCall?.(sc.toolName, { expression, label, payload });
      const cronId = `cron_${Date.now().toString(36)}`;
      app.scheduleCron({ cronId, expression, label, payload });
      return text(`Cron scheduled: ${cronId} — "${label}" (${expression})`);
    },
  );

  const cc = desc.cancelCron();
  server.registerTool(
    cc.toolName,
    { description: cc.description, inputSchema: { cronId: z.string().describe(cc.params.cronId) } },
    ({ cronId }) => {
      onToolCall?.(cc.toolName, { cronId });
      const status = app.cancelCron(cronId);
      return status === 'not_found' ? text(`Cron not found: ${cronId}`) : text(`Cron cancelled: ${cronId}`);
    },
  );

  const lc = desc.listCrons();
  server.registerTool(lc.toolName, { description: lc.description }, () => {
    onToolCall?.(lc.toolName, {});
    return json(app.listCrons());
  });
}
