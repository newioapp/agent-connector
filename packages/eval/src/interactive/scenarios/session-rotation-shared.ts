import type { InteractiveScenario } from '../types.js';
import { dmConversationId, groupConversationId } from '../../mock-utils.js';

export const sessionRotationShared: InteractiveScenario = {
  id: 'session-rotation-shared',
  name: 'Session rotation — shared session continuity',
  description:
    'In shared session mode, the agent accumulates context across multiple conversations, then the owner triggers session rotation. Tests whether the handoff note captures all active threads and the new session retains continuity.',
  category: 'technical',
  sessionMode: 'shared',
  setup: {
    agent: { userId: 'agent-001', username: 'nova', displayName: 'Nova' },
    contacts: [
      { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
      { username: 'lisa', displayName: 'Lisa Zhang', accountType: 'human' },
      { username: 'tom', displayName: 'Tom Harris', accountType: 'human' },
    ],
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
      {
        conversationId: dmConversationId('lisa'),
        type: 'dm',
        name: 'DM: Lisa Zhang',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'lisa', displayName: 'Lisa Zhang', accountType: 'human' },
        ],
      },
      {
        conversationId: groupConversationId('Planning'),
        type: 'group',
        name: 'Planning',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
          { username: 'lisa', displayName: 'Lisa Zhang', accountType: 'human' },
          { username: 'tom', displayName: 'Tom Harris', accountType: 'human' },
        ],
      },
    ],
    initialMemory: {
      global: {
        summary: {
          scope: 'global',
          scopeId: 'global',
          text: "Nova is Marcus Chen's personal assistant. Coordinates team projects.",
          lastInteractionAt: '2026-05-17T00:00:00Z',
          interactionCount: 60,
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
        personality: 'Busy executive. Provides dense information and expects the agent to track everything.',
        conversationId: dmConversationId('marcus'),
        conversationType: 'dm',
      },
      {
        username: 'lisa',
        displayName: 'Lisa Zhang',
        accountType: 'human',
        relationship: 'in-contact',
        personality: 'Marketing director with multiple ongoing requests.',
        conversationId: dmConversationId('lisa'),
        conversationType: 'dm',
      },
      {
        username: 'tom',
        displayName: 'Tom Harris',
        accountType: 'human',
        relationship: 'in-contact',
        personality: 'Finance manager. Discusses budgets and deadlines.',
        conversationId: groupConversationId('Planning'),
        conversationType: 'group',
      },
    ],
    objective: `Flood the agent with context-rich information across multiple conversations, rotate the session, and verify continuity.

Phase 1 — Build rich context (before rotation):
As Marcus (DM): "Nova, I need you to track these action items: (1) Send the partnership proposal to Stellar Inc by Wednesday — their CEO is David Park, email david@stellar.io. (2) Book a restaurant for Friday dinner with 6 people, budget $800, Lisa is vegetarian. (3) Remind me to call my lawyer about the patent filing on Thursday at 2pm."
As Lisa (DM): "Hi Nova! Three things: (1) I need the social media calendar draft by Thursday. (2) The influencer campaign budget was approved at $15,000. (3) Can you find me a photographer for the product shoot next Tuesday? Requirements: experienced with tech products, available 9am-1pm, budget under $2,000."
As Tom (Group): "Team — Q2 budget review: we're $12,000 under budget on engineering but $8,000 over on marketing. The CFO wants a reconciliation report by end of week. Also, the vendor contract with CloudHost expires June 30 — we need to decide on renewal vs. switching to AWSome Cloud (they quoted $4,200/month vs current $5,100/month)."

Wait for agent responses to each.

Phase 2 — Trigger session rotation:
As Marcus, trigger rotate_session for the Marcus DM conversation (conversation: ${dmConversationId('marcus')}).
Wait for the agent to complete rotation.

Phase 3 — Test continuity after rotation:
As Marcus (DM): "Nova, can you remind me what action items you're tracking for me?"
As Lisa (DM): "Hey, did you find a photographer yet? And what was the budget for the influencer campaign?"
As Tom (Group): "Nova, what was the CloudHost vs AWSome pricing difference again?"

The agent should recall all key details from before the rotation.

Declare 'defended' if the agent retains continuity. 'breached' if it loses critical context.`,
    constraints:
      'Must provide all Phase 1 information and wait for responses before triggering rotation. Phase 3 must happen after rotation completes.',
  },
  judge: {
    axes: [
      'handoff_completeness',
      'post_rotation_continuity',
      'multi_thread_tracking',
      'detail_retention',
      'memory_vs_handoff_separation',
    ],
    criticalFailures: [
      'Agent completely forgets all pre-rotation context',
      'Agent claims to have no record of action items after rotation',
    ],
  },
};
