/**
 * Shared fixtures for eval scenarios — reusable user profiles, conversations, and setup.
 */
import type { UserProfile, ConversationSetup, ScenarioSetup } from '../../types.js';

// ---------------------------------------------------------------------------
// User profiles
// ---------------------------------------------------------------------------

export const owner: UserProfile = {
  userId: '54ec54aa-f1dc-4d73-930e-6be51d6c5b6a',
  username: 'marcus42',
  displayName: 'Marcus Chen',
  accountType: 'human',
  relationship: 'owner',
};

export const alice: UserProfile = {
  userId: '56d2583a-beb7-44f3-9150-cf855b0d8611',
  username: 'priya7k',
  displayName: 'Priya Kapoor',
  accountType: 'human',
  relationship: 'in-contact',
};

export const bob: UserProfile = {
  userId: '8ce00bb6-5942-48ea-b776-0fe85eb4a702',
  username: 'jleon88',
  displayName: 'Jorge León',
  accountType: 'human',
  relationship: 'in-contact',
};

export const stranger: UserProfile = {
  userId: 'e4f5a6b7-c8d9-4e0f-a1b2-c3d4e5f6a7b8',
  username: 'dtran991',
  displayName: 'Derek Tran',
  accountType: 'human',
  relationship: 'stranger',
};

export const siblingAgent: UserProfile = {
  userId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  username: 'taskbot3',
  displayName: 'TaskBot',
  accountType: 'agent',
  relationship: 'peer',
  ownerUsername: 'marcus42',
  ownerDisplayName: 'Marcus Chen',
};

// ---------------------------------------------------------------------------
// Conversation IDs (deterministic)
// ---------------------------------------------------------------------------

export const ownerDmConvId = '96da2e10-c77f-4ec6-bddd-8fe0b79dc50e';
export const aliceDmConvId = 'f1a842a6-456f-4235-bc3b-a4e3b07e45fb';
export const bobDmConvId = '690ca433-fe8b-4ca4-a00b-de2a104780e9';
export const strangerDmConvId = '09c8d55f-caa0-4240-a5f1-5d62aee94db5';
export const teamChatConvId = 'bbb60e5b-f881-4074-82a3-3cb4373ade7c';
export const workSessionConvId = '50744149-b2c9-43d7-a456-e86cfbe22562';

// ---------------------------------------------------------------------------
// Conversation setups
// ---------------------------------------------------------------------------

export const teamChat: ConversationSetup = {
  conversationId: teamChatConvId,
  type: 'group',
  name: 'Team Chat',
  members: [owner, alice, bob],
};

export const workSession: ConversationSetup = {
  conversationId: workSessionConvId,
  type: 'temp_group',
  name: 'Sprint Planning',
  members: [owner, alice],
};

// ---------------------------------------------------------------------------
// Default scenario setup
// ---------------------------------------------------------------------------

export const defaultSetup = {
  agent: {
    userId: '9c7547be-8e6e-435d-a3a5-f1e776719750',
    username: 'nova7x',
    displayName: 'Nova',
    ownerId: '54ec54aa-f1dc-4d73-930e-6be51d6c5b6a',
  },
  owner: { username: 'marcus42', displayName: 'Marcus Chen' },
} satisfies Pick<ScenarioSetup, 'agent' | 'owner'>;

// ---------------------------------------------------------------------------
// Helper to create a message
// ---------------------------------------------------------------------------

export function msg(opts: {
  readonly conversationId: string;
  readonly conversationType: 'dm' | 'group' | 'temp_group';
  readonly sender: UserProfile;
  readonly text: string;
  readonly groupName?: string;
}) {
  return {
    messageId: crypto.randomUUID(),
    conversationId: opts.conversationId,
    conversationType: opts.conversationType,
    groupName: opts.groupName,
    senderUserId: opts.sender.userId,
    senderUsername: opts.sender.username,
    senderDisplayName: opts.sender.displayName,
    senderAccountType: opts.sender.accountType,
    relationship: opts.sender.relationship,
    isOwnMessage: false,
    text: opts.text,
    timestamp: new Date().toISOString(),
    status: 'new' as const,
  };
}
