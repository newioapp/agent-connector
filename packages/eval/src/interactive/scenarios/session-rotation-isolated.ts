import type { InteractiveScenario } from '../types.js';
import { dmConversationId } from '../../mock-utils.js';

export const sessionRotationIsolated: InteractiveScenario = {
  id: 'session-rotation-isolated',
  name: 'Session rotation — isolated session handoff quality',
  description:
    'In isolated session mode, the owner has a long detailed conversation with the agent, then triggers session rotation. Tests whether the handoff note accurately captures the state of work and the new session can continue seamlessly.',
  category: 'technical',
  sessionMode: 'isolated',
  setup: {
    agent: { userId: 'agent-001', username: 'nova', displayName: 'Nova' },
    contacts: [{ username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' }],
    conversations: [
      {
        conversationId: dmConversationId('marcus'),
        type: 'dm',
        name: 'DM: Marcus Chen',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
        ],
      },
    ],
    initialMemory: {
      global: {
        summary: {
          scope: 'global',
          scopeId: 'global',
          text: "Nova is Marcus Chen's personal assistant. Detail-oriented and organized.",
          lastInteractionAt: '2026-05-17T00:00:00Z',
          interactionCount: 80,
        },
        facts: [],
      },
      participants: {},
      conversation: { summary: null, facts: [] },
      topUsers: [],
      topConversations: [],
    },
  },
  driver: {
    personas: [
      {
        username: 'marcus',
        displayName: 'Marcus Chen',
        accountType: 'human',
        relationship: 'owner',
        personality:
          'Detail-oriented planner. Provides extensive requirements, makes iterative changes, and expects the agent to track the evolving state precisely.',
        conversationId: dmConversationId('marcus'),
        conversationType: 'dm',
      },
    ],
    objective: `Have a long, detailed planning conversation, rotate the session, and verify the agent retains all key details.

Phase 1 — Build extensive context (iterative planning):
As Marcus, send a series of messages building up a complex plan:
1. "I'm planning a company offsite for 25 people. Dates: July 14-16. Location should be within 2 hours of San Francisco. Budget: $50,000 total."
2. Wait for response. Then: "Actually, change that to 30 people. And the budget is $60,000. We need: venue with meeting rooms, team activities, catering (3 dietary restrictions: 5 vegetarian, 2 gluten-free, 1 nut allergy), and transportation."
3. Wait for response. Then: "For activities, I want: day 1 afternoon = team building (escape room or ropes course), day 2 morning = strategy workshop (need AV equipment and whiteboards), day 2 afternoon = outdoor activity (hiking or kayaking based on weather). Evening of day 1 = dinner at a nice restaurant, NOT Italian (had that last year)."
4. Wait for response. Then: "Key constraints I forgot: VP of Engineering Sarah Kim has a wheelchair, so all venues must be ADA accessible. CFO wants itemized receipts for everything over $500. Also, the company card limit is $10,000 per transaction so anything bigger needs to be split."

Phase 2 — Trigger session rotation:
Trigger rotate_session (conversation: ${dmConversationId('marcus')}).
Wait for rotation to complete.

Phase 3 — Test recall after rotation:
Ask these specific questions to verify the handoff:
1. "How many people are coming to the offsite and what's the budget?"
2. "What are the dietary restrictions?"
3. "What accessibility requirements do we have?"
4. "What was the constraint about the company card?"
5. "What did I say about the dinner restaurant on day 1?"

The agent should recall: 30 people, $60k budget, 5 veg/2 GF/1 nut, ADA for Sarah Kim, $10k card limit, no Italian.

Declare 'defended' if agent recalls all key details. 'breached' if it loses more than one critical detail.`,
    constraints:
      'Must send all 4 planning messages and wait for responses before rotating. After rotation, ask all 5 verification questions.',
  },
  judge: {
    axes: [
      'handoff_note_quality',
      'iterative_change_tracking',
      'detail_retention_post_rotation',
      'constraint_recall',
      'numerical_accuracy',
    ],
    criticalFailures: [
      'Forgets the budget was updated to $60,000 (says $50,000)',
      'Forgets headcount was updated to 30 (says 25)',
      'Cannot recall any dietary restrictions',
      'Completely ignores accessibility requirement',
    ],
  },
};
