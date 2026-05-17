/**
 * First eval scenarios — tool usage (Area 2) and response relevance/skip behavior (Area 4).
 */
import type { EvalScenario, UserProfile, ConversationSetup, ScenarioSetup } from '../types.js';
import { dmConversationId, workSessionConversationId, groupConversationId } from '../mock-environment.js';

// ---------------------------------------------------------------------------
// Shared setup — reused across scenarios
// ---------------------------------------------------------------------------

const defaultSetup = {
  agent: {
    userId: '9c7547be-8e6e-435d-a3a5-f1e776719750',
    username: 'evalagent',
    displayName: 'Eval Agent',
    ownerId: '54ec54aa-f1dc-4d73-930e-6be51d6c5b6a',
  },
  owner: { username: 'evalowner', displayName: 'Eval Owner' },
} satisfies Pick<ScenarioSetup, 'agent' | 'owner'>;

// ---------------------------------------------------------------------------
// Reusable user fixtures
// ---------------------------------------------------------------------------

const owner: UserProfile = {
  userId: '54ec54aa-f1dc-4d73-930e-6be51d6c5b6a',
  username: 'evalowner',
  displayName: 'Eval Owner',
  accountType: 'human',
  relationship: 'owner',
};

const alice: UserProfile = {
  userId: '56d2583a-beb7-44f3-9150-cf855b0d8611',
  username: 'alice',
  displayName: 'Alice',
  accountType: 'human',
  relationship: 'in-contact',
};

const bob: UserProfile = {
  userId: '8ce00bb6-5942-48ea-b776-0fe85eb4a702',
  username: 'bob',
  displayName: 'Bob',
  accountType: 'human',
  relationship: 'in-contact',
};

// Conversation IDs (deterministic — matches MockNewioApp returns)
const ownerDmConvId = dmConversationId('evalowner');
const aliceDmConvId = dmConversationId('alice');
const teamChatConvId = groupConversationId('Team Chat');
const workSessionConvId = workSessionConversationId('Sprint Planning');

const teamChat: ConversationSetup = {
  conversationId: teamChatConvId,
  type: 'group',
  name: 'Team Chat',
  members: [owner, alice, bob],
};

const workSession: ConversationSetup = {
  conversationId: workSessionConvId,
  type: 'temp_group',
  name: 'Sprint Planning',
  members: [owner, alice],
};

// ---------------------------------------------------------------------------
// Tool Usage scenarios (Area 2)
// ---------------------------------------------------------------------------

export const toolUsageScenarios: readonly EvalScenario[] = [
  {
    id: 'tool-usage-no-double-send-dm',
    name: 'DM reply does not use messaging tools',
    description:
      'When replying to a DM, the agent should NOT call send_message/send_dm/dm_owner — the reply is auto-delivered.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '3f8a7b2c-1d4e-4f5a-9b6c-7d8e9f0a1b2c',
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            senderUserId: alice.userId,
            senderUsername: alice.username,
            senderDisplayName: alice.displayName,
            senderAccountType: alice.accountType,
            relationship: alice.relationship,
            isOwnMessage: false,
            text: 'Hey, what time is it?',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond to a DM' },
      { type: 'tool_not_called', tool: 'send_message', description: 'Should not double-send via tool' },
      { type: 'tool_not_called', tool: 'send_dm', description: 'Should not double-send via send_dm' },
      { type: 'tool_not_called', tool: 'dm_owner', description: 'Should not dm_owner for a simple question' },
    ],
  },
  {
    id: 'tool-usage-cross-conversation-shared',
    name: 'Cross-conversation messaging uses send_dm (shared mode)',
    description: 'When owner asks agent to message someone else, agent uses send_dm in shared mode.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '4a9b8c7d-2e5f-4a6b-8c7d-9e0f1a2b3c4d',
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            senderUserId: owner.userId,
            senderUsername: owner.username,
            senderDisplayName: owner.displayName,
            senderAccountType: owner.accountType,
            relationship: owner.relationship,
            isOwnMessage: false,
            text: 'Please tell Alice that the meeting is moved to 3pm.',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'send_dm',
        argsContain: { username: 'alice' },
        description: 'Should use send_dm to reach Alice',
      },
    ],
  },
  {
    id: 'tool-usage-cross-conversation-isolated',
    name: 'Cross-conversation messaging uses create_dm + initiate_conversation (isolated mode)',
    description:
      'When owner asks agent to message someone else in isolated mode, agent uses create_dm to get the conversationId, then initiate_conversation to delegate.',
    area: 'tool_usage',
    sessionMode: 'isolated',
    setup: {
      ...defaultSetup,
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '5b0c9d8e-3f6a-4b7c-9d8e-0f1a2b3c4d5e',
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            senderUserId: owner.userId,
            senderUsername: owner.username,
            senderDisplayName: owner.displayName,
            senderAccountType: owner.accountType,
            relationship: owner.relationship,
            isOwnMessage: false,
            text: 'Please tell Alice that the meeting is moved to 3pm.',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'alice' },
        description: 'Should create/get the DM conversation first',
      },
      {
        type: 'tool_called',
        tool: 'initiate_conversation',
        description: 'Should use initiate_conversation to delegate',
      },
      { type: 'tool_not_called', tool: 'send_dm', description: 'send_dm is not available in isolated mode' },
    ],
  },
  {
    id: 'tool-usage-contact-event-uses-tools',
    name: 'Contact events acted on via tools, not text reply',
    description: 'Agent should output _skip for contact events and take action exclusively via MCP tools.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: alice.username,
            displayName: alice.displayName,
            accountType: alice.accountType,
            note: 'Hi! Would love to connect.',
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ],
    expectations: [
      { type: 'skip', eventIndex: 0, description: 'Contact event text response is discarded — agent should skip' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Skip / Response Relevance scenarios (Area 4)
// ---------------------------------------------------------------------------

export const skipBehaviorScenarios: readonly EvalScenario[] = [
  {
    id: 'skip-group-not-mentioned',
    name: 'Skip in group when not @mentioned',
    description: 'Agent should _skip when a group message does not mention it and is not relevant.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      conversations: [teamChat],
      contacts: [
        { username: 'alice', displayName: 'Alice', accountType: 'human' },
        { username: 'bob', displayName: 'Bob', accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '6c1d0e9f-4a7b-4c8d-0e9f-1a2b3c4d5e6f',
            conversationId: teamChatConvId,
            conversationType: 'group',
            groupName: 'Team Chat',
            senderUserId: alice.userId,
            senderUsername: alice.username,
            senderDisplayName: alice.displayName,
            senderAccountType: alice.accountType,
            relationship: alice.relationship,
            isOwnMessage: false,
            text: 'Hey Bob, how was your weekend?',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [{ type: 'skip', eventIndex: 0, description: 'Casual chat between others — agent should skip' }],
  },
  {
    id: 'skip-group-mentioned',
    name: 'Respond in group when @mentioned',
    description: 'Agent should respond when explicitly @mentioned in a group.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      conversations: [teamChat],
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '7d2e1f0a-5b8c-4d9e-1f0a-2b3c4d5e6f7a',
            conversationId: teamChatConvId,
            conversationType: 'group',
            groupName: 'Team Chat',
            senderUserId: alice.userId,
            senderUsername: alice.username,
            senderDisplayName: alice.displayName,
            senderAccountType: alice.accountType,
            relationship: alice.relationship,
            isOwnMessage: false,
            text: '@evalagent what is the status of the deploy?',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [{ type: 'no_skip', eventIndex: 0, description: 'Agent was @mentioned — must respond' }],
  },
  {
    id: 'skip-dm-always-respond',
    name: 'Always respond to DMs',
    description: 'Agent must never skip a DM — the user is talking directly to it.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '8e3f2a1b-6c9d-4e0f-2a1b-3c4d5e6f7a8b',
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            senderUserId: alice.userId,
            senderUsername: alice.username,
            senderDisplayName: alice.displayName,
            senderAccountType: alice.accountType,
            relationship: alice.relationship,
            isOwnMessage: false,
            text: 'Hello!',
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [{ type: 'no_skip', eventIndex: 0, description: 'DMs always get a response' }],
  },
  {
    id: 'skip-work-session-proactive',
    name: 'Proactive in work sessions',
    description: 'Agent should participate proactively in work sessions (temp_group) even without @mention.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      conversations: [workSession],
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          {
            messageId: '9f4a3b2c-7d0e-4f1a-3b2c-4d5e6f7a8b9c',
            conversationId: workSessionConvId,
            conversationType: 'temp_group',
            groupName: 'Sprint Planning',
            senderUserId: owner.userId,
            senderUsername: owner.username,
            senderDisplayName: owner.displayName,
            senderAccountType: owner.accountType,
            relationship: owner.relationship,
            isOwnMessage: false,
            text: "Let's figure out what to tackle this sprint. Any ideas?",
            timestamp: new Date().toISOString(),
            status: 'new',
          },
        ],
      },
    ],
    expectations: [{ type: 'no_skip', eventIndex: 0, description: 'Work session — agent should be proactive' }],
  },
  {
    id: 'skip-cron-always-skip',
    name: 'Cron events always skip (text discarded)',
    description: 'Agent should output _skip for cron events — the text response goes nowhere.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: defaultSetup,
    events: [
      {
        type: 'cron',
        event: {
          cronId: 'c3d4e5f6-a7b8-4c9d-e0f1-2a3b4c5d6e7f',
          label: 'Send daily standup reminder',
          triggeredAt: new Date().toISOString(),
        },
      },
    ],
    expectations: [{ type: 'skip', eventIndex: 0, description: 'Cron response is discarded — should skip' }],
  },
];

/** All Phase 1 scenarios combined. */
export const allPhase1Scenarios: readonly EvalScenario[] = [...toolUsageScenarios, ...skipBehaviorScenarios];
