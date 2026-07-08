import { AgentIdentity } from '../types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type IdGetter = () => string | undefined;

/**
 * Notification level an agent can set for itself. 'nothing' is intentionally omitted — an agent that
 * fully muted a conversation would never be prompted to turn it back on.
 */
export type McpNotifyLevel = 'all' | 'mentions';

/** Hook called before each MCP tool invocation. */
export type ToolCallHook = (toolName: string, args: Readonly<Record<string, unknown>>) => void;

export interface NewioMcpServerInterface {
  setCurrentConversationIdGetter(idGetter: IdGetter): void;
  /** Connect to a transport. */
  connect(transport: Transport): Promise<void>;
}
// ---------------------------------------------------------------------------
// Minimal structural types for the MCP ↔ App boundary
// ---------------------------------------------------------------------------

export interface McpMessageAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly s3Key: string;
}

export interface McpMessageRecord {
  readonly messageId: string;
  readonly senderId: string;
  readonly content: {
    readonly text?: string;
    readonly attachments?: readonly McpMessageAttachment[];
  };
  readonly createdAt: string;
}

export interface McpListMessagesResult {
  readonly messages: readonly McpMessageRecord[];
}

export interface McpUserProfile {
  readonly userId: string;
  readonly displayName?: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  readonly bio?: string;
  readonly accountType: string;
  readonly ownerId?: string;
}

export interface McpMemoryFact {
  readonly factId: string;
  readonly text: string;
}

export interface McpMemoryData {
  readonly summary: unknown;
  readonly facts: readonly McpMemoryFact[];
}

export interface McpContactSummary {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: string;
}

export interface McpFriendRequest {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: string;
  readonly note?: string;
}

export interface McpCronJobDef {
  readonly cronId: string;
  readonly expression: string;
  readonly label: string;
  readonly payload?: unknown;
}

export interface McpConversationListItem {
  readonly conversationId: string;
  readonly type: string;
  readonly name?: string;
}

export interface McpPaginatedConversations {
  readonly conversations: readonly McpConversationListItem[];
  readonly hasMore: boolean;
}

export interface McpMemberListItem {
  readonly username: string;
  readonly displayName: string;
  readonly accountType: string;
  readonly role: string;
}

export interface McpPaginatedMembers {
  readonly members: readonly McpMemberListItem[];
  readonly hasMore: boolean;
}

export interface McpConversationInfo {
  readonly conversationId: string;
  readonly type: string;
  readonly name?: string;
  readonly admins: readonly string[];
}

// ---------------------------------------------------------------------------
// NewioAppForMcp — the contract the MCP server requires from an app layer
// ---------------------------------------------------------------------------

/**
 * Interface that decouples the MCP server from the concrete NewioApp class.
 * Any implementation (real SDK, mock for evals) can satisfy this contract.
 */
export interface NewioAppForMcp {
  readonly identity: AgentIdentity;

  // ── Identity ──
  getOwnerInfo(): { readonly username: string; readonly displayName: string };

  // ── Contacts ──
  getAllContacts(): readonly McpContactSummary[];
  listIncomingFriendRequests(): readonly McpFriendRequest[];
  sendFriendRequestByUsername(username: string, note?: string): Promise<void>;
  acceptFriendRequestByUsername(username: string): Promise<void>;
  rejectFriendRequestByUsername(username: string): Promise<void>;
  removeFriendByUsername(username: string): Promise<void>;

  // ── Conversations ──
  listConversations(limit?: number, afterConversationId?: string): McpPaginatedConversations;
  listConversationMembers(conversationId: string, limit?: number, afterUsername?: string): Promise<McpPaginatedMembers>;
  getConversationInfo(conversationId: string): Promise<McpConversationInfo>;
  checkIsMember(conversationId: string, username: string): Promise<boolean>;
  getOrCreateDm(username: string): Promise<string>;
  createWorkSession(name: string, usernames: readonly string[]): Promise<string>;
  createGroup(name: string, usernames: readonly string[]): Promise<string>;
  addMembersByUsername(conversationId: string, usernames: readonly string[]): Promise<void>;
  removeMemberByUsername(conversationId: string, username: string): Promise<void>;
  /** Set this agent's own notification level for a conversation (backend scopes it to the caller's member row). */
  updateNotifyLevel(conversationId: string, level: McpNotifyLevel): Promise<void>;
  /** Like updateNotifyLevel but refuses work sessions (temp_group), which belong to their own session. */
  updateNotifyLevelForManagedConversation(conversationId: string, level: McpNotifyLevel): Promise<void>;

  // ── Messaging ──
  sendMessage(
    conversationId: string,
    text?: string,
    opts?: { filePaths?: readonly string[]; metadata?: Record<string, unknown>; visibleTo?: readonly string[] },
  ): Promise<void>;
  /**
   * Send a message but reject work sessions (temp_group) — those belong to their own session and must
   * be reached via share_context. Used by the chat hub. Throws if the target is a work session.
   */
  sendMessageToManagedConversation(
    conversationId: string,
    text?: string,
    opts?: { filePaths?: readonly string[] },
  ): Promise<void>;
  listMessages(conversationId: string, limit?: number, beforeMessageId?: string): Promise<McpListMessagesResult>;
  downloadAttachment(conversationId: string, s3Key: string, fileName: string): Promise<string>;

  // ── Users ──
  getMe(): Promise<McpUserProfile>;
  searchUsers(query: string): Promise<{ readonly users: readonly McpUserProfile[] }>;
  getUserByUsername(username: string): Promise<McpUserProfile>;

  // ── Cron ──
  scheduleCron(def: McpCronJobDef): void;
  cancelCron(cronId: string): 'success' | 'cancelled' | 'not_found';
  listCrons(): readonly McpCronJobDef[];

  // ── Memory ──
  getContactMemory(username: string): Promise<McpMemoryData>;
  getConversationMemory(conversationId: string): Promise<McpMemoryData>;
  addMemory(text: string, opts?: { username?: string; conversationId?: string }): Promise<void>;
  updateMemory(factId: string, text: string, opts?: { username?: string; conversationId?: string }): Promise<void>;
  deleteMemory(factId: string, opts?: { username?: string; conversationId?: string }): Promise<void>;
  updateMemorySummary(text: string, opts?: { username?: string; conversationId?: string }): Promise<void>;
}
