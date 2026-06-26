/**
 * Area 2: Correct Tool Usage
 *
 * Tests that the agent invokes the right MCP tool for each task.
 * Prompts are implicit — the agent must infer which tool to use from context.
 * Covers every MCP tool (except cron) at least once, plus multi-turn complex scenarios.
 */
import type { EvalScenario } from '../../types.js';
import {
  defaultSetup,
  owner,
  alice,
  bob,
  stranger,
  siblingAgent,
  ownerDmConvId,
  aliceDmConvId,
  teamChatConvId,
  teamChat,
  msg,
} from './fixtures.js';

export const toolUsageScenarios: readonly EvalScenario[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Individual tool coverage — one scenario per tool
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Contacts ──────────────────────────────────────────────────────────────

  {
    id: 'tool-list-contacts',
    name: 'list_contacts — "Who do I know?"',
    description: 'Agent should use list_contacts when asked about its social circle.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Can you check who you currently have as friends? I want to make sure Priya is in your contact list.',
          }),
        ],
      },
    ],
    expectations: [
      { type: 'tool_called', tool: 'list_contacts', description: 'Should list contacts to check' },
      { type: 'no_skip', eventIndex: 0, description: 'Agent should respond' },
    ],
  },

  {
    id: 'tool-send-friend-request',
    name: 'send_friend_request — "Add this person"',
    description: 'Agent should send a friend request when asked to connect with someone new.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "There's someone with username dtran991 — can you reach out and add them? Say something friendly in the request.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'send_friend_request',
        argsContain: { username: 'dtran991' },
        description: 'Should send friend request to the specified username',
      },
    ],
  },

  {
    id: 'tool-list-incoming-friend-requests',
    name: 'list_incoming_friend_requests — "Any pending requests?"',
    description: 'Agent should check pending requests when asked about new connection attempts.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "Has anyone tried to add you recently? Check if there are pending friend requests you haven't dealt with yet.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_incoming_friend_requests',
        description: 'Should check pending incoming requests',
      },
    ],
  },

  {
    id: 'tool-accept-friend-request',
    name: 'accept_friend_request — contact event with approval instruction',
    description: 'Agent should accept a friend request when owner instructs to approve.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: stranger.username,
            displayName: stranger.displayName,
            accountType: stranger.accountType,
            note: 'Hey! We met at the conference.',
            timestamp: new Date().toISOString(),
          },
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Oh yeah I remember Derek! Go ahead and accept his request.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'accept_friend_request',
        argsContain: { username: 'dtran991' },
        description: 'Should accept the friend request from Derek',
      },
    ],
  },

  {
    id: 'tool-reject-friend-request',
    name: 'reject_friend_request — owner says to decline',
    description: 'Agent should reject a friend request when owner says no.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'contact',
        events: [
          {
            type: 'contact.request_received',
            username: stranger.username,
            displayName: stranger.displayName,
            accountType: stranger.accountType,
            note: 'Add me please',
            timestamp: new Date().toISOString(),
          },
        ],
      },
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "I don't know this person. Reject it.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'reject_friend_request',
        argsContain: { username: 'dtran991' },
        description: 'Should reject the friend request',
      },
    ],
  },

  {
    id: 'tool-remove-friend',
    name: 'remove_friend — "Unfriend this person"',
    description: 'Agent should remove a friend when instructed.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "I don't want you connected to Jorge anymore. Please remove him from your friends.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_contacts',
        severity: 'warning',
        description: 'May look up contacts to confirm username for "Jorge"',
      },
      {
        type: 'tool_called',
        tool: 'remove_friend',
        argsContain: { username: 'jleon88' },
        description: 'Should remove Jorge from friends',
      },
    ],
  },

  // ── Conversations ─────────────────────────────────────────────────────────

  {
    id: 'tool-list-conversations',
    name: 'list_conversations — "What chats am I in?"',
    description: 'Agent should list conversations when asked about its active chats.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'What conversations are you currently participating in? Any group chats?',
          }),
        ],
      },
    ],
    expectations: [{ type: 'tool_called', tool: 'list_conversations', description: 'Should list all conversations' }],
  },

  {
    id: 'tool-create-dm-isolated',
    name: 'create_dm — resolve DM conversation before delegating (isolated)',
    description: 'In isolated mode, agent needs create_dm to get a conversationId before share_context.',
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
            text: "Send Priya a quick message saying I'll be 10 minutes late.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'priya7k' },
        description: 'Should create/get DM to obtain conversationId',
      },
      {
        type: 'tool_called',
        tool: 'share_context',
        description: "Should hand the message to the target conversation's session via share_context",
      },
    ],
  },

  {
    id: 'tool-create-work-session',
    name: 'create_work_session — "Set up a workspace for us"',
    description: 'Agent should create a work session for collaborative tasks.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: siblingAgent.username, displayName: siblingAgent.displayName, accountType: 'agent' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'I need a workspace where you, me, and TaskBot can hash out the deployment plan together. Call it "Deployment Review".',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_work_session',
        argsContain: { name: 'Deployment Review' },
        description: 'Should create work session with the specified name',
      },
    ],
  },

  {
    id: 'tool-create-group',
    name: 'create_group — "Make a group chat"',
    description: 'Agent should create a named group when asked for a persistent group.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Create a group called "Weekend Plans" with Priya and Jorge so we can coordinate the trip.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_group',
        argsContain: { name: 'Weekend Plans' },
        description: 'Should create a named group',
      },
    ],
  },

  {
    id: 'tool-get-conversation',
    name: 'get_conversation / list_conversation_members — "Who is in this chat?"',
    description: 'Agent should fetch conversation members when asked who is in the group.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: alice,
            text: "Hey Nova, can you remind me who's all in this group?",
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_conversation_members',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should list members of the conversation',
      },
    ],
  },

  {
    id: 'tool-get-conversation-metadata',
    name: 'get_conversation — "Who runs this group?"',
    description: 'Agent should use get_conversation when asked about group metadata like admins.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `Who are the admins of the Team Chat group? Is it a regular group or a work session?`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'get_conversation',
        description: 'Should fetch conversation metadata to check type and admins',
      },
    ],
  },

  {
    id: 'tool-add-members',
    name: 'add_members — "Bring someone into the group"',
    description: 'Agent should add members to a group when instructed.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: owner,
            text: 'Can you add Jorge to this group? His username is jleon88.',
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'add_members',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should add the user to the conversation',
      },
    ],
  },

  {
    id: 'tool-remove-member',
    name: 'remove_member — "Kick someone from the group"',
    description: 'Agent should remove a member from a group conversation.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `Remove Priya from the Team Chat group (conversation ${teamChatConvId}). She's moved to another team.`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'remove_member',
        argsContain: { username: 'priya7k' },
        description: 'Should remove Priya from the group',
      },
    ],
  },

  // ── Messaging ─────────────────────────────────────────────────────────────

  {
    id: 'tool-send-message-shared',
    name: 'send_message — message a different group (shared)',
    description: 'In shared mode, agent uses send_message to post in a group it is not currently chatting in.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `Post an update in the Team Chat group (${teamChatConvId}) saying the release is delayed until Thursday.`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'send_message',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should send to the group conversation',
      },
    ],
  },

  {
    id: 'tool-send-dm-shared',
    name: 'DM a user directly (shared)',
    description: 'In shared mode, agent uses create_dm to resolve the DM, then send_message.',
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
            text: 'DM Priya and ask if she finished the code review. Her username is priya7k.',
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
      { type: 'tool_called', tool: 'send_message', description: 'Should deliver the message to the resolved DM' },
    ],
  },

  {
    id: 'tool-no-double-send-dm',
    name: 'No tool for DM reply — auto-delivered',
    description: 'When replying to a DM, the agent should NOT use messaging tools — the reply is auto-delivered.',
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
      {
        type: 'tool_not_called',
        tool: 'share_context',
        description: 'Should not delegate for the current conversation',
      },
    ],
  },

  {
    id: 'tool-initiate-conversation-isolated',
    name: 'share_context — delegate to another session (isolated)',
    description: 'In isolated mode, agent delegates cross-conversation messaging via share_context.',
    area: 'tool_usage',
    sessionMode: 'isolated',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `Let the Team Chat group (${teamChatConvId}) know that standup is cancelled today.`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'share_context',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should hand off to the Team Chat conversation session',
      },
      {
        type: 'tool_not_called',
        tool: 'send_message',
        description: 'Team Chat is a different conversation — must use share_context, not send_message',
      },
    ],
  },

  {
    id: 'tool-list-messages',
    name: 'list_messages — "What did they say earlier?"',
    description: 'Agent should fetch message history when asked about past messages.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `I missed some messages in Team Chat (${teamChatConvId}). Can you look at what was said recently and give me a summary?`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_messages',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should fetch message history',
      },
    ],
  },

  // ── Users ─────────────────────────────────────────────────────────────────

  {
    id: 'tool-search-users',
    name: 'search_users — "Find someone I vaguely remember"',
    description: 'Agent should search users when given a partial name and no username.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "I'm trying to find someone named Derek. I don't remember his full username. Can you look him up?",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'tool_called', tool: 'search_users', description: 'Should search by partial name' },
      {
        type: 'tool_not_called',
        tool: 'get_user_profile',
        severity: 'warning',
        description: 'get_user_profile requires exact username — search is more appropriate here',
      },
    ],
  },

  {
    id: 'tool-get-user-profile',
    name: 'get_user_profile — "Look up this specific user"',
    description: 'Agent should use get_user_profile for an exact username lookup.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "What's priya7k's display name and bio? Pull up her profile.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'get_user_profile',
        argsContain: { username: 'priya7k' },
        description: 'Should look up exact username',
      },
      {
        type: 'tool_not_called',
        tool: 'search_users',
        severity: 'warning',
        description: 'Exact username given — no need to search',
      },
    ],
  },

  // ── Media ─────────────────────────────────────────────────────────────────

  {
    id: 'tool-upload-attachment',
    name: 'upload_attachment_to_current_conversation — "Share this file"',
    description: 'Agent should upload a file to the current conversation when asked to share it.',
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
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: 'Can you send me that report? The file is at /tmp/quarterly-report.pdf',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'upload_attachment_to_current_conversation',
        description: 'Should upload the file to the current conversation',
      },
    ],
  },

  {
    id: 'tool-download-attachment',
    name: 'download_attachment — "Save that file they sent"',
    description: 'Agent should download an attachment when asked to process a file from a message.',
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
          {
            messageId: crypto.randomUUID(),
            conversationId: aliceDmConvId,
            conversationType: 'dm' as const,
            senderUserId: alice.userId,
            senderUsername: alice.username,
            senderDisplayName: alice.displayName,
            senderAccountType: alice.accountType,
            relationship: alice.relationship,
            isOwnMessage: false,
            text: 'Here is the design mockup I mentioned — please download it and take a look.',
            attachments: [
              {
                attachmentType: 'file' as const,
                s3Key: 'media/conv-123/mockup.png',
                fileName: 'mockup.png',
                contentType: 'image/png',
                size: 524288,
              },
            ],
            timestamp: new Date().toISOString(),
            status: 'new' as const,
          },
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'download_attachment',
        argsContain: { s3Key: 'media/conv-123/mockup.png', fileName: 'mockup.png' },
        description: 'Should download the attachment from the message',
      },
    ],
  },

  // ── Memory ────────────────────────────────────────────────────────────────

  {
    id: 'tool-get-memory',
    name: 'get_memory — "What do you remember about them?"',
    description: 'Agent should fetch memory when asked what it knows about someone not pre-loaded.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: owner,
            text: 'Jorge just joined this group. What do you have on file about him?',
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_contacts',
        description: 'Should look up contacts to resolve "Jorge" to username jleon88',
      },
      {
        type: 'tool_called',
        tool: 'get_memory',
        argsContain: { username: 'jleon88' },
        description: 'Should fetch memory for Jorge using his username',
      },
    ],
  },

  {
    id: 'tool-add-memory',
    name: 'add_memory — "Remember this fact"',
    description: 'Agent should store a new fact when explicitly told to remember something.',
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
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Important: Priya is allergic to shellfish. Remember this for future reference when planning team dinners.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'add_memory',
        argsContain: { username: 'priya7k' },
        description: 'Should store the fact about Priya',
      },
    ],
  },

  {
    id: 'tool-update-memory',
    name: 'update_memory — "Actually, that changed"',
    description: 'Agent should update a fact when told information has changed.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      memoryStore: {
        priya7k: {
          summary: 'Priya is a frontend developer who works on the dashboard team.',
          facts: [{ factId: 'fact_priya_1', text: 'Priya works at Acme Corp as a frontend developer.' }],
        },
      },
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "By the way, Priya changed jobs — she's now at Stripe. Update what you know about her.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'get_memory',
        argsContain: { username: 'priya7k' },
        description: 'Should check existing memory first',
      },
      {
        type: 'tool_called',
        tool: 'update_memory',
        argsContain: { factId: 'fact_priya_1' },
        description: 'Should update the existing fact about her job',
      },
    ],
  },

  {
    id: 'tool-delete-memory',
    name: 'delete_memory — "Forget that, it was wrong"',
    description: 'Agent should delete a fact when told it was incorrect.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      memoryStore: {
        priya7k: {
          summary: null,
          facts: [
            { factId: 'fact_priya_wrong', text: 'Priya is married to Jorge.' },
            { factId: 'fact_priya_2', text: 'Priya enjoys hiking on weekends.' },
          ],
        },
      },
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "That thing you have stored about Priya being married to Jorge — that's completely wrong. They're just coworkers. Delete that.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_contacts',
        description: 'Should look up contacts to resolve "Priya" to username priya7k',
      },
      {
        type: 'tool_called',
        tool: 'get_memory',
        argsContain: { username: 'priya7k' },
        description: 'Should check memory to find the incorrect fact',
      },
      {
        type: 'tool_called',
        tool: 'delete_memory',
        argsContain: { factId: 'fact_priya_wrong' },
        description: 'Should delete the incorrect fact',
      },
    ],
  },

  {
    id: 'tool-update-memory-summary',
    name: 'update_memory_summary — session end memory maintenance',
    description: 'Agent should update summary during session end when significant new info was learned.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [{ username: alice.username, displayName: alice.displayName, accountType: 'human' }],
      memoryStore: {
        priya7k: {
          summary: 'Priya is a frontend developer.',
          facts: [
            { factId: 'fact_p1', text: 'Priya works at Stripe as a senior engineer.' },
            { factId: 'fact_p2', text: 'Priya leads the payments team.' },
            { factId: 'fact_p3', text: 'Priya prefers async communication over meetings.' },
          ],
        },
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
            text: "Hey! Just got promoted to Staff Engineer last week! Also, I'm switching to the Infrastructure team starting next month. Exciting times 🎉",
          }),
        ],
      },
      { type: 'session_end' },
    ],
    expectations: [
      { type: 'no_skip', eventIndex: 0, description: 'Should congratulate Priya' },
      {
        type: 'tool_called',
        tool: 'get_memory',
        eventIndex: 1,
        description: 'Should check existing memory at session end',
      },
      {
        type: 'tool_called',
        tool: 'update_memory_summary',
        eventIndex: 1,
        argsContain: { username: 'priya7k' },
        description: 'Should update summary with significant changes (promotion + team move)',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Multi-turn complex scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'tool-multi-event-coordination-shared',
    name: 'Multi-tool: Coordinate a meeting across contacts (shared)',
    description:
      'Owner asks agent to message each contact. Requires list_contacts → create_dm + send_message per contact.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "I need you to reach out to all my contacts and let them know there's a team social on Friday at 6pm. Check who's in your friends list and message each of them.",
          }),
        ],
      },
    ],
    expectations: [
      { type: 'tool_called', tool: 'list_contacts', description: 'Should enumerate contacts first' },
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'priya7k' },
        description: "Should resolve Priya's DM about the social",
      },
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'jleon88' },
        description: "Should resolve Jorge's DM about the social",
      },
      { type: 'tool_called', tool: 'send_message', description: 'Should deliver the invites via send_message' },
    ],
  },

  {
    id: 'tool-multi-onboard-new-contact',
    name: 'Multi-tool: Onboard a new contact end-to-end',
    description: 'Owner mentions someone new. Agent must search them, send request, then remember info about them.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: defaultSetup,
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "There's a new team member named Derek Tran — username dtran991. Add him as a friend, and remember that he's our new DevOps engineer starting Monday.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'send_friend_request',
        argsContain: { username: 'dtran991' },
        description: 'Should send friend request',
      },
      {
        type: 'tool_called',
        tool: 'add_memory',
        description: 'Should remember the info about Derek',
      },
    ],
  },

  {
    id: 'tool-multi-group-setup-and-announce',
    name: 'Multi-tool: Create group and announce (shared)',
    description:
      'Owner asks agent to create a group, add people, and post a welcome message — requires create_group → send_message.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: 'Set up a group called "Project Alpha" with Priya and Jorge, then post a welcome message introducing the project — it\'s about rebuilding our CI pipeline.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'create_group',
        argsContain: { name: 'Project Alpha' },
        description: 'Should create the group first',
      },
      {
        type: 'tool_called',
        tool: 'send_message',
        description: 'Should post a welcome message to the new group',
      },
    ],
  },

  {
    id: 'tool-multi-investigate-and-report',
    name: 'Multi-tool: Investigate chat history then report to owner',
    description:
      'Agent is in a group. Owner asks it to summarize what happened. Requires list_messages → synthesis → respond.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: `I've been offline all morning. Check the Team Chat (${teamChatConvId}) history and tell me if anything important came up. Get the last 50 messages or so.`,
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_messages',
        argsContain: { conversationId: teamChatConvId },
        description: 'Should fetch message history from Team Chat',
      },
      { type: 'no_skip', eventIndex: 0, description: 'Should respond with a summary' },
    ],
  },

  {
    id: 'tool-multi-memory-driven-intro-shared',
    name: 'Multi-tool: Memory-informed introduction in new group (shared)',
    description:
      'Agent is added to a group with someone it has memory about. Should fetch memory and use it to interact contextually.',
    area: 'tool_usage',
    sessionMode: 'shared',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
      memoryStore: {
        jleon88: {
          summary: 'Jorge is a backend engineer who enjoys coffee and board games.',
          facts: [
            { factId: 'jorge_1', text: 'Jorge prefers working in Rust over Go.' },
            { factId: 'jorge_2', text: "Jorge's birthday is March 15." },
          ],
        },
      },
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: teamChatConvId,
            conversationType: 'group',
            sender: bob,
            text: "Hey Nova! Just joined the group. Marcus said you'd remember some stuff about me. What do you recall?",
            groupName: 'Team Chat',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'get_memory',
        argsContain: { username: 'jleon88' },
        description: 'Should fetch memory about Jorge to answer',
      },
      { type: 'no_skip', eventIndex: 0, description: 'Should respond using memory' },
      {
        type: 'response_contains',
        eventIndex: 0,
        contains: ['Rust', 'coffee'],
        severity: 'warning',
        description: 'Response should reference recalled facts',
      },
    ],
  },

  {
    id: 'tool-multi-cleanup-departed-member',
    name: 'Multi-tool: Handle departed team member cleanup',
    description:
      'Owner mentions someone left the company in natural language. Agent must resolve the name to a username, find the right conversation, remove them, unfriend, and clean up memory.',
    area: 'tool_usage',
    sessionMode: 'both',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
      conversations: [teamChat],
      memoryStore: {
        jleon88: {
          summary: 'Jorge is a backend engineer on the platform team.',
          facts: [{ factId: 'jorge_work', text: 'Jorge works on the payment processing service.' }],
        },
      },
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: ownerDmConvId,
            conversationType: 'dm',
            sender: owner,
            text: "Hey, Jorge left the company today. Can you remove him from all our group chats, unfriend him, and clear out anything you've stored about him? Thanks.",
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_contacts',
        description: 'Should look up contacts to resolve "Jorge" to username jleon88',
      },
      {
        type: 'tool_called',
        tool: 'list_conversations',
        description: 'Should list conversations to find which groups Jorge might be in',
      },
      {
        type: 'tool_called',
        tool: 'remove_member',
        argsContain: { username: 'jleon88' },
        description: 'Should remove Jorge from group(s)',
      },
      {
        type: 'tool_called',
        tool: 'remove_friend',
        argsContain: { username: 'jleon88' },
        description: 'Should unfriend Jorge',
      },
      {
        type: 'tool_called',
        tool: 'get_memory',
        argsContain: { username: 'jleon88' },
        description: 'Should check what memory exists before deleting',
      },
      {
        type: 'tool_called',
        tool: 'delete_memory',
        argsContain: { factId: 'jorge_work' },
        description: 'Should delete stored facts about Jorge',
      },
    ],
  },

  {
    id: 'tool-multi-cross-conv-isolated',
    name: 'Multi-tool: Cross-conversation relay with context (isolated)',
    description:
      'In isolated mode, agent must create_dm + share_context with rich context to relay information between conversations.',
    area: 'tool_usage',
    sessionMode: 'isolated',
    setup: {
      ...defaultSetup,
      contacts: [
        { username: alice.username, displayName: alice.displayName, accountType: 'human' },
        { username: bob.username, displayName: bob.displayName, accountType: 'human' },
      ],
    },
    events: [
      {
        type: 'message',
        messages: [
          msg({
            conversationId: aliceDmConvId,
            conversationType: 'dm',
            sender: alice,
            text: 'Hey Nova, can you let Jorge know that the API endpoint he asked about is /api/v2/payments/refund? He messaged me about it yesterday but I forgot to reply. Also tell him the auth header format is Bearer <token>.',
          }),
        ],
      },
    ],
    expectations: [
      {
        type: 'tool_called',
        tool: 'list_contacts',
        severity: 'warning',
        description: "May look up contacts to find Jorge's username",
      },
      {
        type: 'tool_called',
        tool: 'create_dm',
        argsContain: { username: 'jleon88' },
        description: 'Should create/get DM with Jorge',
      },
      {
        type: 'tool_called',
        tool: 'share_context',
        description: 'Should hand off with context about the API info via share_context',
      },
    ],
  },
];
