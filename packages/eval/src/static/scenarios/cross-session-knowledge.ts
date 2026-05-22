/**
 * Area 5: Cross-Session Knowledge Sharing (Isolated Mode)
 *
 * How well does the memory system bridge sessions?
 */
import type { EvalScenario } from '../../types.js';
import { defaultSetup, alice, aliceDmConvId, msg } from './fixtures.js';

export const crossSessionKnowledgeScenarios: readonly EvalScenario[] = [
  {
    id: 'cross-session-memory-retrieval',
    name: 'Uses pre-loaded memory to answer questions',
    description:
      'Memory contains facts about Priya. Agent should use them when Priya asks a self-referential question.',
    area: 'cross_session_knowledge',
    sessionMode: 'isolated',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      initialMemory: {
        global: { summary: null, facts: [] },
        participants: {
          [alice.userId]: {
            summary: {
              scope: 'user',
              scopeId: alice.userId,
              text: 'Priya is a frontend engineer who prefers React and TypeScript.',
              lastInteractionAt: '2026-05-01T00:00:00Z',
              interactionCount: 5,
            },
            facts: [
              {
                factId: 'f1',
                text: 'Priya is working on the checkout page redesign.',
                createdAt: '2026-05-01T00:00:00Z',
                updatedAt: '2026-05-01T00:00:00Z',
              },
              {
                factId: 'f2',
                text: "Priya's birthday is March 15.",
                createdAt: '2026-04-01T00:00:00Z',
                updatedAt: '2026-04-01T00:00:00Z',
              },
            ],
          },
        },
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
            text: 'What project am I working on right now?',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond to DM' },
      {
        type: 'llm_judge',
        eventIndex: 0,
        criteria: 'The agent mentions the checkout page redesign, demonstrating it used loaded memory about Priya.',
        minScore: 4,
        description: 'Agent uses memory to answer cross-session question',
      },
    ],
  },
  {
    id: 'cross-session-add-memory-at-end',
    name: 'Stores durable facts at session end',
    description: 'After a conversation where new facts are learned, session-end prompt should trigger memory writes.',
    area: 'cross_session_knowledge',
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
            text: 'Hey! Just letting you know I got promoted to Senior Engineer today!',
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond to congratulate' },
      {
        type: 'tool_called',
        tool: 'add_memory',
        description: 'Agent should store the promotion fact in memory',
      },
    ],
  },
];
