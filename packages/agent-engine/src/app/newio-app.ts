/**
 * NewioApp — high-level abstraction over the Newio SDK.
 *
 * Owns the full Newio lifecycle: auth, HTTP client, WebSocket connection.
 * Delegates state management to {@link NewioAppStore}, media to helper functions,
 * event wiring to {@link wireEvents}.
 *
 * Used by the Agent Connector, MCP server, and standalone agent implementations.
 */
import { homedir } from 'os';
import { join } from 'path';
import { AuthManager } from '@newio/agent-sdk';
import { NewioClient } from '@newio/agent-sdk';
import { NewioWebSocket } from '@newio/agent-sdk';
import { getLogger } from '@newio/agent-sdk';
import { ActivityThrottle } from '@newio/agent-sdk';
import { NewioAppStore } from './store.js';
import { loadConversation, wireEvents } from './events.js';
import { uploadFiles, downloadAttachment } from './media.js';
import { CronScheduler } from './cron.js';
import { buildMentions } from './mentions.js';
import { MessageProcessor } from './message-processor.js';
import { PendingActions } from './pending-actions.js';
import type { WebSocketFactory } from '@newio/agent-sdk';
import type { WsConnectionStatus } from '@newio/agent-sdk';
import type { ApprovalHandle } from '@newio/agent-sdk';
import type { StorePersistence } from './store.js';
import type {
  ActivityStatus,
  ActionRequest,
  ActionResponse,
  ContactRecord,
  GetMeResponse,
  GetUserByUsernameResponse,
  ListMessagesResponse,
  LoadSessionMemoryResponse,
  MemberRecord,
  Mentions,
  MemoryScope,
  MemoryScopeData,
  MessageContent,
  ConversationType,
  ReportAgentInfoRequest,
  SearchUsersResponse,
  SessionType,
} from '@newio/agent-sdk';
import type {
  IncomingMessage,
  OwnerInfo,
  ContactSummary,
  ConversationSummary,
  ConversationInfo,
  PaginatedConversations,
  PaginatedMembers,
  FriendRequestSummary,
  MemberSummary,
  AppEventHandlers,
  NewioIdentity,
  NewioTokens,
  CronJobDef,
  LiveSessionInfoHandler,
  CancelSessionHandler,
  CompactSessionHandler,
  StartSessionHandler,
  UpdateMemoryHandler,
  RotateSessionHandler,
  MessageNewHandler,
  MessageUpdatedHandler,
  MessageDeletedHandler,
  ContactEventHandler,
  CronTriggeredHandler,
  CronScheduledHandler,
  CronCancelledHandler,
  ConversationMemberUpdatedHandler,
  SessionUpdatedHandler,
  ConversationControls,
} from './types.js';
import type { NewioAppForAgent } from '../types.js';
import type { NewioAppForMcp } from '../mcp/types.js';

const log = getLogger('newio-app');

// Re-export types and helpers that are part of the public API
export type {
  IncomingMessage,
  SenderRelationship,
  OwnerInfo,
  ContactSummary,
  ConversationSummary,
  FriendRequestSummary,
  MemberSummary,
  MessageHandler,
  AppEventHandlers,
  ContactEventInfo,
  ContactEvent,
  ContactEventType,
  CronJobDef,
  CronTriggerEvent,
  NewioIdentity,
  NewioTokens,
} from './types.js';
export type { StorePersistence } from './store.js';
export { NewioAppStore } from './store.js';

/** Default Newio REST API base URL (production). */
export const NEWIO_API_BASE_URL = 'https://api.newio.app';

/** Default Newio WebSocket URL (production). */
export const NEWIO_WS_URL = 'wss://ws.newio.app';

/** Newio client configuration (API + WebSocket URLs). */
export interface NewioClientConfig {
  readonly apiBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * Get Newio client configuration.
 *
 * Returns production URLs by default. Override with explicit parameters
 * or environment variables (`NEWIO_API_BASE_URL`, `NEWIO_WS_BASE_URL`).
 *
 * Priority: explicit params > env vars > prod defaults.
 */
export function getClientConfig(overrides?: Partial<NewioClientConfig>): NewioClientConfig {
  const envApi = typeof process !== 'undefined' ? process.env['NEWIO_API_BASE_URL'] : undefined;
  const envWs = typeof process !== 'undefined' ? process.env['NEWIO_WS_BASE_URL'] : undefined;
  return {
    apiBaseUrl: overrides?.apiBaseUrl ?? envApi ?? NEWIO_API_BASE_URL,
    wsBaseUrl: overrides?.wsBaseUrl ?? envWs ?? NEWIO_WS_URL,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link NewioApp.create}. */
export interface NewioAppCreateOptions {
  /** Existing agent ID (for login flow). */
  readonly agentId?: string;
  /** Existing username (for login-by-username flow). */
  readonly username?: string;
  /** Agent display name (used during registration). */
  readonly name: string;
  /** REST API base URL. */
  readonly apiBaseUrl: string;
  /** WebSocket URL. */
  readonly wsUrl: string;
  /** Factory to create WebSocket instances (e.g., `(url) => new WebSocket(url)`). */
  readonly wsFactory: WebSocketFactory;
  /** Pre-existing tokens to attempt reuse. */
  readonly tokens?: NewioTokens;
  /** Called when the approval URL is available (user must open it). */
  readonly onApprovalUrl?: (url: string) => void;
  /** Called each time a poll request is made during approval. */
  readonly onPollAttempt?: () => void;
  /** Called when new tokens are obtained. */
  readonly onTokens?: (tokens: NewioTokens) => void;
  /** Abort signal to cancel the auth flow. */
  readonly signal?: AbortSignal;
  /** Directory for downloaded attachments (default: `./newio-downloads`). */
  readonly downloadDir?: string;
  /** Optional persistence layer for durable storage. */
  readonly persistence?: StorePersistence;
  /** Override the proactive WebSocket reconnect interval in ms (default: 1h50m). */
  readonly proactiveReconnectMs?: number;
}

// ---------------------------------------------------------------------------
// NewioApp
// ---------------------------------------------------------------------------

/**
 * High-level Newio agent client.
 *
 * Wraps {@link AuthManager}, {@link NewioClient}, {@link NewioWebSocket},
 * and {@link NewioAppStore} into a single object with username resolution,
 * system prompt generation, and a clean event interface.
 */
export class NewioApp implements NewioAppForAgent, NewioAppForMcp {
  readonly identity: NewioIdentity;
  readonly client: NewioClient;
  readonly auth: AuthManager;
  readonly store: NewioAppStore;
  readonly pendingActions: PendingActions;
  private readonly ws: NewioWebSocket;
  private readonly downloadDir: string;
  private readonly activityThrottle: ActivityThrottle;
  private readonly cronScheduler: CronScheduler;

  private readonly eventHandlers: Partial<AppEventHandlers> = {};
  private liveSessionInfoHandler: LiveSessionInfoHandler = (request) => ({
    sessionType: request.sessionType,
    externalReferenceId: request.externalReferenceId,
    isLive: false,
    availableModels: [],
    availableModes: [],
    canCancel: false,
    canCompact: false,
  });
  private cancelSessionHandler: CancelSessionHandler = () =>
    Promise.resolve({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
  private compactSessionHandler: CompactSessionHandler = () =>
    Promise.resolve({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
  private startSessionHandler: StartSessionHandler = () =>
    Promise.resolve({ success: false, error: 'No handler registered' });
  private updateMemoryHandler: UpdateMemoryHandler = () =>
    Promise.resolve({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });
  private rotateSessionHandler: RotateSessionHandler = () =>
    Promise.resolve({ success: false, errorCode: 'not_implemented', error: 'No handler registered' });

  private constructor(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    store: NewioAppStore,
    downloadDir?: string,
  ) {
    this.identity = identity;
    this.auth = auth;
    this.client = client;
    this.ws = ws;
    this.store = store;
    this.pendingActions = new PendingActions();
    this.downloadDir = downloadDir ?? join(homedir(), 'newio-downloads');
    this.activityThrottle = new ActivityThrottle((conversationId, status) => {
      this.ws.sendActivity(conversationId, status);
    });
    this.cronScheduler = new CronScheduler({
      onTriggered: (event) => this.eventHandlers['cron.triggered']?.(event),
      onScheduled: (def) => this.eventHandlers['cron.scheduled']?.(def),
      onCancelled: (cronId) => this.eventHandlers['cron.cancelled']?.(cronId),
    });
  }

  /**
   * Create a NewioApp from pre-initialized components (for testing).
   * Loads contacts/conversations and wires WebSocket events.
   */
  static createFromComponents(
    identity: NewioIdentity,
    auth: AuthManager,
    client: NewioClient,
    ws: NewioWebSocket,
    store?: NewioAppStore,
  ): NewioApp {
    const app = new NewioApp(identity, auth, client, ws, store ?? new NewioAppStore());
    const processor = new MessageProcessor(
      app.store,
      client,
      identity,
      () => app.eventHandlers['message.new'],
      () => app.eventHandlers['message.updated'],
      () => app.eventHandlers['message.deleted'],
      app.pendingActions,
    );
    wireEvents(
      ws,
      app.store,
      client,
      identity,
      () => app.eventHandlers,
      processor,
      () => app._getSignalHandlers(),
    );
    return app;
  }

  /**
   * Create and initialize a NewioApp.
   *
   * Handles auth (register or login), profile sync, WebSocket connect,
   * and initial data loading. Returns a fully ready app instance.
   */
  static async create(opts: NewioAppCreateOptions): Promise<NewioApp> {
    const auth = new AuthManager(opts.apiBaseUrl, {
      onTokensChanged: (accessToken, refreshToken) => {
        opts.onTokens?.({ accessToken, refreshToken });
      },
    });

    // Authenticate
    if (opts.tokens) {
      log.info('Attempting token reuse...');
      auth.setTokens(opts.tokens.accessToken, opts.tokens.refreshToken);
      try {
        await auth.forceRefresh();
        log.info('Token reuse successful.');
      } catch {
        log.info('Token reuse failed — starting approval flow.');
        await doApprovalFlow(auth, opts);
      }
    } else {
      await doApprovalFlow(auth, opts);
    }

    // Notify caller of new tokens
    const accessToken = auth.getAccessToken();
    const refreshToken = auth.getRefreshToken();
    if (accessToken && refreshToken) {
      opts.onTokens?.({ accessToken, refreshToken });
    }

    // Create client, fetch profile
    const client = new NewioClient({ baseUrl: opts.apiBaseUrl, tokenProvider: auth.tokenProvider });
    log.info('Fetching agent profile...');
    const me = await client.getMe({});
    if (!me.username) {
      throw new Error('Agent account has no username. Registration may have failed.');
    }

    const identity: NewioIdentity = {
      userId: me.userId,
      username: me.username,
      displayName: me.displayName,
      avatarUrl: me.avatarUrl,
      ownerId: me.ownerId,
    };
    log.info(`Authenticated as @${identity.username} (${identity.userId}).`);

    // Connect WebSocket
    const ws = new NewioWebSocket({
      url: opts.wsUrl,
      tokenProvider: auth.tokenProvider,
      wsFactory: opts.wsFactory,
      proactiveReconnectMs: opts.proactiveReconnectMs,
    });
    await ws.connect();

    const store = new NewioAppStore(opts.persistence);
    const app = new NewioApp(identity, auth, client, ws, store, opts.downloadDir);
    const processor = new MessageProcessor(
      store,
      client,
      identity,
      () => app.eventHandlers['message.new'],
      () => app.eventHandlers['message.updated'],
      () => app.eventHandlers['message.deleted'],
      app.pendingActions,
    );
    wireEvents(
      ws,
      store,
      client,
      identity,
      () => app.eventHandlers,
      processor,
      () => app._getSignalHandlers(),
    );
    return app;
  }

  async init(): Promise<void> {
    log.info('Loading initial data (contacts, conversations, requests)...');
    await Promise.all([this.loadContacts(), this.loadConversations(), this.loadIncomingRequests()]);
    log.info(
      `Init complete. ${this.store.getAllContacts().length} contacts, ${this.store.getAllConversations().length} conversations, ${this.store.getIncomingRequests().length} incoming requests.`,
    );
  }

  /** Disconnect WebSocket, cancel cron jobs, and dispose auth. */
  dispose(): void {
    log.info('Disposing NewioApp...');
    this.activityThrottle.dispose();
    this.pendingActions.dispose();
    this.cronScheduler.dispose();
    this.ws.disconnect();
    this.auth.dispose();
  }

  /** Get the live WebSocket connection health (connected / reconnecting / disconnected / connecting). */
  getConnectionStatus(): WsConnectionStatus {
    return this.ws.getConnectionStatus();
  }

  /** Register a listener for WebSocket disconnection. */
  onDisconnect(handler: () => void): void {
    this.ws.onStateChange((state) => {
      if (state === 'disconnected') {
        handler();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Event handler
  // ---------------------------------------------------------------------------

  /** Register a handler for an app-level event. */
  on<K extends keyof AppEventHandlers>(event: K, handler: AppEventHandlers[K]): void {
    this.eventHandlers[event] = handler;
  }

  onMessageNew(handler: MessageNewHandler): void {
    this.on('message.new', handler);
  }
  onMessageUpdated(handler: MessageUpdatedHandler): void {
    this.on('message.updated', handler);
  }
  onMessageDeleted(handler: MessageDeletedHandler): void {
    this.on('message.deleted', handler);
  }
  onContactEvent(handler: ContactEventHandler): void {
    this.on('contact.event', handler);
  }
  onCronTriggered(handler: CronTriggeredHandler): void {
    this.on('cron.triggered', handler);
  }
  onCronScheduled(handler: CronScheduledHandler): void {
    this.on('cron.scheduled', handler);
  }
  onCronCancelled(handler: CronCancelledHandler): void {
    this.on('cron.cancelled', handler);
  }
  onConversationMemberUpdated(handler: ConversationMemberUpdatedHandler): void {
    this.on('conversation.member_updated', handler);
  }
  onSessionUpdated(handler: SessionUpdatedHandler): void {
    this.on('session.updated', handler);
  }

  // ---------------------------------------------------------------------------
  // Capabilities — remote control
  // ---------------------------------------------------------------------------

  /** Register a handler for when the owner requests live session info. */
  onLiveSessionInfo(handler: LiveSessionInfoHandler): void {
    this.liveSessionInfoHandler = handler;
  }

  /** Register a handler for when the owner cancels a session. */
  onCancelSession(handler: CancelSessionHandler): void {
    this.cancelSessionHandler = handler;
  }

  /** Register a handler for when the owner compacts a session. */
  onCompactSession(handler: CompactSessionHandler): void {
    this.compactSessionHandler = handler;
  }

  /** Register a handler for when the owner starts an idle session. */
  onStartSession(handler: StartSessionHandler): void {
    this.startSessionHandler = handler;
  }

  /** Register a handler for when the owner requests a mid-session memory update. */
  onUpdateMemory(handler: UpdateMemoryHandler): void {
    this.updateMemoryHandler = handler;
  }

  /** Register a handler for when the owner rotates the current session (ends it, next event starts fresh). */
  onRotateSession(handler: RotateSessionHandler): void {
    this.rotateSessionHandler = handler;
  }

  /** @internal Returns signal handlers for wireEvents. */
  _getSignalHandlers(): {
    liveSessionInfo: LiveSessionInfoHandler;
    cancelSession: CancelSessionHandler;
    compactSession: CompactSessionHandler;
    startSession: StartSessionHandler;
    updateMemory: UpdateMemoryHandler;
    rotateSession: RotateSessionHandler;
  } {
    return {
      liveSessionInfo: this.liveSessionInfoHandler,
      cancelSession: this.cancelSessionHandler,
      compactSession: this.compactSessionHandler,
      startSession: this.startSessionHandler,
      updateMemory: this.updateMemoryHandler,
      rotateSession: this.rotateSessionHandler,
    };
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** Send a message to a conversation, with optional attachments, metadata, and visibility restrictions. */
  async sendMessage(
    conversationId: string,
    text?: string,
    opts?: {
      filePaths?: readonly string[];
      metadata?: Record<string, unknown>;
      visibleTo?: readonly string[];
    },
  ): Promise<void> {
    if (!text && (!opts?.filePaths || opts.filePaths.length === 0)) {
      throw new Error('Message must have text or attachments');
    }
    log.debug(
      `Sending message to ${conversationId} (${text?.length ?? 0} chars, ${opts?.filePaths?.length ?? 0} attachments)`,
    );
    const attachments = opts?.filePaths ? await uploadFiles(this.client, opts.filePaths) : undefined;
    const mentions = text ? await this.buildMentions(conversationId, text) : undefined;
    const content: MessageContent = {
      text: text || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      ...(mentions ? { mentions } : {}),
      ...(opts?.metadata && { metadata: opts.metadata }),
    };
    await this.client.sendMessage({
      conversationId,
      content,
      ...(opts?.visibleTo && { visibleTo: [...opts.visibleTo] }),
    });
  }

  /**
   * Send an action request message and wait for the recipient's response.
   *
   * Registers a pending promise keyed by `action.requestId`. The promise resolves
   * when a `message.new` event arrives with a matching `content.response.requestId`,
   * or rejects with {@link ActionTimeoutError} if `timeoutMs` elapses.
   */
  async sendActionRequest(
    conversationId: string,
    action: ActionRequest,
    text?: string,
    visibleTo?: readonly string[],
    timeoutMs?: number,
  ): Promise<ActionResponse> {
    const timeout = timeoutMs ?? 5 * 60 * 1000;
    log.info(`Sending action request ${action.requestId} (type=${action.type}) to ${conversationId}`);
    const promise = this.pendingActions.create(action.requestId, timeout);
    await this.client.sendMessage({
      conversationId,
      content: { action, text },
      visibleTo,
    });
    return promise;
  }

  /**
   * Set the agent's activity status for a conversation.
   * Broadcasts typing/thinking indicators to other participants via WebSocket.
   * Throttled: duplicate statuses are suppressed, heartbeats keep the receiver alive.
   */
  setStatus(status: ActivityStatus, conversationId?: string): void {
    // log.debug('setStatus called', { status, conversationId });
    if (conversationId) {
      this.activityThrottle.update(conversationId, status);
    }
  }

  // ---------------------------------------------------------------------------
  // Cron scheduling
  // ---------------------------------------------------------------------------

  /** Schedule a cron job. Fires `cron.triggered` on each tick (recurring) or once (one-shot). */
  scheduleCron(def: CronJobDef): void {
    this.cronScheduler.schedule(def);
  }

  /** Cancel a scheduled cron job within a session. Returns 'success' | 'not_found'. */
  cancelCron(cronId: string): 'success' | 'not_found' {
    return this.cronScheduler.cancel(cronId);
  }

  /** List active cron jobs for a session. */
  listCrons(): readonly CronJobDef[] {
    return this.cronScheduler.list();
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /** Send a DM to the agent's owner. No-op if ownerId is not set. */
  async dmOwner(text: string, filePaths?: readonly string[]): Promise<void> {
    if (!this.identity.ownerId) {
      log.warn('dmOwner called but no ownerId set');
      return;
    }
    log.debug(`Sending DM to owner ${this.identity.ownerId}`);
    const conversationId = await this.findOrCreateDm(this.identity.ownerId);
    await this.sendMessage(conversationId, text, filePaths ? { filePaths } : undefined);
  }

  /** Get or create the DM conversation with the agent's owner. Throws if no owner. */
  async getOrCreateOwnerDmConversationId(): Promise<string> {
    if (!this.identity.ownerId) {
      throw new Error('Agent has no owner');
    }
    return this.findOrCreateDm(this.identity.ownerId);
  }

  /** Send a DM by username. Creates the DM conversation if it doesn't exist. */
  async sendDm(username: string, text: string, filePaths?: readonly string[]): Promise<void> {
    log.debug(`Sending DM to @${username}`);
    const userId = await this.resolveUsername(username);
    const conversationId = await this.findOrCreateDm(userId);
    await this.sendMessage(conversationId, text, filePaths ? { filePaths } : undefined);
  }

  /** Get or create a DM conversation with a user by username. Returns the conversationId. */
  async getOrCreateDm(username: string): Promise<string> {
    const userId = await this.resolveUsername(username);
    return this.findOrCreateDm(userId);
  }

  // ---------------------------------------------------------------------------
  // Contacts — high-level (username-based)
  // ---------------------------------------------------------------------------

  /** Send a friend request by username. */
  async sendFriendRequestByUsername(username: string, note?: string): Promise<void> {
    log.info(`Sending friend request to @${username}`);
    const userId = await this.resolveUsername(username);
    await this.client.sendFriendRequest({ contactId: userId, note });
  }

  /** List incoming friend requests as agent-friendly summaries. */
  listIncomingFriendRequests(): readonly FriendRequestSummary[] {
    // Backfill from API into store cache
    return this.store.getIncomingRequests().map((r) => ({
      username: r.friendUsername,
      displayName: r.friendDisplayName,
      accountType: r.friendAccountType,
      note: r.note,
    }));
  }

  /** Accept an incoming friend request by the sender's username. */
  async acceptFriendRequestByUsername(username: string): Promise<void> {
    log.info(`Accepting friend request from @${username}`);
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.acceptFriendRequest({ requestId: request.userId });
    this.store.removeIncomingRequest(request.userId);
    this.store.indexContact(request);
  }

  /** Reject an incoming friend request by the sender's username. */
  async rejectFriendRequestByUsername(username: string): Promise<void> {
    log.info(`Rejecting friend request from @${username}`);
    const request = await this.findIncomingRequestByUsername(username);
    await this.client.rejectFriendRequest({ requestId: request.userId });
    this.store.removeIncomingRequest(request.userId);
  }

  /** Remove a friend by username. */
  async removeFriendByUsername(username: string): Promise<void> {
    log.info(`Removing friend @${username}`);
    const userId = await this.resolveUsername(username);
    await this.client.removeFriend({ userId });
    this.store.removeContact(userId);
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  /**
   * Download a message attachment to a local directory.
   * Returns the local file path.
   */
  async downloadAttachment(conversationId: string, s3Key: string, fileName: string): Promise<string> {
    log.debug(`Downloading attachment ${fileName} from ${conversationId}`);
    return downloadAttachment(this.client, this.downloadDir, this.identity.username, conversationId, s3Key, fileName);
  }

  // ---------------------------------------------------------------------------
  // Lookups (delegate to store, fallback to API)
  // ---------------------------------------------------------------------------

  /** Resolve a username to a userId. Checks contact cache first, then API. */
  async resolveUsername(username: string): Promise<string> {
    const cached = this.store.resolveUsernameFromCache(username);
    if (cached) {
      log.debug(`Resolved @${username} → ${cached} (cache)`);
      return cached;
    }
    const user = await this.client.getUserByUsername({ username });
    log.debug(`Resolved @${username} → ${user.userId} (API)`);
    return user.userId;
  }

  /** Check if a username is in the contact (friend) list. */
  isContact(username: string): boolean {
    const contactId = this.store.resolveUsernameFromCache(username);
    return contactId !== undefined && this.store.isContact(contactId);
  }

  /** Get a contact summary by username. */
  getContact(username: string): ContactSummary | undefined {
    const contactId = this.store.resolveUsernameFromCache(username);
    if (!contactId) {
      return undefined;
    }
    const c = this.store.getContact(contactId);
    if (!c) {
      return undefined;
    }
    return this.toContactSummary(c);
  }

  /** Get a conversation by ID. */
  getConversation(conversationId: string): ConversationSummary | undefined {
    const c = this.store.getConversation(conversationId);
    if (c) {
      return {
        conversationId: c.conversationId,
        type: c.type,
        name: c.name,
        lastMessageAt: c.lastMessageAt,
      };
    }
    return undefined;
  }

  /** Get all conversations as agent-friendly summaries. */
  getAllConversations(): ConversationSummary[] {
    return this.store.getAllConversations().map((c) => ({
      conversationId: c.conversationId,
      type: c.type,
      name: c.name,
      lastMessageAt: c.lastMessageAt,
    }));
  }

  /** Get all contacts as agent-friendly summaries. */
  getAllContacts(): ContactSummary[] {
    return this.store.getAllContacts().map((c) => this.toContactSummary(c));
  }

  /** Get recent cached messages for a conversation, sorted oldest-first. */
  getRecentMessages(conversationId: string): readonly IncomingMessage[] {
    return this.store.getRecentMessages(conversationId);
  }

  private toContactSummary(c: ContactRecord): ContactSummary {
    const owner = c.friendAccountType === 'agent' && c.ownerId ? this.store.getOwnerProfile(c.ownerId) : undefined;
    return {
      username: c.friendUsername,
      displayName: c.friendDisplayName,
      accountType: c.friendAccountType,
      ...(owner?.username ? { ownerUsername: owner.username } : {}),
      ...(owner?.displayName ? { ownerDisplayName: owner.displayName } : {}),
    };
  }

  /** Get members of a conversation as agent-friendly summaries. */
  async getMembers(conversationId: string): Promise<MemberSummary[]> {
    log.debug(`Getting members for ${conversationId}`);
    const members = await this.getMembersRaw(conversationId);
    return members.map((m) => {
      const contact = this.store.getContact(m.userId);
      const isSelf = m.userId === this.identity.userId;
      return {
        username: isSelf ? this.identity.username : contact?.friendUsername,
        displayName: isSelf ? this.identity.displayName : contact?.friendDisplayName,
        accountType: m.accountType,
        role: m.role,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Client-facing methods (used by MCP tools — avoid direct client access)
  // ---------------------------------------------------------------------------
  /* v8 ignore start */

  /** Paginate over conversations. */
  listConversations(limit?: number, afterConversationId?: string): PaginatedConversations {
    const all = this.getAllConversations();
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterConversationId) {
      const idx = all.findIndex((c) => c.conversationId === afterConversationId);
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = all.slice(startIdx, startIdx + pageSize);
    const hasMore = startIdx + pageSize < all.length;
    return {
      conversations: page.map((c) => ({
        conversationId: c.conversationId,
        type: c.type,
        ...(c.name ? { name: c.name } : {}),
      })),
      hasMore,
    };
  }

  /** Paginate over conversation members. */
  async listConversationMembers(
    conversationId: string,
    limit?: number,
    afterUsername?: string,
  ): Promise<PaginatedMembers> {
    const conv = await this.client.getConversation({ conversationId });
    const allMembers = conv.members.map((m) => ({
      username: m.username ?? m.userId,
      displayName: m.displayName ?? m.username ?? m.userId,
      accountType: m.accountType,
      role: m.role,
    }));
    const pageSize = limit ?? 20;
    let startIdx = 0;
    if (afterUsername) {
      const idx = allMembers.findIndex((m) => m.username.toLowerCase() === afterUsername.toLowerCase());
      if (idx >= 0) {
        startIdx = idx + 1;
      }
    }
    const page = allMembers.slice(startIdx, startIdx + pageSize);
    const hasMore = startIdx + pageSize < allMembers.length;
    return { members: page, hasMore };
  }

  /** Get conversation info with admins list. Reads from cache if available, otherwise fetches from API. */
  async getConversationInfo(conversationId: string): Promise<ConversationInfo> {
    if (!this.store.getConversation(conversationId)) {
      await loadConversation(this.store, this.client, this.identity, conversationId);
    }
    const conv = this.store.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Failed to load conversation ${conversationId}`);
    }
    const members = await this.getMembersRaw(conversationId);
    const admins = members.filter((m) => m.role === 'admin').map((m) => m.username ?? m.userId);
    return {
      conversationId: conv.conversationId,
      type: conv.type,
      ...(conv.name ? { name: conv.name } : {}),
      admins,
    };
  }

  /** Check if a user is a member of a conversation. */
  async checkIsMember(conversationId: string, username: string): Promise<boolean> {
    const members = await this.getMembersRaw(conversationId);
    return members.some((m) => m.username?.toLowerCase() === username.toLowerCase());
  }

  /** Add members to a conversation by usernames. */
  async addMembersByUsername(conversationId: string, usernames: readonly string[]): Promise<void> {
    const memberIds = await Promise.all(usernames.map((u) => this.resolveUsername(u)));
    await this.client.addMembers({ conversationId, memberIds });
  }

  /** Remove a member from a conversation by username. */
  async removeMemberByUsername(conversationId: string, username: string): Promise<void> {
    const userId = await this.resolveUsername(username);
    await this.client.removeMember({ conversationId, userId });
  }

  /** List messages in a conversation (paginated, newest first). */
  async listMessages(conversationId: string, limit?: number, beforeMessageId?: string): Promise<ListMessagesResponse> {
    return this.client.listMessages({ conversationId, limit: limit ?? 20, beforeMessageId });
  }

  /** Get this agent's own profile. */
  async getMe(): Promise<GetMeResponse> {
    return this.client.getMe({});
  }

  /** Search users by display name or username (partial match). */
  async searchUsers(query: string): Promise<SearchUsersResponse> {
    return this.client.searchUsers({ query });
  }

  /** Get a user's public profile by exact username. */
  async getUserByUsername(username: string): Promise<GetUserByUsernameResponse> {
    return this.client.getUserByUsername({ username });
  }

  // ---------------------------------------------------------------------------
  // Agent instance methods (used by agent-engine — satisfy NewioAppForAgent)
  // ---------------------------------------------------------------------------

  /** Get conversation type and name from cache. */
  /** Check if a userId is a member of a conversation. Fetches from API if not cached. */
  async isConversationMember(conversationId: string, userId: string): Promise<boolean> {
    const members = await this.getMembersRaw(conversationId);
    return members.some((m) => m.userId === userId);
  }

  /** Get all member userIds for a conversation. Fetches from API if not cached. */
  async getConversationMemberIds(conversationId: string): Promise<readonly string[]> {
    const members = await this.getMembersRaw(conversationId);
    return members.map((m) => m.userId);
  }

  /** Get display info for a specific member. Fetches from API if not cached. */
  async getMemberInfo(
    conversationId: string,
    userId: string,
  ): Promise<{ username?: string; displayName?: string } | undefined> {
    const members = await this.getMembersRaw(conversationId);
    const member = members.find((m) => m.userId === userId);
    if (!member) {
      return undefined;
    }
    return { username: member.username, displayName: member.displayName };
  }

  /** Get self member's conversation controls (role, canSend, acpModel, etc.). Loads from backend if not cached. */
  async getConversationControls(conversationId: string): Promise<ConversationControls | undefined> {
    const cached = this.store.getConversationControls(conversationId);
    if (cached) {
      return cached;
    }
    // Load from backend on demand
    await loadConversation(this.store, this.client, this.identity, conversationId);
    return this.store.getConversationControls(conversationId);
  }

  /** Load session memory (delegates agentId). */
  async loadSessionMemory(
    conversationId?: string,
    participantIds?: readonly string[],
  ): Promise<LoadSessionMemoryResponse> {
    return this.client.loadSessionMemory({
      agentId: this.identity.userId,
      conversationId,
      participantIds: participantIds ? [...participantIds] : undefined,
    });
  }

  /** Get memory for a specific scope. */
  async getMemoryScope(scope: string, scopeId: string): Promise<MemoryScopeData> {
    const result = await this.client.getMemory({
      agentId: this.identity.userId,
      scope: scope as MemoryScope,
      scopeId,
    });
    return result.data;
  }

  /** Get the handoff note for a conversation. */
  async getHandoffNote(conversationId: string): Promise<string | null> {
    try {
      const result = await this.client.getHandoffNote({ agentId: this.identity.userId, conversationId });
      return result.text;
    } catch {
      return null;
    }
  }

  /** Put a handoff note for a conversation. */
  async putHandoffNote(conversationId: string, text: string): Promise<void> {
    await this.client.putHandoffNote({ agentId: this.identity.userId, conversationId, text });
  }

  /** Report agent info to the backend. */
  async reportAgentInfo(request: ReportAgentInfoRequest): Promise<void> {
    await this.client.reportAgentInfo(request);
  }

  /** Update agent member config (acpModel/acpMode) on the backend. */
  async updateAgentMemberConfig(
    conversationId: string,
    config: { acpModel?: string | null; acpMode?: string | null },
  ): Promise<void> {
    await this.client.updateAgentMember({
      conversationId,
      targetUserId: this.identity.userId,
      acpModel: config.acpModel,
      acpMode: config.acpMode,
    });
  }

  /** Send a context window update signal to the owner. */
  async sendContextWindowUpdate(
    targetUserId: string,
    sessionType: SessionType,
    externalReferenceId: string,
    contextWindowSize: number,
    contextWindowUsed: number,
  ): Promise<void> {
    await this.client.sendSignal({
      targetUserId,
      requestId: crypto.randomUUID(),
      intent: 'notification',
      type: 'context_window_update',
      payload: {
        sessionType,
        externalReferenceId,
        contextWindowSize,
        contextWindowUsed,
      },
    });
  }

  /* v8 ignore stop */

  // ---------------------------------------------------------------------------
  // Conversation helpers
  // ---------------------------------------------------------------------------

  /** Find an existing DM with a user, or create one. */
  private async findOrCreateDm(userId: string): Promise<string> {
    log.debug(`Finding or creating DM with ${userId}`);
    for (const conv of this.store.getAllConversations()) {
      if (conv.type === 'dm') {
        const members = await this.getMembersRaw(conv.conversationId);
        if (members.some((m) => m.userId === userId)) {
          return conv.conversationId;
        }
      }
    }
    const resp = await this.client.createConversation({
      type: 'dm' as ConversationType,
      memberIds: [userId],
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      description: resp.description,
      avatarUrl: resp.avatarUrl,
      disabledAt: resp.disabledAt,
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
      settings: resp.settings,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a group conversation. If `sessionId` is provided, the agent joins under that session. */
  async createGroup(name: string, memberUsernames: readonly string[], sessionId?: string): Promise<string> {
    const filtered = memberUsernames.filter((u) => u.toLowerCase() !== this.identity.username.toLowerCase());
    log.info(`Creating group "${name}" with ${filtered.length} members`);
    const memberIds = await Promise.all(filtered.map((u) => this.resolveUsername(u)));
    const agentSettings = sessionId ? { [this.identity.userId]: { sessionId } } : undefined;
    const resp = await this.client.createConversation({
      type: 'group',
      name,
      memberIds,
      agentSettings,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      description: resp.description,
      avatarUrl: resp.avatarUrl,
      disabledAt: resp.disabledAt,
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
      settings: resp.settings,
      lastMessageAt: resp.lastMessageAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Create a work session (temp_group) conversation. If `sessionId` is provided, the agent joins under that session. */
  async createWorkSession(name: string, memberUsernames: readonly string[]): Promise<string> {
    const filtered = memberUsernames.filter((u) => u.toLowerCase() !== this.identity.username.toLowerCase());
    log.info(`Creating work session "${name}" with ${filtered.length} members`);
    const memberIds = await Promise.all(filtered.map((u) => this.resolveUsername(u)));
    const resp = await this.client.createConversation({
      type: 'temp_group',
      name,
      memberIds,
    });
    this.store.setConversation({
      conversationId: resp.conversationId,
      type: resp.type,
      name: resp.name,
      description: resp.description,
      avatarUrl: resp.avatarUrl,
      createdBy: resp.createdBy,
      createdAt: resp.createdAt,
      updatedAt: resp.updatedAt,
      settings: resp.settings,
      lastMessageAt: resp.lastMessageAt,
      disabledAt: resp.disabledAt,
    });
    this.store.setMembers(resp.conversationId, resp.members);
    return resp.conversationId;
  }

  /** Get the owner's username and display name. Throws if owner is not in contacts. */
  getOwnerInfo(): OwnerInfo {
    const owner = this.identity.ownerId ? this.store.getContact(this.identity.ownerId) : undefined;
    if (!owner) {
      throw new Error('Owner not found in contacts');
    }
    if (!owner.friendUsername || !owner.friendDisplayName) {
      throw new Error('Owner is missing username or display name');
    }
    return {
      username: owner.friendUsername,
      displayName: owner.friendDisplayName,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — data loading
  // ---------------------------------------------------------------------------

  private async loadContacts(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listFriends({ cursor, limit: 100 });
      for (const contact of resp.contacts) {
        this.store.indexContact(contact);
      }
      cursor = resp.cursor;
    } while (cursor);

    await this.resolveOwnerProfiles();
  }

  /** Batch-fetch owner profiles for agent contacts whose owners aren't in the contact cache. */
  private async resolveOwnerProfiles(): Promise<void> {
    const missingOwnerIds: string[] = [];
    for (const contact of this.store.getAllContacts()) {
      if (contact.friendAccountType !== 'agent' || !contact.ownerId) {
        continue;
      }
      const ownerId = contact.ownerId;
      // Try resolving from contact cache first
      const cached = this.store.getContact(ownerId);
      if (cached) {
        this.store.setOwnerProfile(ownerId, { username: cached.friendUsername, displayName: cached.friendDisplayName });
      } else if (!this.store.getOwnerProfile(ownerId)) {
        missingOwnerIds.push(ownerId);
      }
    }

    if (missingOwnerIds.length === 0) {
      return;
    }

    const unique = [...new Set(missingOwnerIds)];
    // Batch in chunks of 25 (API limit)
    for (let i = 0; i < unique.length; i += 25) {
      const batch = unique.slice(i, i + 25);
      const resp = await this.client.getUserSummaries({ userIds: batch });
      for (const user of resp.users) {
        this.store.setOwnerProfile(user.userId, { username: user.username, displayName: user.displayName });
      }
    }
  }

  private async loadConversations(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listConversations({ cursor, limit: 100 });
      for (const conv of resp.conversations) {
        this.store.setConversation({
          conversationId: conv.conversationId,
          type: conv.type,
          name: conv.name,
          description: conv.description,
          avatarUrl: conv.avatarUrl,
          createdBy: conv.createdBy,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          disabledAt: conv.disabledAt,
          settings: conv.settings,
          lastMessageAt: conv.lastMessageAt,
        });

        this.store.setConversationControls(conv.conversationId, {
          role: conv.role,
          canSend: conv.canSend,
          notifyLevel: conv.notifyLevel,
          acpMode: conv.acpMode,
          acpModel: conv.acpModel,
          showThoughts: conv.showThoughts,
          showToolCalls: conv.showToolCalls,
        });
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  private async loadIncomingRequests(): Promise<void> {
    let cursor: string | undefined;
    do {
      const resp = await this.client.listIncomingRequests({ cursor, limit: 100 });
      for (const r of resp.contacts) {
        this.store.addIncomingRequest(r);
      }
      cursor = resp.cursor;
    } while (cursor);
  }

  // ---------------------------------------------------------------------------
  // Internal — data fetching
  // ---------------------------------------------------------------------------

  private async getMembersRaw(conversationId: string): Promise<MemberRecord[]> {
    if (!this.store.getMembers(conversationId)) {
      await loadConversation(this.store, this.client, this.identity, conversationId);
    }
    return [...(this.store.getMembers(conversationId)?.values() ?? [])];
  }

  private async findIncomingRequestByUsername(username: string): Promise<ContactRecord> {
    // Try store cache first
    let match = this.store.findIncomingRequestByUsername(username);
    if (match) {
      return match;
    }
    // Backfill from API
    await this.loadIncomingRequests();
    match = this.store.findIncomingRequestByUsername(username);
    if (!match) {
      throw new Error(`No incoming friend request from @${username}`);
    }
    return match;
  }

  /** Parse @username, @everyone, @here from text and resolve to a Mentions object. */
  private async buildMentions(conversationId: string, text: string): Promise<Mentions | undefined> {
    const members = await this.getMembersRaw(conversationId);
    return buildMentions(text, members);
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  /** Get the agent's global memory. */
  async getGlobalMemory(): Promise<MemoryScopeData> {
    const result = await this.client.getMemory({ agentId: this.identity.userId, scope: 'global', scopeId: '_' });
    return result.data;
  }

  /** Get memory about a specific user (by username). */
  async getContactMemory(username: string): Promise<MemoryScopeData> {
    const userId = await this.resolveUsername(username);
    const result = await this.client.getMemory({ agentId: this.identity.userId, scope: 'user', scopeId: userId });
    return result.data;
  }

  /** Get memory about a specific conversation. */
  async getConversationMemory(conversationId: string): Promise<MemoryScopeData> {
    const result = await this.client.getMemory({
      agentId: this.identity.userId,
      scope: 'conversation',
      scopeId: conversationId,
    });
    return result.data;
  }

  /** Add a memory fact. Scope is inferred: username → user, conversationId → conversation, neither → global. */
  async addMemory(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const { scope, scopeId } = await this.resolveMemoryScope(opts?.username, opts?.conversationId);
    await this.client.batchUpdateMemory({
      agentId: this.identity.userId,
      operations: [{ op: 'add', scope, scopeId, text }],
    });
  }

  /** Update an existing memory fact. */
  async updateMemory(
    factId: string,
    text: string,
    opts?: { username?: string; conversationId?: string },
  ): Promise<void> {
    const { scope, scopeId } = await this.resolveMemoryScope(opts?.username, opts?.conversationId);
    await this.client.batchUpdateMemory({
      agentId: this.identity.userId,
      operations: [{ op: 'update', scope, scopeId, factId, text }],
    });
  }

  /** Delete a memory fact. */
  async deleteMemory(factId: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const { scope, scopeId } = await this.resolveMemoryScope(opts?.username, opts?.conversationId);
    await this.client.batchUpdateMemory({
      agentId: this.identity.userId,
      operations: [{ op: 'delete', scope, scopeId, factId }],
    });
  }

  /** Update the summary for a memory scope. */
  async updateMemorySummary(text: string, opts?: { username?: string; conversationId?: string }): Promise<void> {
    const { scope, scopeId } = await this.resolveMemoryScope(opts?.username, opts?.conversationId);
    await this.client.batchUpdateMemory({
      agentId: this.identity.userId,
      operations: [{ op: 'update_summary', scope, scopeId, text }],
    });
  }

  private async resolveMemoryScope(
    username?: string,
    conversationId?: string,
  ): Promise<{ scope: MemoryScope; scopeId: string }> {
    if (username && conversationId) {
      throw new Error('Provide either username or conversationId, not both.');
    }
    if (username) {
      const userId = await this.resolveUsername(username);
      return { scope: 'user', scopeId: userId };
    }
    if (conversationId) {
      return { scope: 'conversation', scopeId: conversationId };
    }
    return { scope: 'global', scopeId: '_' };
  }
}

// ---------------------------------------------------------------------------
// Internal — approval flow helper
// ---------------------------------------------------------------------------

async function doApprovalFlow(
  auth: AuthManager,
  opts: {
    agentId?: string;
    username?: string;
    name: string;
    onApprovalUrl?: (url: string) => void;
    onPollAttempt?: () => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  let handle: ApprovalHandle;
  if (opts.agentId) {
    handle = await auth.login({ agentId: opts.agentId });
  } else if (opts.username) {
    handle = await auth.login({ username: opts.username });
  } else {
    handle = await auth.register({ name: opts.name });
  }
  opts.onApprovalUrl?.(handle.approvalUrl);
  await handle.waitForApproval({ signal: opts.signal, onPollAttempt: opts.onPollAttempt });
}
