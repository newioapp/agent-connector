/**
 * EvalAgentInstance — subclass of BaseAgentInstance for interactive evaluation.
 *
 * Uses MockNewioApp (backed by MockBackend) instead of the real Newio SDK.
 * Runs a real ACP process for the agent, with eval-specific prompt formatting.
 */
import { BaseAgentInstance, PromptManager, PromptFormatterImpl } from '@newio/agent-engine';
import type {
  AgentConfig,
  NewioAppForAgent,
  SessionMode,
  EngineConfig,
  AgentInstanceListener,
} from '@newio/agent-engine';
import type { NewioAppForMcp, NewioMcpServerInterface } from '@newio/agent-engine';
import type { IncomingMessage, SessionStore } from '@newio/agent-engine';
import { MockNewioApp } from '../mock-newio-app.js';
import { OverridablePromptFormatter } from '../prompts/overridable-prompt-formatter.js';
import { NewioEvalMcpServer } from '../mcp/v1/server.js';
import { InMemorySessionStore } from './in-memory-session-store.js';

// ---------------------------------------------------------------------------
// No-op helpers for eval (no persistence needed)
// ---------------------------------------------------------------------------

const noopConfigManager = {
  getTokens: () => undefined,
  setTokens: () => {},
  setNewioIdentity: () => {},
} as never;

const noopCronStore = {
  saveCron: () => {},
  deleteCron: () => {},
  listCrons: () => [],
  close: () => {},
} as never;

const noopListener: AgentInstanceListener = {
  onStatusChanged: () => {},
  onApprovalUrl: () => {},
  onPollAttempt: () => {},
  onConfigUpdated: () => {},
  onAgentInfo: () => {},
};

// ---------------------------------------------------------------------------
// EvalAgentInstance
// ---------------------------------------------------------------------------

export interface EvalAgentInstanceOptions {
  readonly config: AgentConfig;
  readonly mockApp: MockNewioApp;
  readonly sessionMode: SessionMode;
  readonly engineConfig: EngineConfig;
  readonly listener?: AgentInstanceListener;
}

export class EvalAgentInstance extends BaseAgentInstance {
  private readonly mockApp: MockNewioApp;
  private readonly sessionMode: SessionMode;

  constructor(opts: EvalAgentInstanceOptions) {
    super(opts.config, noopConfigManager, noopCronStore, opts.listener ?? noopListener, opts.engineConfig);
    this.mockApp = opts.mockApp;
    this.sessionMode = opts.sessionMode;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createNewioApp(): Promise<NewioAppForAgent & NewioAppForMcp> {
    return this.mockApp;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createPromptManager(): Promise<PromptManager> {
    const formatter = new OverridablePromptFormatter(
      new PromptFormatterImpl(
        { username: this.mockApp.identity.username, displayName: this.mockApp.identity.displayName },
        this.mockApp.getOwnerInfo(),
        this.sessionMode,
      ),
    );
    return new PromptManager([formatter], formatter);
  }

  /**
   * Use an in-memory, non-persisted session store so evals never RESUME a stale
   * ACP session from a previous run — each run starts clean and creates fresh
   * sessions. (The real connector persists to disk and resumes via session/load.)
   */
  protected override createSessionStore(): SessionStore {
    return new InMemorySessionStore();
  }

  /** Optional hook called when the target agent invokes an MCP tool. */
  onToolCall?: (toolName: string, args: Readonly<Record<string, unknown>>) => void;

  createMcpServer(app: NewioAppForMcp): NewioMcpServerInterface {
    return new NewioEvalMcpServer({
      app,
      initiateConversation: (convId, context) => {
        if (!this.abortController.signal.aborted) {
          this.inbound.push({ type: 'initiate_conversation', conversationId: convId, context });
          this.drainInbound();
        }
      },
      shareContext: (convId, context) => {
        if (!this.abortController.signal.aborted) {
          this.inbound.push({ type: 'share_context', conversationId: convId, context });
          this.drainInbound();
        }
      },
      sessionMode: this.sessionMode,
      onToolCall: (tool, args) => {
        this.onToolCall?.(tool, args);
      },
    });
  }

  /** Inject a message into the agent's inbound queue (used by driver). */
  injectMessage(msg: IncomingMessage): void {
    if (!this.abortController.signal.aborted) {
      this.inbound.push({ type: 'message', msg });
      this.drainInbound();
    }
  }
}
