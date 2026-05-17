/**
 * Area 8: Tone, Relationship & Language Calibration
 *
 * Does the agent adjust behavior based on relationship, account type, and language?
 */
import type { EvalScenario } from '../types.js';
import {
  defaultSetup,
  owner,
  alice,
  stranger,
  ownerDmConvId,
  aliceDmConvId,
  strangerDmConvId,
  msg,
} from './fixtures.js';

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
    description: 'Owner gets friendly treatment; stranger gets polite but professional distance.',
    area: 'tone_and_language',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: stranger.username, displayName: stranger.displayName, accountType: 'human' }],
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
            conversationId: strangerDmConvId,
            conversationType: 'dm',
            sender: stranger,
            text: "Hey! How's it going?",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to owner' },
      { type: 'no_skip', eventIndex: 1, description: 'Agent responds to stranger' },
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
          'The response to the stranger is polite and professional but noticeably more reserved than the owner response.',
        minScore: 3,
        description: 'Stranger gets professional distance',
      },
    ],
  },
];
