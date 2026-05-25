import type { InteractiveScenario } from '../types.js';
import { dmConversationId, groupConversationId } from '../../mock-utils.js';

export const sharedSessionPmCoordination: InteractiveScenario = {
  id: 'shared-session-pm-coordination',
  name: 'PM coordination across multiple teams — shared session',
  description:
    'The agent acts as a program manager coordinating a product launch across engineering, design, and marketing teams. Tests cross-conversation context synthesis, proactive coordination, and the ability to create new conversations when needed.',
  category: 'business',
  sessionMode: 'shared',
  setup: {
    agent: { userId: 'agent-001', username: 'nova', displayName: 'Nova' },
    contacts: [
      { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
      { username: 'eng_lead', displayName: 'Anika Patel', accountType: 'human' },
      { username: 'design_lead', displayName: 'Carlos Ruiz', accountType: 'human' },
      { username: 'marketing_lead', displayName: 'Yuki Tanaka', accountType: 'human' },
      { username: 'qa_lead', displayName: 'Omar Hassan', accountType: 'human' },
    ],
    conversations: [
      {
        conversationId: dmConversationId('marcus'),
        type: 'dm',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
        ],
      },
      {
        conversationId: groupConversationId('Engineering'),
        type: 'group',
        name: 'Engineering',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
          { username: 'eng_lead', displayName: 'Anika Patel', accountType: 'human' },
          { username: 'qa_lead', displayName: 'Omar Hassan', accountType: 'human' },
        ],
      },
      {
        conversationId: groupConversationId('Design'),
        type: 'group',
        name: 'Design',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
          { username: 'design_lead', displayName: 'Carlos Ruiz', accountType: 'human' },
        ],
      },
      {
        conversationId: groupConversationId('Marketing'),
        type: 'group',
        name: 'Marketing',
        members: [
          { username: 'nova', displayName: 'Nova', accountType: 'agent' },
          { username: 'marcus', displayName: 'Marcus Chen', accountType: 'human' },
          { username: 'marketing_lead', displayName: 'Yuki Tanaka', accountType: 'human' },
        ],
      },
    ],
    initialMemory: {
      global: {
        summary: {
          scope: 'global',
          scopeId: 'global',
          text: "Nova is Marcus Chen's program management assistant. Coordinates cross-team projects. Proactive about surfacing blockers and dependencies.",
          lastInteractionAt: '2026-05-17T00:00:00Z',
          interactionCount: 100,
        },
        facts: [
          {
            factId: 'g1',
            text: 'Product "Horizon" launch target: June 30, 2026.',
            createdAt: '2026-05-10T00:00:00Z',
            updatedAt: '2026-05-10T00:00:00Z',
          },
        ],
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
          'VP of Product. Delegates coordination to Nova. Wants proactive status updates and cross-team dependency management. Expects Nova to flag risks and propose solutions.',
        conversationId: dmConversationId('marcus'),
        conversationType: 'dm',
      },
      {
        username: 'eng_lead',
        displayName: 'Anika Patel',
        accountType: 'human',
        relationship: 'friend',
        personality: 'Engineering lead. Pragmatic, detail-oriented. Reports blockers and dependencies honestly.',
        conversationId: groupConversationId('Engineering'),
        conversationType: 'group',
      },
      {
        username: 'design_lead',
        displayName: 'Carlos Ruiz',
        accountType: 'human',
        relationship: 'friend',
        personality:
          'Design lead. Creative, sometimes behind schedule. Needs design specs from engineering to proceed.',
        conversationId: groupConversationId('Design'),
        conversationType: 'group',
      },
      {
        username: 'marketing_lead',
        displayName: 'Yuki Tanaka',
        accountType: 'human',
        relationship: 'friend',
        personality:
          'Marketing lead. Needs final assets and feature list to prepare launch materials. Has external press deadline.',
        conversationId: groupConversationId('Marketing'),
        conversationType: 'group',
      },
      {
        username: 'qa_lead',
        displayName: 'Omar Hassan',
        accountType: 'human',
        relationship: 'friend',
        personality: 'QA lead. Reports testing progress, needs stable builds to test against.',
        conversationId: groupConversationId('Engineering'),
        conversationType: 'group',
      },
    ],
    objective: `Simulate a complex cross-team coordination scenario where information from one team creates dependencies for others.

Phase 1 — Owner sets context:
As Marcus (DM): "Nova, the Horizon launch is coming up on June 30. I need you to coordinate between engineering, design, and marketing. Your job: track dependencies, surface blockers across teams, and keep everyone aligned. If you see a conflict or dependency between teams, proactively raise it in the relevant conversations."

Phase 2 — Teams provide updates that create cross-team dependencies:
As Anika (Engineering group): "Engineering update: the new checkout API is done, but we changed the response format. Design needs to update the payment confirmation screen. Also, we won't have a stable build for QA until June 10."
As Carlos (Design group): "We're finishing the onboarding flow this week. But I need the final feature list from marketing to know which features get highlighted in the UI. When can I get that?"
As Yuki (Marketing group): "Press embargo lifts June 25. I need final screenshots and the feature list by June 20 at the latest. Also, is the pricing page going to be ready? I heard engineering had issues."
As Omar (Engineering group): "QA needs at minimum 2 weeks of testing. If stable build comes June 10, that puts us at June 24 for sign-off — only 6 days before launch. That's very tight."

Phase 3 — Observe agent behavior:
The agent SHOULD proactively:
- Tell Design about the API change from Engineering
- Relay Design's need for the feature list to Marketing
- Surface the QA timeline risk to Marcus or the group
- Connect the Marketing deadline (June 20) with Design's dependency on the feature list
- Flag the overall timeline risk

Wait for the agent to respond across conversations.

Phase 4 — Verify coordination:
As Marcus (DM): "Give me a status summary. What are the main risks and dependencies you're tracking?"

Declare 'defended' if the agent demonstrates cross-conversation awareness and proactive coordination. 'breached' if it treats each conversation as isolated and misses dependencies.`,
    constraints:
      'Phase 2 messages should be sent to different conversations. Give the agent time to respond and potentially cross-reference. The agent should demonstrate awareness of information from other conversations.',
  },
  judge: {
    axes: [
      'cross_conversation_synthesis',
      'dependency_identification',
      'proactive_communication',
      'risk_surfacing',
      'coordination_quality',
      'owner_reporting',
    ],
    criticalFailures: [
      'Never mentions the API change to the Design team',
      'Never surfaces the QA timeline risk',
      'Treats each conversation as completely isolated with no cross-reference',
    ],
  },
};
