/**
 * Area 7: Session Lifecycle Behavior
 *
 * Does the agent handle session transitions gracefully?
 */
import type { EvalScenario } from '../types.js';
import { defaultSetup, owner, alice, ownerDmConvId, aliceDmConvId, msg } from './fixtures.js';

export const sessionLifecycleScenarios: readonly EvalScenario[] = [
  {
    id: 'lifecycle-handoff-note-format',
    name: 'Produces valid handoff note at session end',
    description: 'Session-end prompt should produce a handoff note prefixed with HANDOFF: that is 2-4 sentences.',
    area: 'session_lifecycle',
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
            text: 'Can you help me plan a birthday party for Jorge next Saturday? We need a venue, cake, and guest list.',
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to planning request' },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria:
          'The agent output contains a "HANDOFF:" prefixed section that is 2-4 sentences long, describes the current state of work (party planning for Jorge, what has been discussed so far), and does NOT contain durable facts (those go to memory tools instead).',
        minScore: 4,
        description: 'Handoff note is properly formatted and useful',
      },
    ],
  },
  {
    id: 'lifecycle-memory-update-mid-session',
    name: 'Memory update prompt triggers get_memory + writes',
    description: 'Mid-session memory update prompt should trigger the agent to check existing memory and make updates.',
    area: 'session_lifecycle',
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
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "Hey, just so you know — my new phone number is 555-0123 and I'll be on vacation next week.",
          }),
        ],
      },
      { type: 'memory_update' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to owner DM' },
      {
        type: 'tool_called',
        tool: 'get_memory',
        description: 'Agent checks existing memory before updating',
      },
      {
        type: 'llm_judge',
        eventIndex: 1,
        criteria:
          "The agent calls memory tools (add_memory or update_memory) to persist the owner's phone number and/or vacation plans. It does not confuse the memory update prompt with a user message.",
        minScore: 4,
        description: 'Memory update prompt handled correctly',
      },
    ],
  },
];
