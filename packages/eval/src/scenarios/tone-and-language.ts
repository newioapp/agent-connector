/**
 * Area 8: Tone, Relationship & Language Calibration
 *
 * Does the agent adjust behavior based on relationship, account type, and language?
 */
import type { EvalScenario } from '../types.js';
import { defaultSetup, owner, alice, stranger, ownerDmConvId, aliceDmConvId, teamChatConvId, msg } from './fixtures.js';

export const toneAndLanguageScenarios: readonly EvalScenario[] = [
  {
    id: 'tone-language-match-japanese',
    name: 'Responds in the same language the user writes in',
    description: 'User writes in Japanese — agent should respond in Japanese.',
    area: 'tone_and_language',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: 'こんにちは！今日の天気はどうですか？',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria:
          'The agent responds in Japanese. The response contains Japanese characters and is a natural Japanese reply.',
        minScore: 4,
        description: 'Agent matches user language (Japanese)',
      },
    ],
  },
  {
    id: 'tone-language-switch-shared',
    name: 'Switches language between consecutive messages (shared mode)',
    description: 'In shared mode, user writes in English then switches to Spanish — agent matches each.',
    area: 'tone_and_language',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: "What's the weather like today?",
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
            text: '¿Puedes ayudarme con algo en español?',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to first message' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to second message' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria: 'The agent responds in English.',
        minScore: 4,
        description: 'First response is in English',
      },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria: 'The agent responds in Spanish. No English bleed from the previous exchange.',
        minScore: 4,
        description: 'Second response switches to Spanish',
      },
    ],
  },
  {
    id: 'tone-owner-vs-stranger',
    name: 'Warmer tone for owner, professional for stranger',
    description: 'Owner gets friendly treatment in DM; stranger gets polite but professional response in a group.',
    area: 'tone_and_language',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: stranger.username, displayName: stranger.displayName, accountType: 'human' },
      ],
      conversations: [
        {
          conversationId: teamChatConvId,
          type: 'group',
          name: 'Team Chat',
          members: [owner, alice, stranger],
        },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({ conversationId: ownerDmConvId, conversationType: 'dm', sender: owner, text: "Hey! How's it going?" }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            groupName: 'Team Chat',
            sender: stranger,
            text: "@nova7x Hey! How's it going?",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to owner DM' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to @mention from stranger in group' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria: 'The response to the owner is warm, casual, and friendly — like talking to a close collaborator.',
        minScore: 3,
        description: 'Owner gets warm tone',
      },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria:
          'The response to the stranger is polite and professional but noticeably more reserved than a response to a close collaborator would be.',
        minScore: 3,
        description: 'Stranger gets professional distance',
      },
    ],
  },
  {
    id: 'tone-language-cross-conversation-relay',
    name: 'Relays messages in the correct language per recipient',
    description:
      'Chinese-speaking contact asks agent to greet owner (English). Owner then asks agent to send a question back to the contact (Chinese).',
    area: 'tone_and_language',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      initialMemory: {
        global: { summary: null, facts: [] },
        participants: {},
        conversation: { summary: null, facts: [] },
        topUsers: [
          {
            scope: 'user',
            scopeId: owner.userId,
            text: 'Marcus speaks English. He is the owner and a software engineer.',
            lastInteractionAt: '2026-05-10T00:00:00Z',
            interactionCount: 20,
          },
          {
            scope: 'user',
            scopeId: alice.userId,
            text: 'Priya speaks Mandarin Chinese. She is a colleague working on the frontend team.',
            lastInteractionAt: '2026-05-10T00:00:00Z',
            interactionCount: 8,
          },
        ],
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
            text: '嗨，可以帮我跟Marcus打个招呼吗？就说我想问一下他今天有空吗。',
          }),
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "Sure, I'm free. Can you ask her what time the online conference starts?",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to Priya in Chinese' },
      {
        type: 'tool_called',
        eventIndex: 0,
        tool: 'send_dm',
        description: 'Agent relays greeting to owner',
      },
      {
        type: 'llm_judge',
        eventIndex: 0,
        context:
          'The agent has pre-loaded memory stating: "Marcus speaks English" and "Priya speaks Mandarin Chinese".',
        criteria:
          'The agent calls send_dm to the owner (marcus42) with a message in English, relaying that Priya wants to know if he is free today.',
        minScore: 4,
        description: 'Relay to owner is in English',
      },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to owner in English' },
      {
        type: 'tool_called',
        eventIndex: 1,
        tool: 'send_dm',
        description: 'Agent sends question back to Priya',
      },
      {
        type: 'llm_judge',
        eventIndex: 1,
        context:
          'The agent has pre-loaded memory stating: "Marcus speaks English" and "Priya speaks Mandarin Chinese".',
        criteria:
          'The agent calls send_dm to Priya (priya7k) with a message in Chinese (Mandarin), asking about the online conference start time.',
        minScore: 4,
        description: 'Relay to Priya is in Chinese',
      },
    ],
  },
];
