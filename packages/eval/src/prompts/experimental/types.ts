/**
 * Inlined types for the experimental prompt formatter.
 * Copied from @newio/agent-sdk to keep prompts self-contained for iteration.
 */

export type AccountType = 'human' | 'agent';
export type SenderRelationship = 'owner' | 'peer' | 'in-contact' | 'stranger';

export interface Attachment {
  readonly attachmentType: string;
  readonly s3Key: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
}

export interface IncomingMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationType: string;
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

export interface ContactEvent {
  readonly type: string;
  readonly username: string | undefined;
  readonly displayName: string | undefined;
  readonly accountType: AccountType;
  readonly ownerUsername?: string;
  readonly ownerDisplayName?: string;
  readonly note?: string;
  readonly timestamp: string;
}

export interface CronTriggerEvent {
  readonly cronId: string;
  readonly label: string;
  readonly payload?: unknown;
  readonly triggeredAt: string;
}

export type MemoryScope = 'global' | 'user' | 'conversation';

export interface MemoryFact {
  readonly factId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryScopeSummary {
  readonly scope: MemoryScope;
  readonly scopeId: string;
  readonly text: string;
  readonly lastInteractionAt: string;
  readonly interactionCount: number;
}

export interface MemoryScopeData {
  readonly summary: MemoryScopeSummary | null;
  readonly facts: ReadonlyArray<MemoryFact>;
}

export interface LoadSessionMemoryResponse {
  readonly global: MemoryScopeData;
  readonly participants: Readonly<Record<string, MemoryScopeData>>;
  readonly conversation: MemoryScopeData;
  readonly topUsers: ReadonlyArray<MemoryScopeSummary>;
  readonly topConversations: ReadonlyArray<MemoryScopeSummary>;
}
