/**
 * OwnerBackend — a thin REST client for the *human* side of platform e2e tests.
 *
 * The connector under test brings its own agent-side client (`@newio/agent-sdk`).
 * For the human/owner side we talk to the same deployed backend directly over
 * HTTP, so the harness stays self-contained in this repo (no cross-repo
 * dependency on `@conduit/client`). Only the handful of endpoints the harness
 * needs are implemented; routes mirror the Conduit REST API.
 */

export interface OwnerTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}

export interface AgentCredentials {
  readonly agentId: string;
  readonly username: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface ConversationSummary {
  readonly conversationId: string;
  readonly type: string;
}

export interface MessageSummary {
  readonly messageId: string;
  readonly senderId: string;
  readonly text: string;
}

export interface ActionOptionSummary {
  readonly optionId: string;
  readonly label: string;
}

/** An interactive ActionRequest (e.g. a permission prompt) carried on a message. */
export interface ActionRequestSummary {
  readonly messageId: string;
  readonly senderId: string;
  readonly requestId: string;
  readonly type: string;
  readonly title: string;
  readonly options: readonly ActionOptionSummary[];
}

function str(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string field "${key}" in response, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object response, got ${JSON.stringify(value)}`);
  }
  // Sanctioned narrowing of untyped JSON: guard at runtime, then read fields via str().
  return value as Record<string, unknown>;
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/** Build a unique username: starts with a letter, one internal underscore, ≤24 chars. */
function uniqueUsername(prefix: string): string {
  const base = prefix.replace(/[^a-zA-Z]/g, '').slice(0, 8) || 'agent';
  const suffix = unique('').slice(-8);
  return `${base}_${suffix}`.slice(0, 24).replace(/_+$/g, '');
}

export class OwnerBackend {
  constructor(private readonly apiBaseUrl: string) {}

  private async request(path: string, token: string | undefined, init?: RequestInit): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${this.apiBaseUrl}${path}`, { method: init?.method, body: init?.body, headers });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
    }
    return body.length > 0 ? JSON.parse(body) : {};
  }

  /** Create a fresh owner with a username set (most endpoints require a username claim). */
  async createOwner(displayName = 'E2E Owner'): Promise<OwnerTokens & { readonly username: string }> {
    const email = `${unique('e2e-owner-')}@test.newio.app`;
    const login = asRecord(
      await this.request('/auth/test-login', undefined, {
        method: 'POST',
        body: JSON.stringify({ email, displayName, createIfMissing: true }),
      }),
    );
    const accessToken = str(login, 'accessToken');
    const username = uniqueUsername('owner');
    await this.request('/users/me', accessToken, { method: 'PUT', body: JSON.stringify({ username }) });

    // Re-login so the JWT carries the username claim (email GSI is eventually consistent).
    const relogin = asRecord(
      await this.request('/auth/test-login', undefined, { method: 'POST', body: JSON.stringify({ email }) }),
    );
    return {
      accessToken: str(relogin, 'accessToken'),
      refreshToken: str(relogin, 'refreshToken'),
      userId: str(relogin, 'userId'),
      username,
    };
  }

  /** Register an agent and have `owner` approve it, returning the agent's own tokens. */
  async createApprovedAgent(owner: OwnerTokens, name = 'E2E Puppet'): Promise<AgentCredentials> {
    const reg = asRecord(
      await this.request('/agents/register', undefined, { method: 'POST', body: JSON.stringify({ name }) }),
    );
    const agentId = str(reg, 'agentId');
    const approvalId = str(reg, 'approvalId');
    const approvalToken = new URL(str(reg, 'approvalUrl')).searchParams.get('token');
    if (!approvalToken) {
      throw new Error('approvalUrl missing token');
    }

    const username = uniqueUsername('puppet');
    await this.request(
      `/approvals/${approvalId}/approve?token=${encodeURIComponent(approvalToken)}`,
      owner.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ username }),
      },
    );
    const poll = asRecord(
      await this.request(
        `/approvals/${approvalId}/status?token=${encodeURIComponent(approvalToken)}`,
        owner.accessToken,
      ),
    );
    return {
      agentId,
      username,
      accessToken: str(poll, 'accessToken'),
      refreshToken: str(poll, 'refreshToken'),
    };
  }

  /**
   * Approve a pending agent the CLI registered (the `create-account` flow),
   * assigning it `username`. The owner becomes the agent's owner.
   */
  async approvePendingAgent(
    owner: OwnerTokens,
    approvalId: string,
    approvalToken: string,
    username: string,
  ): Promise<void> {
    await this.request(
      `/approvals/${approvalId}/approve?token=${encodeURIComponent(approvalToken)}`,
      owner.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ username }),
      },
    );
  }

  async listConversations(token: string): Promise<readonly ConversationSummary[]> {
    const body = asRecord(await this.request('/conversations', token));
    const conversations = Array.isArray(body.conversations) ? body.conversations : [];
    return conversations.map((c) => {
      const obj = asRecord(c);
      return { conversationId: str(obj, 'conversationId'), type: str(obj, 'type') };
    });
  }

  async sendMessage(token: string, conversationId: string, text: string): Promise<void> {
    await this.request(`/conversations/${conversationId}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({ content: { text } }),
    });
  }

  /**
   * Create a Work Session (temp_group) owned by `owner` containing `agentId`.
   * Returns the new conversation's id. Agents in a temp_group default to
   * `canSend=false`, so call {@link setAgentCanSend} to let the agent post.
   */
  async createWorkSession(owner: OwnerTokens, agentId: string, name = 'E2E Work Session'): Promise<string> {
    const body = asRecord(
      await this.request('/conversations', owner.accessToken, {
        method: 'POST',
        body: JSON.stringify({ type: 'temp_group', name, memberIds: [agentId] }),
      }),
    );
    return str(body, 'conversationId');
  }

  /** Toggle an agent member's send permission in a group/work-session (owner only). */
  async setAgentCanSend(owner: OwnerTokens, conversationId: string, agentId: string, canSend: boolean): Promise<void> {
    await this.request(`/conversations/${conversationId}/members/${agentId}/can-send`, owner.accessToken, {
      method: 'PUT',
      body: JSON.stringify({ canSend }),
    });
  }

  async listMessages(token: string, conversationId: string, limit = 50): Promise<readonly MessageSummary[]> {
    const body = asRecord(await this.request(`/conversations/${conversationId}/messages?limit=${limit}`, token));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.map((m) => {
      const obj = asRecord(m);
      const content = asRecord(obj.content ?? {});
      return {
        messageId: str(obj, 'messageId'),
        senderId: str(obj, 'senderId'),
        text: typeof content.text === 'string' ? content.text : '',
      };
    });
  }

  /** List the ActionRequests (messages carrying `content.action`) visible to `token`. */
  async listActionRequests(
    token: string,
    conversationId: string,
    limit = 50,
  ): Promise<readonly ActionRequestSummary[]> {
    const body = asRecord(await this.request(`/conversations/${conversationId}/messages?limit=${limit}`, token));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requests: ActionRequestSummary[] = [];
    for (const m of messages) {
      const obj = asRecord(m);
      const content = asRecord(obj.content ?? {});
      if (typeof content.action !== 'object' || content.action === null) {
        continue;
      }
      const action = asRecord(content.action);
      const options = Array.isArray(action.options) ? action.options : [];
      requests.push({
        messageId: str(obj, 'messageId'),
        senderId: str(obj, 'senderId'),
        requestId: str(action, 'requestId'),
        type: str(action, 'type'),
        title: typeof action.title === 'string' ? action.title : '',
        options: options.map((o) => {
          const opt = asRecord(o);
          return { optionId: str(opt, 'optionId'), label: typeof opt.label === 'string' ? opt.label : '' };
        }),
      });
    }
    return requests;
  }

  /** Poll until an ActionRequest matching `predicate` appears, or time out. */
  async waitForActionRequest(
    token: string,
    conversationId: string,
    predicate: (a: ActionRequestSummary) => boolean,
    timeoutMs = 30_000,
    intervalMs = 1_000,
  ): Promise<ActionRequestSummary> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = (await this.listActionRequests(token, conversationId)).find(predicate);
      if (match) {
        return match;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error('Timed out waiting for a matching action request');
  }

  /**
   * Send a signal (`POST /signals`) from the owner to one of its agents. Used to
   * drive owner-triggered session lifecycle (e.g. `rotate_session`, `update_memory`).
   * The target agent must be online or the backend returns 409.
   */
  async sendSignal(
    token: string,
    targetUserId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.request('/signals', token, {
      method: 'POST',
      body: JSON.stringify({ targetUserId, requestId: unique('sig-'), intent: 'request', type, payload }),
    });
  }

  /** Answer an ActionRequest by posting a response-only message (`content.response`). */
  async sendActionResponse(
    token: string,
    conversationId: string,
    requestId: string,
    selectedOptionId: string,
  ): Promise<void> {
    await this.request(`/conversations/${conversationId}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({ content: { response: { requestId, selectedOptionId } } }),
    });
  }

  /** Read an agent's memory facts for a scope (default: global). Owner-authorized. */
  async getMemoryFacts(token: string, agentId: string, scope = 'global', scopeId?: string): Promise<readonly string[]> {
    const query = scopeId ? `?scope=${scope}&scopeId=${encodeURIComponent(scopeId)}` : `?scope=${scope}`;
    const body = asRecord(await this.request(`/agents/${agentId}/memory${query}`, token));
    const data = asRecord(body.data ?? {});
    const facts = Array.isArray(data.facts) ? data.facts : [];
    return facts.map((f) => str(asRecord(f), 'text'));
  }

  /** Poll `getMemoryFacts` until a fact matching `predicate` appears, or time out. */
  async waitForMemoryFact(
    token: string,
    agentId: string,
    predicate: (text: string) => boolean,
    scope = 'global',
    timeoutMs = 30_000,
    intervalMs = 1_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last: readonly string[] = [];
    while (Date.now() < deadline) {
      last = await this.getMemoryFacts(token, agentId, scope);
      const match = last.find(predicate);
      if (match) {
        return match;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for a matching memory fact. Last seen: ${JSON.stringify(last)}`);
  }

  /** Poll `listMessages` until a message matching `predicate` appears, or time out. */
  async waitForMessage(
    token: string,
    conversationId: string,
    predicate: (m: MessageSummary) => boolean,
    timeoutMs = 30_000,
    intervalMs = 1_000,
  ): Promise<MessageSummary> {
    const deadline = Date.now() + timeoutMs;
    let last: readonly MessageSummary[] = [];
    while (Date.now() < deadline) {
      last = await this.listMessages(token, conversationId);
      const match = last.find(predicate);
      if (match) {
        return match;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timed out waiting for a matching message. Last seen: ${JSON.stringify(last)}`);
  }
}
