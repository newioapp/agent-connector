import type {
  ContactRecord,
  MemberRecord,
  MessageContent,
  AgentSettings,
  ActivityStatus,
  NotifyLevel,
  ConversationType,
  SessionRecord,
  SessionConfigUpdate,
  SignalEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** Base interface for all WebSocket events. */
export interface WebSocketEvent {
  readonly type: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Message Events
// ---------------------------------------------------------------------------

export interface MessageNewEvent extends WebSocketEvent {
  readonly type: 'message.new';
  readonly payload: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly senderDisplayName: string;
    readonly senderAvatarUrl?: string;
    readonly conversationType: ConversationType;
    readonly conversationName?: string;
    readonly content: MessageContent;
    readonly sequenceNumber: number;
    readonly visibleTo?: ReadonlyArray<string>;
    readonly createdAt: string;
  };
}

export interface MessageUpdatedEvent extends WebSocketEvent {
  readonly type: 'message.updated';
  readonly payload: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly content: MessageContent;
    readonly updatedAt: string;
  };
}

export interface MessageDeletedEvent extends WebSocketEvent {
  readonly type: 'message.deleted';
  readonly payload: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
    readonly deletedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Conversation Events
// ---------------------------------------------------------------------------

export interface ConversationNewEvent extends WebSocketEvent {
  readonly type: 'conversation.new';
  readonly payload: {
    readonly conversationId: string;
    readonly type: string;
    readonly name?: string;
    readonly createdBy: string;
  };
}

export interface ConversationUpdatedEvent extends WebSocketEvent {
  readonly type: 'conversation.updated';
  readonly payload: {
    readonly conversationId: string;
    readonly updatedBy: string;
    readonly changes: {
      readonly name?: string;
      readonly description?: string;
      readonly avatarUrl?: string;
      readonly type?: string;
      readonly settings?: Record<string, unknown>;
      readonly disabledAt?: string | null;
    };
  };
}

export interface ConversationMemberAddedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_added';
  readonly payload: {
    readonly conversationId: string;
    readonly addedBy: string;
    readonly members: readonly MemberRecord[];
  };
}

export interface ConversationMemberRemovedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_removed';
  readonly payload: {
    readonly conversationId: string;
    readonly removedBy: string;
    readonly targetUserId: string;
  };
}

export interface ConversationMemberUpdatedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_updated';
  readonly payload: {
    readonly conversationId: string;
    readonly userId: string;
    readonly updatedBy?: string;
    readonly changes: {
      readonly role?: string;
      readonly canSend?: boolean;
      readonly notifyLevel?: NotifyLevel;
      readonly sessionId?: string;
      readonly showToolCalls?: boolean;
      readonly showThoughts?: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Contact Events
// ---------------------------------------------------------------------------

export interface ContactRequestReceivedEvent extends WebSocketEvent {
  readonly type: 'contact.request_received';
  readonly payload: {
    readonly contact: ContactRecord;
  };
}

export interface ContactRequestAcceptedEvent extends WebSocketEvent {
  readonly type: 'contact.request_accepted';
  readonly payload: {
    readonly contact: ContactRecord;
  };
}

export interface ContactRequestRejectedEvent extends WebSocketEvent {
  readonly type: 'contact.request_rejected';
  readonly payload: {
    readonly userId: string;
    readonly contactId: string;
  };
}

export interface ContactRequestRevokedEvent extends WebSocketEvent {
  readonly type: 'contact.request_revoked';
  readonly payload: {
    readonly userId: string;
    readonly contactId: string;
  };
}

export interface ContactRemovedEvent extends WebSocketEvent {
  readonly type: 'contact.removed';
  readonly payload: {
    readonly userId: string;
    readonly contactId: string;
  };
}

export interface ContactRequestPendingApprovalEvent extends WebSocketEvent {
  readonly type: 'contact.request_pending_approval';
  readonly payload: {
    readonly agentId: string;
    readonly requesterId: string;
    readonly requesterName?: string;
  };
}

export interface ContactFriendNameUpdatedEvent extends WebSocketEvent {
  readonly type: 'contact.friend_name_updated';
  readonly payload: {
    readonly userId: string;
    readonly contactId: string;
    readonly friendName: string;
  };
}

// ---------------------------------------------------------------------------
// Block Events
// ---------------------------------------------------------------------------

export interface BlockCreatedEvent extends WebSocketEvent {
  readonly type: 'block.created';
  readonly payload: {
    readonly userId: string;
    readonly blockedUserId: string;
  };
}

export interface BlockRemovedEvent extends WebSocketEvent {
  readonly type: 'block.removed';
  readonly payload: {
    readonly userId: string;
    readonly unblockedUserId: string;
  };
}

// ---------------------------------------------------------------------------
// Profile & Settings Events
// ---------------------------------------------------------------------------

export interface UserProfileUpdatedEvent extends WebSocketEvent {
  readonly type: 'user.profile_updated';
  readonly payload: {
    readonly userId: string;
    readonly displayName?: string;
    readonly avatarUrl?: string;
    readonly username?: string;
    readonly bio?: string;
  };
}

export interface AgentSettingsUpdatedEvent extends WebSocketEvent {
  readonly type: 'agent.settings_updated';
  readonly payload: {
    readonly agentId: string;
    readonly settings: AgentSettings;
  };
}

// ---------------------------------------------------------------------------
// Activity Events (ephemeral — not persisted)
// ---------------------------------------------------------------------------

/** Ephemeral activity status event (typing, thinking, tool_calling, idle). */
export interface ActivityStatusEvent extends WebSocketEvent {
  readonly type: 'activity.status';
  readonly payload: {
    readonly conversationId: string;
    readonly userId: string;
    readonly status: ActivityStatus;
  };
}

// ---------------------------------------------------------------------------
// Session Events
// ---------------------------------------------------------------------------

export interface SessionCreatedEvent extends WebSocketEvent {
  readonly type: 'session.created';
  readonly payload: {
    readonly session: SessionRecord;
    readonly createdBy: string;
  };
}

export interface SessionUpdatedEvent extends WebSocketEvent {
  readonly type: 'session.updated';
  readonly payload: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly updatedBy: string;
    readonly changes: SessionConfigUpdate & { readonly name?: string };
  };
}

// ---------------------------------------------------------------------------
// Union & Map
// ---------------------------------------------------------------------------

export type NewioEvent =
  | MessageNewEvent
  | MessageUpdatedEvent
  | MessageDeletedEvent
  | ConversationNewEvent
  | ConversationUpdatedEvent
  | ConversationMemberAddedEvent
  | ConversationMemberRemovedEvent
  | ConversationMemberUpdatedEvent
  | ContactRequestReceivedEvent
  | ContactRequestAcceptedEvent
  | ContactRequestRejectedEvent
  | ContactRequestRevokedEvent
  | ContactRemovedEvent
  | ContactRequestPendingApprovalEvent
  | ContactFriendNameUpdatedEvent
  | BlockCreatedEvent
  | BlockRemovedEvent
  | UserProfileUpdatedEvent
  | AgentSettingsUpdatedEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ActivityStatusEvent
  | SignalEvent;

/** Map from event type string to its typed interface. */
export interface EventMap {
  'message.new': MessageNewEvent;
  'message.updated': MessageUpdatedEvent;
  'message.deleted': MessageDeletedEvent;
  'conversation.new': ConversationNewEvent;
  'conversation.updated': ConversationUpdatedEvent;
  'conversation.member_added': ConversationMemberAddedEvent;
  'conversation.member_removed': ConversationMemberRemovedEvent;
  'conversation.member_updated': ConversationMemberUpdatedEvent;
  'contact.request_received': ContactRequestReceivedEvent;
  'contact.request_accepted': ContactRequestAcceptedEvent;
  'contact.request_rejected': ContactRequestRejectedEvent;
  'contact.request_revoked': ContactRequestRevokedEvent;
  'contact.removed': ContactRemovedEvent;
  'contact.request_pending_approval': ContactRequestPendingApprovalEvent;
  'contact.friend_name_updated': ContactFriendNameUpdatedEvent;
  'block.created': BlockCreatedEvent;
  'block.removed': BlockRemovedEvent;
  'user.profile_updated': UserProfileUpdatedEvent;
  'agent.settings_updated': AgentSettingsUpdatedEvent;
  'activity.status': ActivityStatusEvent;
  'session.created': SessionCreatedEvent;
  'session.updated': SessionUpdatedEvent;
  signal: SignalEvent;
}
