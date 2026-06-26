/**
 * NewioEvalMcpServer — the eval's MCP experimentation shell.
 *
 * By default it delegates to the real {@link NewioMcpServer} from
 * `@newio/agent-engine`, so an eval exposes exactly the toolset (and tool
 * descriptions) that ship — no fork, no drift.
 *
 * Experiment seam (grow when needed): to give the agent a different toolset or
 * tool descriptions for an A/B — e.g. suppressing a tool or swapping a
 * `share_context` description — replace the delegation below with a registration that
 * suppresses / overrides / adds tools, by running the real tool registration
 * against a `registerTool`-intercepting proxy of `McpServer` here, rather than
 * copying tool bodies. See OverridablePromptFormatter for the prompt-side analog.
 *
 * @example Override / suppress inner tools for an experiment
 * ```ts
 * // In the constructor, swap `new NewioMcpServer(...)` for a registration you
 * // control: run the engine's real tool registration against a proxy of
 * // McpServer that intercepts registerTool, so every production tool stays
 * // except the ones you deliberately drop or tweak (plus any extras you add).
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { registerNewioMcpTools } from '@newio/agent-engine'; // expose this fn when needed
 *
 * const server = new McpServer({ name: 'newio-mcp-server', version: '0.1.0' });
 * const suppress = new Set(['share_context']);                         // hide a tool
 * const overrides: Record<string, { description?: string }> = {
 *   share_context: { description: ALT_SHARE_CONTEXT_DESCRIPTION },      // A/B a description
 * };
 * const proxy = new Proxy(server, {
 *   get(target, prop, recv) {
 *     if (prop !== 'registerTool') return Reflect.get(target, prop, recv);
 *     return (name: string, def: Record<string, unknown>, handler: unknown) => {
 *       if (suppress.has(name)) return;                                 // never registered
 *       const merged = overrides[name] ? { ...def, ...overrides[name] } : def;
 *       return target.registerTool(name, merged, handler);
 *     };
 *   },
 * });
 * registerNewioMcpTools(proxy, { app, shareContext, profile, ownConversationId, hubConversationId, onToolCall });
 * // server.registerTool('my_experimental_tool', ...) to add extras, then keep `server` as `this.inner`'s transport target.
 * ```
 */
import { NewioMcpServer } from '@newio/agent-engine';
import type {
  NewioAppForMcp,
  NewioMcpServerInterface,
  MessagingProfile,
  ToolCallHook,
  Transport,
} from '@newio/agent-engine';

export interface NewioEvalMcpServerOptions {
  readonly app: NewioAppForMcp;
  /** Hand context to another of the agent's sessions (share_context tool). The target absorbs it. */
  readonly shareContext: (convId: string, context: string) => void;
  /** Which messaging tools this session gets, decided per session. */
  readonly profile: MessagingProfile;
  /** The conversation this session is responsible for (target of the 'current' send_message). */
  readonly ownConversationId?: string;
  /** For a share_context 'to-hub' profile: the chat hub (owner DM) conversation. */
  readonly hubConversationId?: string;
  /** Whether the agent has long-term memory enabled. When false, the memory tools are not registered. */
  readonly memoryEnabled: boolean;
  /** Optional hook called before each tool invocation. */
  readonly onToolCall?: ToolCallHook;
}

export class NewioEvalMcpServer implements NewioMcpServerInterface {
  private readonly inner: NewioMcpServer;

  constructor(opts: NewioEvalMcpServerOptions) {
    this.inner = new NewioMcpServer({
      app: opts.app,
      shareContext: opts.shareContext,
      profile: opts.profile,
      ownConversationId: opts.ownConversationId,
      hubConversationId: opts.hubConversationId,
      memoryEnabled: opts.memoryEnabled,
      onToolCall: opts.onToolCall,
    });
  }

  setCurrentConversationIdGetter(idGetter: () => string | undefined): void {
    this.inner.setCurrentConversationIdGetter(idGetter);
  }

  connect(transport: Transport): Promise<void> {
    return this.inner.connect(transport);
  }
}
