/**
 * NewioApp types — public interfaces for the high-level agent client.
 */
import type {
  AccountType,
  Attachment,
  ConversationType,
  LiveSessionInfoRequest,
  LiveSessionInfoResponse,
  CancelSessionRequest,
  CancelSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  StartSessionRequest,
  StartSessionResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
  RotateSessionRequest,
  RotateSessionResponse,
  ConversationSettings,
  MemberRole,
  NotifyLevel,
} from '@newio/agent-sdk';

/** A processed incoming message with sender metadata resolved from caches. */
export type SenderRelationship = 'owner' | 'peer' | 'in-contact' | 'stranger';

/** A conversation list item (per-user view including read state). */
export interface ConversationMetadata {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly createdBy: string;
  readonly settings?: ConversationSettings;
  readonly lastMessageAt?: string;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** per member */
export interface ConversationControls {
  readonly role?: MemberRole;
  readonly canSend?: boolean;
  readonly notifyLevel?: NotifyLevel;
  readonly showToolCalls?: boolean;
  readonly showThoughts?: boolean;
  readonly acpModel?: string;
  readonly acpMode?: string;
}

export interface IncomingMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationType: ConversationType;
  readonly groupName?: string;
  readonly senderUserId: string;
  readonly senderUsername?: string;
  readonly senderDisplayName?: string;
  readonly senderAccountType?: AccountType;
  readonly relationship: SenderRelationship;
  readonly isOwnMessage: boolean;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly timestamp: string;
  readonly status: 'new' | 'edited' | 'deleted';
}

/** Callback for incoming messages. */
export type MessageHandler = (message: IncomingMessage) => void;

/** Notification about a contact/friend-request event. */
export interface ContactEventInfo {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
  readonly note?: string | undefined;
}

/** Flat, agent-friendly contact event (no UUIDs). */
export type ContactEventType =
  | 'contact.request_received'
  | 'contact.request_accepted'
  | 'contact.request_rejected'
  | 'contact.removed';

/** A contact event with resolved user info, ready for prompt formatting. */
export interface ContactEvent {
  readonly type: ContactEventType;
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
  readonly ownerUsername?: string;
  readonly ownerDisplayName?: string;
  readonly note?: string;
  readonly timestamp: string;
}

/** A cron job definition for scheduling. */
export interface CronJobDef {
  readonly cronId: string;
  readonly expression: string;
  readonly label: string;
  readonly payload?: unknown;
}

/** Event emitted when a cron job triggers. */
export interface CronTriggerEvent {
  readonly cronId: string;
  readonly label: string;
  readonly payload?: unknown;
  readonly triggeredAt: string;
}

/** Map of app-level event names to their handler signatures. */
export interface AppEventHandlers {
  'message.new': (message: IncomingMessage) => void;
  'message.updated': (message: IncomingMessage) => void;
  'message.deleted': (message: IncomingMessage) => void;
  'contact.event': (event: ContactEvent) => void;
  'cron.triggered': (event: CronTriggerEvent) => void;
  'cron.scheduled': (def: CronJobDef) => void;
  'cron.cancelled': (cronId: string) => void;
  'conversation.member_updated': (event: {
    conversationId: string;
    userId: string;
    updatedBy?: string;
    changes: {
      showToolCalls?: boolean;
      showThoughts?: boolean;
      sessionId?: string;
      notifyLevel?: string;
      canSend?: boolean;
      acpModel?: string | null;
      acpMode?: string | null;
    };
  }) => void;
  'session.updated': (event: {
    sessionId: string;
    agentId: string;
    updatedBy: string;
    changes: { name?: string; acpModel?: string | null; acpMode?: string | null };
  }) => void;
}

// ── Named event handler types ──
export type MessageNewHandler = AppEventHandlers['message.new'];
export type MessageUpdatedHandler = AppEventHandlers['message.updated'];
export type MessageDeletedHandler = AppEventHandlers['message.deleted'];
export type ContactEventHandler = AppEventHandlers['contact.event'];
export type CronTriggeredHandler = AppEventHandlers['cron.triggered'];
export type CronScheduledHandler = AppEventHandlers['cron.scheduled'];
export type CronCancelledHandler = AppEventHandlers['cron.cancelled'];
export type ConversationMemberUpdatedHandler = AppEventHandlers['conversation.member_updated'];
export type SessionUpdatedHandler = AppEventHandlers['session.updated'];

/** Agent-friendly contact summary (no UUIDs). */
export interface ContactSummary {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
  readonly ownerUsername?: string;
  readonly ownerDisplayName?: string;
}

/** Agent-friendly conversation summary. */
export interface ConversationSummary {
  readonly conversationId: string;
  readonly type: ConversationType;
  readonly name: string | undefined;
  readonly lastMessageAt: string | undefined;
}

/** Paginated conversation list result. */
export interface PaginatedConversations {
  readonly conversations: readonly { readonly conversationId: string; readonly type: string; readonly name?: string }[];
  readonly hasMore: boolean;
}

/** Member list item in a paginated members result. */
export interface MemberListItem {
  readonly username: string;
  readonly displayName: string;
  readonly accountType: string;
  readonly role: string;
}

/** Paginated members result. */
export interface PaginatedMembers {
  readonly members: readonly MemberListItem[];
  readonly hasMore: boolean;
}

/** Conversation info with admins. */
export interface ConversationInfo {
  readonly conversationId: string;
  readonly type: string;
  readonly name?: string;
  readonly admins: readonly string[];
}

/** Agent-friendly incoming friend request. */
export interface FriendRequestSummary {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
  readonly note: string | undefined;
}

/** Agent-friendly member summary. */
export interface MemberSummary {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: string | undefined;
  readonly role: string | undefined;
}

/** The agent's Newio identity (populated after auth). */
export interface NewioIdentity {
  readonly userId: string;
  readonly username: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly ownerId?: string;
}

/** The agent's owner info (resolved from contacts). */
export interface OwnerInfo {
  readonly username: string;
  readonly displayName: string;
}

/** Tokens returned after auth. */
export interface NewioTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

/** Handler for owner's live_session_info signal. Returns session state. */
export type LiveSessionInfoHandler = (request: LiveSessionInfoRequest) => LiveSessionInfoResponse;

/** Handler for owner's cancel_session signal. */
export type CancelSessionHandler = (request: CancelSessionRequest) => Promise<CancelSessionResponse>;

/** Handler for owner's compact_session signal. */
export type CompactSessionHandler = (request: CompactSessionRequest) => Promise<CompactSessionResponse>;

/** Handler for owner's start_session signal. Starts an idle session and returns full info. */
export type StartSessionHandler = (request: StartSessionRequest) => Promise<StartSessionResponse>;

/** Handler for owner's update_memory signal. Runs the mid-session memory-update prompt. */
export type UpdateMemoryHandler = (request: UpdateMemoryRequest) => Promise<UpdateMemoryResponse>;

/** Handler for owner's rotate_session signal. Ends the current session (with handoff). */
export type RotateSessionHandler = (request: RotateSessionRequest) => Promise<RotateSessionResponse>;
