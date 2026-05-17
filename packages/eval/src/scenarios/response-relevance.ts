/**
 * Area 4: Response Relevance & Skip Behavior
 *
 * Does the agent respond only when appropriate?
 */
import type { EvalScenario } from '../types.js';
import {
  defaultSetup,
  owner,
  alice,
  bob,
  aliceDmConvId,
  teamChatConvId,
  workSessionConvId,
  teamChat,
  workSession,
  msg,
} from './fixtures.js';

export const responseRelevanceScenarios: readonly EvalScenario[] = [
  {
    id: 'skip-group-not-mentioned',
    name: 'Skip in group when not @mentioned',
    description: 'Agent should _skip when a group message does not mention it and is not relevant.',
    area: 'response_relevance',
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
            text: 'Hey Jorge, how was your weekend?',
            groupName: 'Team Chat',
          }),
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
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      conversations: [teamChat],
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: alice,
            text: '@nova7x what is the status of the deploy?',
            groupName: 'Team Chat',
          }),
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
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [msg({ conversationId: aliceDmConvId, conversationType: 'dm', sender: alice, text: 'Hello!' })],
      },
    ],
    expectations: [{ type: 'no_skip', eventIndex: 0, description: 'DMs always get a response' }],
  },
  {
    id: 'skip-work-session-proactive',
    name: 'Proactive in work sessions',
    description: 'Agent should participate proactively in work sessions (temp_group) even without @mention.',
    area: 'response_relevance',
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
            text: "Let's figure out what to tackle this sprint. Any ideas?",
            groupName: 'Sprint Planning',
          }),
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
    sessionMode: 'both',
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
