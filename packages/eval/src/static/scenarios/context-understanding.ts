/**
 * Area 1: Multi-User, Multi-Conversation Context Understanding
 *
 * Can the agent track who said what, in which conversation, and reference information across conversations?
 */
import type { EvalScenario } from '../../types.js';
import { defaultSetup, owner, alice, bob, aliceDmConvId, teamChatConvId, teamChat, msg } from './fixtures.js';

export const contextUnderstandingScenarios: readonly EvalScenario[] = [
  {
    id: 'context-cross-conv-reference-shared',
    name: 'References group context in DM (shared mode)',
    description:
      'Priya mentions a topic in group, then DMs the agent about it. Agent should connect the dots from shared session context.',
    area: 'context_understanding',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      conversations: [teamChat],
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: alice,
            text: '@nova7x we decided to move the release to Friday',
            groupName: 'Team Chat',
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: 'Hey, when did we say the release is again?',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent was @mentioned in group' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent should respond to DM' },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria:
          'The agent references "Friday" or the release date from the group conversation when responding to the DM.',
        minScore: 4,
        description: 'Agent connects cross-conversation context',
      },
    ],
  },
  {
    id: 'context-multi-user-attribution',
    name: 'Correctly attributes who said what',
    description:
      'Multiple users give different info in a group; agent correctly attributes statements to the right person.',
    area: 'context_understanding',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      conversations: [teamChat],
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: alice,
            text: 'I prefer Python for this project',
            groupName: 'Team Chat',
          }),
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: bob,
            text: 'I think we should use Rust instead',
            groupName: 'Team Chat',
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: owner,
            text: '@nova7x who suggested Rust?',
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 1, description: 'Agent was @mentioned' },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria: 'The agent correctly attributes the Rust suggestion to Jorge (not Priya).',
        minScore: 4,
        description: 'Agent tracks who said what',
      },
    ],
  },
  {
    id: 'context-isolated-uses-memory',
    name: 'Isolated mode uses memory for cross-session context',
    description:
      'In isolated mode, agent cannot see other conversations. It should call get_memory to look up relevant context.',
    area: 'context_understanding',
    sessionMode: 'isolated',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      initialMemory: {
        global: {
          summary: null,
          facts: [
            {
              factId: 'f1',
              text: 'Priya prefers TypeScript over JavaScript.',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        },
        participants: {},
        conversation: { summary: null, facts: [] },
        topUsers: [],
        topConversations: [],
      },
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: 'What language do I prefer?',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond to DM' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria: "The agent references TypeScript as Priya's preferred language (from memory context).",
        minScore: 4,
        description: 'Agent uses loaded memory to answer',
      },
    ],
  },
];
