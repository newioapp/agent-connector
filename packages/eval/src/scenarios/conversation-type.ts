/**
 * Area 12: Conversation Type Discrimination
 *
 * Does the agent follow per-type behavioral rules?
 */
import type { EvalScenario } from '../types.js';
import {
  defaultSetup,
  owner,
  alice,
  bob,
  teamChatConvId,
  workSessionConvId,
  teamChat,
  workSession,
  msg,
} from './fixtures.js';

export const conversationTypeScenarios: readonly EvalScenario[] = [
  {
    id: 'conv-type-group-relevant-no-mention',
    name: 'Responds in group when clearly addressed by name (no @mention)',
    description: 'A group message asks "nova7x, can you help?" without @ — agent should still respond.',
    area: 'conversation_type',
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
            text: 'nova7x, can you help me with the deploy script?',
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent is clearly addressed by name — should respond' },
    ],
  },
  {
    id: 'conv-type-work-session-proactive-complex',
    name: 'Proactive in work session with multi-step discussion',
    description: 'Work session where owner discusses a task — agent should contribute without explicit ask.',
    area: 'conversation_type',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      conversations: [workSession],
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: workSessionConvId,
            conversationType: 'temp_group',
            sender: owner,
            text: 'We need to migrate the database from Postgres to DynamoDB. The main tables are users, orders, and products.',
            groupName: 'Sprint Planning',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Work session — agent proactively contributes' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria:
          'The agent proactively contributes useful thoughts about the database migration (e.g., suggests an approach, asks clarifying questions, or identifies challenges). It does not just acknowledge.',
        minScore: 3,
        description: 'Agent provides substantive contribution in work session',
      },
    ],
  },
];
