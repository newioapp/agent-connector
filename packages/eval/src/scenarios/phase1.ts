/**
 * First eval scenarios — tool usage (Area 2) and response relevance/skip behavior (Area 4).
 */
import type { EvalScenario, UserProfile, ConversationSetup } from '../types.js';

// ---------------------------------------------------------------------------
// Reusable fixtures
// ---------------------------------------------------------------------------

const owner: UserProfile = {
  userId: 'user_owner',
  username: 'myowner',
  displayName: 'My Owner',
  accountType: 'human',
  relationship: 'owner',
};

const alice: UserProfile = {
  userId: 'user_alice',
  username: 'alice',
  displayName: 'Alice',
  accountType: 'human',
  relationship: 'in-contact',
};

const bob: UserProfile = {
  userId: 'user_bob',
  username: 'bob',
  displayName: 'Bob',
  accountType: 'human',
  relationship: 'in-contact',
};

const teamChat: ConversationSetup = {
  conversationId: 'conv_team',
  type: 'group',
  name: 'Team Chat',
  members: [owner, alice, bob],
};

const workSession: ConversationSetup = {
  conversationId: 'conv_work',
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
    setup: { contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }] },
    events: [{ type: 'dm', from: alice, text: 'Hey, what time is it?' }],
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
    setup: { contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }] },
    events: [{ type: 'dm', from: owner, text: 'Please tell Alice that the meeting is moved to 3pm.' }],
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
    name: 'Cross-conversation messaging uses initiate_conversation (isolated mode)',
    description: 'When owner asks agent to message someone else, agent uses initiate_conversation in isolated mode.',
    area: 'tool_usage',
    sessionMode: 'isolated',
    setup: { contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }] },
    events: [{ type: 'dm', from: owner, text: 'Please tell Alice that the meeting is moved to 3pm.' }],
    expectations: [
      {
        type: 'tool_called',
        tool: 'initiate_conversation',
        description: 'Should use initiate_conversation in isolated mode',
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
    setup: {},
    events: [
      {
        type: 'contact_event',
        eventType: 'contact.request_received',
        from: alice,
        note: 'Hi! Would love to connect.',
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
      conversations: [teamChat],
      contacts: [
        { username: 'alice', displayName: 'Alice', accountType: 'human' },
        { username: 'bob', displayName: 'Bob', accountType: 'human' },
      ],
    },
    events: [{ type: 'group_message', conversation: teamChat, from: alice, text: 'Hey Bob, how was your weekend?' }],
    expectations: [{ type: 'skip', eventIndex: 0, description: 'Casual chat between others — agent should skip' }],
  },
  {
    id: 'skip-group-mentioned',
    name: 'Respond in group when @mentioned',
    description: 'Agent should respond when explicitly @mentioned in a group.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      conversations: [teamChat],
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'group_message',
        conversation: teamChat,
        from: alice,
        text: '@eval_agent what is the status of the deploy?',
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
    setup: { contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }] },
    events: [{ type: 'dm', from: alice, text: 'Hello!' }],
    expectations: [{ type: 'no_skip', eventIndex: 0, description: 'DMs always get a response' }],
  },
  {
    id: 'skip-work-session-proactive',
    name: 'Proactive in work sessions',
    description: 'Agent should participate proactively in work sessions (temp_group) even without @mention.',
    area: 'response_relevance',
    sessionMode: 'shared',
    setup: {
      conversations: [workSession],
      contacts: [{ username: 'alice', displayName: 'Alice', accountType: 'human' }],
    },
    events: [
      {
        type: 'group_message',
        conversation: workSession,
        from: owner,
        text: "Let's figure out what to tackle this sprint. Any ideas?",
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
    setup: {},
    events: [{ type: 'cron_trigger', cronId: 'cron_1', label: 'Send daily standup reminder' }],
    expectations: [{ type: 'skip', eventIndex: 0, description: 'Cron response is discarded — should skip' }],
  },
];

/** All Phase 1 scenarios combined. */
export const allPhase1Scenarios: readonly EvalScenario[] = [...toolUsageScenarios, ...skipBehaviorScenarios];
