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
  readonly newioSessionId: string;
  readonly label: string;
  readonly payload?: unknown;
}

/** Event emitted when a cron job triggers. */
export interface CronTriggerEvent {
  readonly cronId: string;
  readonly newioSessionId: string;
  readonly label: string;
  readonly payload?: unknown;
  readonly triggeredAt: string;
}

/** Map of app-level event names to their handler signatures. */
export interface AppEventHandlers {
  'message.new': (message: IncomingMessage) => void;
  'message.updated': (message: IncomingMessage) => void;
  'message.deleted': (message: IncomingMessage) => void;
  'contact.request_received': (info: ContactEventInfo) => void;
  'contact.request_accepted': (info: ContactEventInfo) => void;
  'contact.request_rejected': (username: string | undefined) => void;
  'contact.removed': (username: string | undefined) => void;
  'contact.event': (event: ContactEvent) => void;
  'cron.triggered': (event: CronTriggerEvent) => void;
  'cron.scheduled': (def: CronJobDef) => void;
  'cron.cancelled': (cronId: string) => void;
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
  readonly avatarUrl?: string;
  readonly ownerId?: string;
}

/** Tokens returned after auth. */
export interface NewioTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}
