/**
 * Experimental tool descriptions for eval iteration.
 * Extends DefaultToolDescriptions — only override tools you're experimenting with.
 *
 * Key experiment: emphasize that all "username" params require the exact username
 *, NOT the display name.
 */
import { DefaultToolDescriptions } from '@newio/agent-engine';
import type {
  AcceptFriendRequestToolDesc,
  AddMembersToolDesc,
  AddMemoryToolDesc,
  CreateDmToolDesc,
  CreateGroupToolDesc,
  CreateWorkSessionToolDesc,
  DeleteMemoryToolDesc,
  GetMemoryToolDesc,
  GetUserProfileToolDesc,
  ListFriendsToolDesc,
  RejectFriendRequestToolDesc,
  RemoveFriendToolDesc,
  RemoveMemberToolDesc,
  SearchUsersToolDesc,
  SendDmToolDesc,
  SendFriendRequestToolDesc,
  UpdateMemoryToolDesc,
  UpdateMemorySummaryToolDesc,
} from '@newio/agent-engine';

export class ExperimentalToolDescriptions extends DefaultToolDescriptions {
  // ── Contacts ──────────────────────────────────────────────────────────────

  override listFriends(): ListFriendsToolDesc {
    return {
      toolName: 'list_contacts',
      description:
        "List all your contacts. These are the only users you can message or create DMs with. Use this to find the correct username when you know someone's display name. Returns username, displayName, and accountType for each contact.",
      output: {
        username: 'Unique username identifier',
        displayName: 'Human-readable display name',
        accountType: 'Either "human" or "agent"',
      },
    };
  }

  override sendFriendRequest(): SendFriendRequestToolDesc {
    return {
      toolName: 'send_friend_request',
      description:
        'Send a friend request to a user by their exact username (not display name). Use search_users first if you only know their display name.',
      params: {
        username: 'Exact username of the user, NOT their display name',
        note: 'Optional note to include with the request',
      },
    };
  }

  override acceptFriendRequest(): AcceptFriendRequestToolDesc {
    return {
      toolName: 'accept_friend_request',
      description: "Accept a pending incoming friend request by the sender's exact username (not display name).",
      params: {
        username: 'Exact username of the person who sent the request, NOT their display name',
      },
    };
  }

  override rejectFriendRequest(): RejectFriendRequestToolDesc {
    return {
      toolName: 'reject_friend_request',
      description: "Reject a pending incoming friend request by the sender's exact username (not display name).",
      params: {
        username: 'Exact username of the person who sent the request, NOT their display name',
      },
    };
  }

  override removeFriend(): RemoveFriendToolDesc {
    return {
      toolName: 'remove_friend',
      description:
        'Remove a friend by their exact username. Use list_contacts to find the correct username if you only know their display name.',
      params: {
        username: 'Exact username of the friend to remove, NOT their display name',
      },
    };
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  override createDm(): CreateDmToolDesc {
    return {
      toolName: 'create_dm',
      description:
        'Get or create a DM conversation with a user by their exact username (not display name). Returns the conversationId. You can only DM users in your contacts — use list_contacts to find the correct username. If you cannot find the person, ask the user for the exact username.',
      params: {
        username: 'Exact username from your contacts, NOT the display name',
      },
      output: { conversationId: 'The DM conversation ID (existing or newly created)' },
    };
  }

  override createWorkSession(): CreateWorkSessionToolDesc {
    return {
      toolName: 'create_work_session',
      description:
        'Create a work session — a collaborative conversation for you, your owner, and peer agents to coordinate on tasks.',
      params: {
        name: 'Work session name',
        usernames: 'Array of exact usernames, NOT display names',
      },
      output: { conversationId: 'The newly created work session conversation ID' },
    };
  }

  override createGroup(): CreateGroupToolDesc {
    return {
      toolName: 'create_group',
      description:
        "Create a named group conversation with admin controls. You can add human users, but only an agent's owner can add other agents to a named group.",
      params: {
        name: 'Group name',
        usernames: 'Array of exact usernames to include, NOT display names',
      },
      output: { conversationId: 'The newly created group conversation ID' },
    };
  }

  override addMembers(): AddMembersToolDesc {
    return {
      toolName: 'add_members',
      description: 'Add members to a group conversation by their exact usernames.',
      params: {
        conversationId: 'Conversation ID',
        usernames: 'Array of exact usernames to add, NOT display names',
      },
    };
  }

  override removeMember(): RemoveMemberToolDesc {
    return {
      toolName: 'remove_member',
      description: 'Remove a member from a group conversation by their exact username.',
      params: {
        conversationId: 'Conversation ID',
        username: 'Exact username of the member to remove, NOT their display name',
      },
    };
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  override sendDm(): SendDmToolDesc {
    return {
      toolName: 'send_dm',
      description:
        'Send a direct message to a user by their exact username (not display name), optionally with attachments. ⚠️ Only use this to INITIATE a message to another user. If you are responding to a DM from that user, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
      params: {
        username: 'Exact username of the recipient, NOT their display name',
        text: 'Message text (supports markdown)',
        filePaths: 'Optional local file paths to attach (max 5, absolute or relative)',
      },
    };
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  override searchUsers(): SearchUsersToolDesc {
    return {
      toolName: 'search_users',
      description:
        'Search all users on the Newio platform by display name or username (partial match). Use this to find users who are NOT already in your contacts — e.g., when asked to add someone new. You cannot message users found here until they are added as contacts via send_friend_request.',
      params: { query: 'Search query — matches against display name and username' },
      output: {
        userId: 'Unique user ID',
        username: 'Username (use this for other tools, not the display name)',
        displayName: 'Display name',
        accountType: 'Either "human" or "agent"',
      },
    };
  }

  override getUserProfile(): GetUserProfileToolDesc {
    return {
      toolName: 'get_user_profile',
      description:
        "Get a user's public profile by their exact username (not display name). Use list_contacts or search_users first if you only know the display name.",
      params: { username: 'Exact username to look up, NOT their display name' },
      output: {
        userId: 'Unique user ID',
        username: 'Username',
        displayName: 'Display name',
        accountType: 'Either "human" or "agent"',
        bio: 'Profile bio text',
        avatarUrl: 'Avatar image URL',
      },
    };
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  override getMemory(): GetMemoryToolDesc {
    return {
      toolName: 'get_memory',
      description:
        "Load memory about a person or conversation that was not pre-loaded at session start. Requires either an exact username or conversationId. IMPORTANT: A person's username is often different from their display name. Use list_contacts first to find the correct username if you only know their display name.",
      params: {
        username: 'Exact username of the person, NOT their display name. Use list_contacts to resolve.',
        conversationId: 'Conversation ID',
      },
      output: {
        summary: 'High-level summary of the scope (or null if not set)',
        facts: 'Array of { factId, text } stored facts',
      },
    };
  }

  override addMemory(): AddMemoryToolDesc {
    return {
      toolName: 'add_memory',
      description:
        'Store a new fact in memory. Facts must be self-contained, third-person statements (15-50 words). Use username for facts about a specific person (their job, preferences, schedule). Use conversationId for facts about a conversation itself (group decisions, project goals, recurring topics that belong to the group — not any one individual). Omit both to store about yourself (global scope). IMPORTANT: Use list_contacts to find the exact username — do not guess from display names.',
      params: {
        text: 'The fact to store (self-contained, third-person)',
        username: 'Exact username of the person this fact is about, NOT their display name',
        conversationId: 'Conversation ID this fact belongs to (for group decisions, conversation-level context)',
      },
    };
  }

  override updateMemory(): UpdateMemoryToolDesc {
    return {
      toolName: 'update_memory',
      description:
        'Update an existing memory fact. Use when information has materially changed — not for cosmetic rewording. Use list_contacts to find the exact username if you only know their display name.',
      params: {
        factId: 'The ID of the fact to update',
        text: 'The updated fact text',
        username: 'Exact username of the person this fact is about, NOT their display name',
        conversationId: 'Conversation ID this fact is about (omit for self)',
      },
    };
  }

  override deleteMemory(): DeleteMemoryToolDesc {
    return {
      toolName: 'delete_memory',
      description:
        'Delete a memory fact. Use when information is contradicted or no longer relevant. Use list_contacts to find the exact username if you only know their display name.',
      params: {
        factId: 'The ID of the fact to delete',
        username: 'Exact username of the person this fact is about, NOT their display name',
        conversationId: 'Conversation ID this fact is about (omit for self)',
      },
    };
  }

  override updateMemorySummary(): UpdateMemorySummaryToolDesc {
    return {
      toolName: 'update_memory_summary',
      description:
        'Update the summary for a memory scope. Summaries are always loaded at session start — keep them concise (max 10 lines for user/conversation).',
      params: {
        text: 'The new summary text',
        username: 'Exact username of the person this summary is about, NOT their display name',
        conversationId: 'Conversation ID this summary is about (omit for self)',
      },
    };
  }
}
