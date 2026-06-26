/**
 * Area 11: Instruction Following & Tool Boundaries
 *
 * Does the agent stay within its available tool set?
 */
import type { EvalScenario } from '../../types.js';
import { defaultSetup, owner, alice, ownerDmConvId, teamChatConvId, teamChat, msg } from './fixtures.js';

export const instructionFollowingScenarios: readonly EvalScenario[] = [
  {
    id: 'instruction-isolated-no-send-dm',
    name: 'Isolated mode DMs a user via create_dm + share_context',
    description:
      'In isolated mode, to DM a user the agent uses create_dm to resolve the conversation, then share_context.',
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
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'priya7k' },
        description: "Should resolve Priya's DM conversation",
      },
      {
        type: 'tool_called',
        tool: 'share_context',
        description: 'Should deliver via share_context (cross-conversation)',
      },
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
      {
        type: 'tool_not_called',
        tool: 'share_context',
        description: 'Should not delegate for the current conversation',
      },
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
