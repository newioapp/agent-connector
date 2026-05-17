/**
 * Area 2: Correct Tool Usage
 *
 * Does the agent call the right MCP tool for the task?
 */
import type { EvalScenario } from '../types.js';
import { defaultSetup, owner, alice, ownerDmConvId, aliceDmConvId, msg } from './fixtures.js';

export const toolUsageScenarios: readonly EvalScenario[] = [
  {
    id: 'tool-usage-no-double-send-dm',
    name: 'DM reply does not use messaging tools',
    description:
      'When replying to a DM, the agent should NOT call send_message/send_dm/dm_owner — the reply is auto-delivered.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({ conversationId: aliceDmConvId, conversationType: 'dm', sender: alice, text: 'Hey, what time is it?' }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond to a DM' },
      { type: 'tool_not_called', tool: 'send_message', description: 'Should not double-send via tool' },
      { type: 'tool_not_called', tool: 'send_dm', description: 'Should not double-send via send_dm' },
      { type: 'tool_not_called', tool: 'dm_owner', description: 'Should not dm_owner for a simple question' },
    ],
  },
  {
    id: 'tool-usage-cross-conversation-shared',
    name: 'Cross-conversation messaging uses send_dm (shared mode)',
    description: 'When owner asks agent to message someone else, agent uses send_dm in shared mode.',
    area: 'tool_usage',
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
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Please tell Priya that the meeting is moved to 3pm.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'send_dm',
        argsContain: { username: alice.username },
        description: 'Should use send_dm to reach Priya',
      },
    ],
  },
  {
    id: 'tool-usage-cross-conversation-isolated',
    name: 'Cross-conversation messaging uses create_dm + initiate_conversation (isolated mode)',
    description:
      'When owner asks agent to message someone else in isolated mode, agent uses create_dm then initiate_conversation.',
    area: 'tool_usage',
    sessionMode: 'isolated',
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
            text: 'Please tell Priya that the meeting is moved to 3pm.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: alice.username },
        description: 'Should create/get the DM conversation first',
      },
      {
        type: 'tool_called',
        tool: 'initiate_conversation',
        description: 'Should use initiate_conversation to delegate',
      },
      { type: 'tool_not_called', tool: 'send_dm', description: 'send_dm is not available in isolated mode' },
    ],
  },
  {
    id: 'tool-usage-contact-event-uses-tools',
    name: 'Contact events acted on via tools, not text reply',
    description: 'Agent should notify owner about an incoming friend request via dm_owner tool.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: alice.username,
            displayName: alice.displayName,
            accountType: alice.accountType,
            note: 'Hi! Would love to connect.',
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ],
    expectations: [
      { type: 'tool_called', tool: 'dm_owner', description: 'Should notify owner about the friend request' },
    ],
  },
];
