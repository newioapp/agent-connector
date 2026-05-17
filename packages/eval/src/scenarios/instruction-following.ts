/**
 * Area 11: Instruction Following & Tool Boundaries
 *
 * Does the agent stay within its available tool set?
 */
import type { EvalScenario } from '../types.js';
import { defaultSetup, owner, alice, ownerDmConvId, teamChatConvId, teamChat, msg } from './fixtures.js';

export const instructionFollowingScenarios: readonly EvalScenario[] = [
  {
    id: 'instruction-isolated-no-send-dm',
    name: 'Isolated mode does not call send_dm/dm_owner',
    description: 'In isolated mode, send_dm and dm_owner are unavailable. Agent should not attempt to call them.',
    area: 'instruction_following',
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
            text: 'Send a quick hello to Priya for me.',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'tool_not_called', tool: 'send_dm', description: 'send_dm is not available in isolated mode' },
      { type: 'tool_not_called', tool: 'dm_owner', description: 'dm_owner is not available in isolated mode' },
      { type: 'tool_called', tool: 'create_dm', description: 'Should use create_dm + initiate_conversation pattern' },
    ],
  },
  {
    id: 'instruction-no-double-send-group',
    name: 'No double-send in group conversations',
    description: 'When responding in a group (auto-delivered), agent must not also call send_message.',
    area: 'instruction_following',
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
            text: "@nova7x can you summarize yesterday's discussion?",
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to @mention' },
      { type: 'tool_not_called', tool: 'send_message', description: 'Reply is auto-delivered, no send_message needed' },
      { type: 'tool_not_called', tool: 'send_dm', description: 'Should not send via DM either' },
    ],
  },
  {
    id: 'instruction-no-invented-tools',
    name: 'Does not hallucinate non-existent tools',
    description: 'Agent should only call tools that are actually registered. No made-up tool names.',
    area: 'instruction_following',
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
            text: "What's the weather in Seattle right now?",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Agent responds to DM' },
      { type: 'tool_not_called', tool: 'get_weather', description: 'No weather tool exists' },
      { type: 'tool_not_called', tool: 'web_search', description: 'No web search tool exists' },
      { type: 'tool_not_called', tool: 'search', description: 'No generic search tool exists' },
    ],
  },
];
