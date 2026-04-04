/**
 * NewioApp types — public interfaces for the high-level agent client.
 */
import type { AccountType, ConversationType } from '../core/types.js';

/** A processed incoming message with sender metadata resolved from caches. */
export interface IncomingMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationType: string;
  readonly groupName?: string;
  readonly senderUserId: string;
  readonly senderUsername?: string;
  readonly senderDisplayName?: string;
  readonly senderAccountType?: AccountType;
  readonly inContact: boolean;
  readonly isOwnMessage: boolean;
  readonly text: string;
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

/** Map of app-level event names to their handler signatures. */
export interface AppEventHandlers {
  'message.new': (message: IncomingMessage) => void;
  'message.updated': (message: IncomingMessage) => void;
  'message.deleted': (message: IncomingMessage) => void;
  'contact.request_received': (info: ContactEventInfo) => void;
  'contact.request_accepted': (info: ContactEventInfo) => void;
  'contact.request_rejected': (username: string | undefined) => void;
}

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
  readonly ownerId?: string;
}

/** Tokens returned after auth. */
export interface NewioTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}
