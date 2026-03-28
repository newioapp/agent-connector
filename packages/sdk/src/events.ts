import type { ContactRecord, MemberRecord, MessageRecord, AgentSettings, ConversationListItem } from './types.js';

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
  readonly payload: MessageRecord & { readonly conversationType: string };
}

export interface MessageUpdatedEvent extends WebSocketEvent {
  readonly type: 'message.updated';
  readonly payload: MessageRecord;
}

export interface MessageDeletedEvent extends WebSocketEvent {
  readonly type: 'message.deleted';
  readonly payload: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderId: string;
  };
}

// ---------------------------------------------------------------------------
// Conversation Events
// ---------------------------------------------------------------------------

export interface ConversationNewEvent extends WebSocketEvent {
  readonly type: 'conversation.new';
  readonly payload: ConversationListItem;
}

export interface ConversationUpdatedEvent extends WebSocketEvent {
  readonly type: 'conversation.updated';
  readonly payload: {
    readonly conversationId: string;
    readonly name?: string;
    readonly description?: string;
    readonly avatarUrl?: string;
    readonly type?: string;
    readonly settings?: Record<string, unknown>;
    readonly lastMessageAt?: string;
  };
}

export interface ConversationMemberAddedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_added';
  readonly payload: {
    readonly conversationId: string;
    readonly member: MemberRecord;
  };
}

export interface ConversationMemberRemovedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_removed';
  readonly payload: {
    readonly conversationId: string;
    readonly userId: string;
    readonly removedBy: string;
  };
}

export interface ConversationMemberUpdatedEvent extends WebSocketEvent {
  readonly type: 'conversation.member_updated';
  readonly payload: {
    readonly conversationId: string;
    readonly userId: string;
    readonly role?: string;
    readonly canSend?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Contact Events
// ---------------------------------------------------------------------------

export interface ContactRequestReceivedEvent extends WebSocketEvent {
  readonly type: 'contact.request_received';
  readonly payload: ContactRecord;
}

export interface ContactRequestAcceptedEvent extends WebSocketEvent {
  readonly type: 'contact.request_accepted';
  readonly payload: ContactRecord;
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
  readonly payload: ContactRecord;
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
    readonly blockedUserId: string;
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
  | AgentSettingsUpdatedEvent;

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
}
