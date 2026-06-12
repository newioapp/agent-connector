/**
 * NewioEvalMcpServer — the eval's MCP experimentation shell.
 *
 * By default it delegates to the real {@link NewioMcpServer} from
 * `@newio/agent-engine`, so an eval exposes exactly the toolset (and tool
 * descriptions) that ship — no fork, no drift.
 *
 * Experiment seam (grow when needed): to give the agent a different toolset or
 * tool descriptions for an A/B — e.g. comparing `initiate_conversation` vs.
 * `share_context` — replace the delegation below with a registration that
 * suppresses / overrides / adds tools, by running the real tool registration
 * against a `registerTool`-intercepting proxy of `McpServer` here, rather than
 * copying tool bodies. See OverridablePromptFormatter for the prompt-side analog.
 */
import { NewioMcpServer } from '@newio/agent-engine';
import type {
  NewioAppForMcp,
  NewioMcpServerInterface,
  SessionMode,
  ToolCallHook,
  Transport,
} from '@newio/agent-engine';

export interface NewioEvalMcpServerOptions {
  readonly app: NewioAppForMcp;
  /** Delegate a task to another conversation's session (isolated mode). */
  readonly initiateConversation: (convId: string, context: string) => void;
  /** Hand context to another of the agent's sessions (chat-shared mode). The target absorbs it. */
  readonly shareContext: (convId: string, context: string) => void;
  readonly sessionMode: SessionMode;
  /** Optional hook called before each tool invocation. */
  readonly onToolCall?: ToolCallHook;
}

export class NewioEvalMcpServer implements NewioMcpServerInterface {
  private readonly inner: NewioMcpServer;

  constructor(opts: NewioEvalMcpServerOptions) {
    this.inner = new NewioMcpServer({
      app: opts.app,
      initiateConversation: opts.initiateConversation,
      shareContext: opts.shareContext,
      sessionMode: opts.sessionMode,
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
