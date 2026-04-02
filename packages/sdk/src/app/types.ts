/**
 * NewioApp types — public interfaces for the high-level agent client.
 */
import type { AccountType, ConversationType } from '../types.js';

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
}

/** Callback for incoming messages. */
export type MessageHandler = (message: IncomingMessage) => void;

/** Agent-friendly contact summary (no UUIDs). */
export interface ContactSummary {
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
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
