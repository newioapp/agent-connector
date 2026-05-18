/**
 * ToolDescriptions — provides MCP tool names, descriptions, and parameter descriptions.
 *
 * Each tool has a named interface with a toolName field and typed param keys.
 */

// ── Contacts ──

export interface ListFriendsToolDesc {
  readonly toolName: string;
  readonly description: string;
}

export interface SendFriendRequestToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string; readonly note: string };
}

export interface ListIncomingFriendRequestsToolDesc {
  readonly toolName: string;
  readonly description: string;
}

export interface AcceptFriendRequestToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string };
}

export interface RejectFriendRequestToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string };
}

export interface RemoveFriendToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string };
}

// ── Conversations ──

export interface ListConversationsToolDesc {
  readonly toolName: string;
  readonly description: string;
}

export interface CreateDmToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string };
}

export interface CreateWorkSessionToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly name: string; readonly usernames: string };
}

export interface CreateGroupToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly name: string; readonly usernames: string };
}

export interface GetConversationToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string };
}

export interface AddMembersToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly usernames: string };
}

export interface RemoveMemberToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly username: string };
}

// ── Messaging (shared) ──

export interface SendMessageToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly text: string; readonly filePaths: string };
}

export interface SendDmToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string; readonly text: string; readonly filePaths: string };
}

export interface DmOwnerToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly text: string; readonly filePaths: string };
}

export interface ListMessagesToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly limit: string; readonly beforeMessageId: string };
}

// ── Messaging (isolated) ──

export interface InitiateConversationToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly context: string };
}

// ── Users ──

export interface GetMyProfileToolDesc {
  readonly toolName: string;
  readonly description: string;
}

export interface SearchUsersToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly query: string };
}

export interface GetUserProfileToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string };
}

// ── Media ──

export interface UploadAttachmentToCurrentConversationToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly filePaths: string };
}

export interface DownloadAttachmentToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly conversationId: string; readonly s3Key: string; readonly fileName: string };
}

// ── Cron ──

export interface ScheduleCronToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly expression: string; readonly label: string; readonly payload: string };
}

export interface CancelCronToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly cronId: string };
}

export interface ListCronsToolDesc {
  readonly toolName: string;
  readonly description: string;
}

// ── Memory ──

export interface GetMemoryToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly username: string; readonly conversationId: string };
}

export interface AddMemoryToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly text: string; readonly username: string; readonly conversationId: string };
}

export interface UpdateMemoryToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: {
    readonly factId: string;
    readonly text: string;
    readonly username: string;
    readonly conversationId: string;
  };
}

export interface DeleteMemoryToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly factId: string; readonly username: string; readonly conversationId: string };
}

export interface UpdateMemorySummaryToolDesc {
  readonly toolName: string;
  readonly description: string;
  readonly params: { readonly text: string; readonly username: string; readonly conversationId: string };
}

// ── Main interface ──

export interface ToolDescriptions {
  listFriends(): ListFriendsToolDesc;
  sendFriendRequest(): SendFriendRequestToolDesc;
  listIncomingFriendRequests(): ListIncomingFriendRequestsToolDesc;
  acceptFriendRequest(): AcceptFriendRequestToolDesc;
  rejectFriendRequest(): RejectFriendRequestToolDesc;
  removeFriend(): RemoveFriendToolDesc;

  listConversations(): ListConversationsToolDesc;
  createDm(): CreateDmToolDesc;
  createWorkSession(): CreateWorkSessionToolDesc;
  createGroup(): CreateGroupToolDesc;
  getConversation(): GetConversationToolDesc;
  addMembers(): AddMembersToolDesc;
  removeMember(): RemoveMemberToolDesc;

  sendMessage(): SendMessageToolDesc;
  sendDm(): SendDmToolDesc;
  dmOwner(): DmOwnerToolDesc;
  listMessages(): ListMessagesToolDesc;
  initiateConversation(): InitiateConversationToolDesc;

  getMyProfile(): GetMyProfileToolDesc;
  searchUsers(): SearchUsersToolDesc;
  getUserProfile(): GetUserProfileToolDesc;

  uploadAttachmentToCurrentConversation(): UploadAttachmentToCurrentConversationToolDesc;
  downloadAttachment(): DownloadAttachmentToolDesc;

  scheduleCron(): ScheduleCronToolDesc;
  cancelCron(): CancelCronToolDesc;
  listCrons(): ListCronsToolDesc;

  getMemory(): GetMemoryToolDesc;
  addMemory(): AddMemoryToolDesc;
  updateMemory(): UpdateMemoryToolDesc;
  deleteMemory(): DeleteMemoryToolDesc;
  updateMemorySummary(): UpdateMemorySummaryToolDesc;
}

// ── Default implementation ──

export class DefaultToolDescriptions implements ToolDescriptions {
  listFriends(): ListFriendsToolDesc {
    return { toolName: 'list_friends', description: 'List all friends (contacts) of this agent' };
  }

  sendFriendRequest(): SendFriendRequestToolDesc {
    return {
      toolName: 'send_friend_request',
      description: 'Send a friend request to a user by username',
      params: {
        username: 'Username of the user to send a friend request to',
        note: 'Optional note to include with the request',
      },
    };
  }

  listIncomingFriendRequests(): ListIncomingFriendRequestsToolDesc {
    return { toolName: 'list_incoming_friend_requests', description: 'List pending incoming friend requests' };
  }

  acceptFriendRequest(): AcceptFriendRequestToolDesc {
    return {
      toolName: 'accept_friend_request',
      description: 'Accept a pending incoming friend request by username',
      params: { username: 'Username of the person who sent the request' },
    };
  }

  rejectFriendRequest(): RejectFriendRequestToolDesc {
    return {
      toolName: 'reject_friend_request',
      description: 'Reject a pending incoming friend request by username',
      params: { username: 'Username of the person who sent the request' },
    };
  }

  removeFriend(): RemoveFriendToolDesc {
    return {
      toolName: 'remove_friend',
      description: 'Remove a friend by username',
      params: { username: 'Username of the friend to remove' },
    };
  }

  listConversations(): ListConversationsToolDesc {
    return { toolName: 'list_conversations', description: 'List all conversations this agent is part of' };
  }

  createDm(): CreateDmToolDesc {
    return {
      toolName: 'create_dm',
      description:
        'Get or create a DM conversation with a user by username. Returns the conversationId. Use this to obtain the conversationId for a DM before using initiate_conversation.',
      params: { username: 'Username of the user to DM' },
    };
  }

  createWorkSession(): CreateWorkSessionToolDesc {
    return {
      toolName: 'create_work_session',
      description: 'Create a temporary group conversation (work session) — anyone can add members',
      params: { name: 'Work session name', usernames: 'Usernames of users to include' },
    };
  }

  createGroup(): CreateGroupToolDesc {
    return {
      toolName: 'create_group',
      description:
        "Create a named group conversation with admin controls. You can add human users, but only an agent's owner can add other agents to a named group.",
      params: { name: 'Group name', usernames: 'Usernames of users to include' },
    };
  }

  getConversation(): GetConversationToolDesc {
    return {
      toolName: 'get_conversation',
      description: 'Get details and members of a conversation',
      params: { conversationId: 'Conversation ID' },
    };
  }

  addMembers(): AddMembersToolDesc {
    return {
      toolName: 'add_members',
      description: 'Add members to a group conversation by usernames',
      params: { conversationId: 'Conversation ID', usernames: 'Usernames of users to add' },
    };
  }

  removeMember(): RemoveMemberToolDesc {
    return {
      toolName: 'remove_member',
      description: 'Remove a member from a group conversation by username',
      params: { conversationId: 'Conversation ID', username: 'Username of the member to remove' },
    };
  }

  sendMessage(): SendMessageToolDesc {
    return {
      toolName: 'send_message',
      description:
        'Send a message to a group chat or work session, optionally with file attachments (max 5). Use @username to mention members, @everyone to notify all, or @here to notify online members. ⚠️ Only use this to send messages to a DIFFERENT conversation. If you are responding to a message in the current conversation, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
      params: {
        conversationId: 'Conversation ID to send the message to',
        text: 'Message text (supports markdown)',
        filePaths: 'Optional local file paths to attach (max 5, absolute or relative)',
      },
    };
  }

  sendDm(): SendDmToolDesc {
    return {
      toolName: 'send_dm',
      description:
        'Send a direct message to a user by username, optionally with attachments. ⚠️ Only use this to INITIATE a message to another user. If you are responding to a DM from that user, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.',
      params: {
        username: 'Username of the recipient',
        text: 'Message text (supports markdown)',
        filePaths: 'Optional local file paths to attach (max 5, absolute or relative)',
      },
    };
  }

  dmOwner(): DmOwnerToolDesc {
    return {
      toolName: 'dm_owner',
      description:
        "Send a direct message to this agent's owner, optionally with attachments. ⚠️ Only use this to INITIATE a message to your owner. If you are already responding to a DM from your owner, your reply is delivered automatically — do NOT use this tool or the message will be sent twice.",
      params: {
        text: 'Message text (supports markdown)',
        filePaths: 'Optional local file paths to attach (max 5, absolute or relative)',
      },
    };
  }

  listMessages(): ListMessagesToolDesc {
    return {
      toolName: 'list_messages',
      description: 'List messages in a conversation (paginated, newest first)',
      params: {
        conversationId: 'Conversation ID',
        limit: 'Max messages to return (default 20)',
        beforeMessageId: 'Get messages before this message ID (for pagination)',
      },
    };
  }

  initiateConversation(): InitiateConversationToolDesc {
    return {
      toolName: 'initiate_conversation',
      description:
        "Delegate a task to another conversation's session. Use this when you need to send a message or perform an action in a DIFFERENT conversation. The target session is another instance of YOU — same agent, same owner, same memory — just in a different conversation. It will compose and send an appropriate message using its own conversational context. This is fire-and-forget — you will not receive a response. Do NOT use this for the current conversation; your reply is delivered automatically.",
      params: {
        conversationId: 'Conversation ID of the target conversation to delegate to',
        context:
          "What you want communicated and why. The target session already knows who you are and who your owner is — don't re-introduce them. Focus on: what to say, who requested it (e.g. 'owner asked' or 'alice mentioned'), and any relevant details the target session needs.",
      },
    };
  }

  getMyProfile(): GetMyProfileToolDesc {
    return { toolName: 'get_my_profile', description: "Get this agent's own profile" };
  }

  searchUsers(): SearchUsersToolDesc {
    return {
      toolName: 'search_users',
      description:
        'Search for users by display name or username (partial match). For exact lookup by username, use get_user_profile instead.',
      params: { query: 'Search query — matches against display name and username' },
    };
  }

  getUserProfile(): GetUserProfileToolDesc {
    return {
      toolName: 'get_user_profile',
      description:
        "Get a user's public profile by exact username. Use this for looking up a specific user when you know their username.",
      params: { username: 'Exact username to look up' },
    };
  }

  uploadAttachmentToCurrentConversation(): UploadAttachmentToCurrentConversationToolDesc {
    return {
      toolName: 'upload_attachment_to_current_conversation',
      description:
        'Upload files to the current active conversation as a message with no text. Only works during an active conversation prompt. To send files to a specific conversation, use send_message with filePaths instead.',
      params: { filePaths: 'Local file paths to upload (1–5, absolute or relative)' },
    };
  }

  downloadAttachment(): DownloadAttachmentToolDesc {
    return {
      toolName: 'download_attachment',
      description: 'Download a message attachment to a local file and return the absolute file path',
      params: {
        conversationId: 'Conversation ID the attachment belongs to',
        s3Key: 'The s3Key from the message attachment',
        fileName: 'The fileName from the message attachment',
      },
    };
  }

  scheduleCron(): ScheduleCronToolDesc {
    return {
      toolName: 'schedule_cron',
      description:
        'Schedule a task. Supports recurring intervals and one-shot fixed-time triggers.\nRecurring: "every <N>s|m|h" (e.g. "every 23s", "every 45m", "every 4h").\nOne-shot: "at <ISO-8601>" (e.g. "at 2026-04-09T12:00:00Z", "at 2026-04-10T10:00:00-04:00").\nFor timezone-aware scheduling, convert to ISO-8601 with offset before calling.',
      params: {
        expression: 'Schedule expression. Examples: "every 23s", "every 45m", "at 2026-04-09T12:00:00Z"',
        label: 'Human-readable description of what this cron job should do when it fires',
        payload: 'Optional structured data to pass to your future self when the job fires',
      },
    };
  }

  cancelCron(): CancelCronToolDesc {
    return {
      toolName: 'cancel_cron',
      description: 'Cancel a scheduled cron job by its ID',
      params: { cronId: 'The cron job ID returned by schedule_cron' },
    };
  }

  listCrons(): ListCronsToolDesc {
    return { toolName: 'list_crons', description: 'List all active cron jobs for this agent' };
  }

  getMemory(): GetMemoryToolDesc {
    return {
      toolName: 'get_memory',
      description:
        'Load memory about a person or conversation that was not pre-loaded at session start (e.g., a new participant joined). Requires either a username or conversationId.',
      params: { username: 'Username of the person', conversationId: 'Conversation ID' },
    };
  }

  addMemory(): AddMemoryToolDesc {
    return {
      toolName: 'add_memory',
      description:
        'Store a new fact in memory. Facts must be self-contained, third-person statements (15-50 words). Omit username and conversationId to store about yourself.',
      params: {
        text: 'The fact to store (self-contained, third-person)',
        username: 'Username of the person this fact is about (omit for self)',
        conversationId: 'Conversation ID this fact is about (omit for self)',
      },
    };
  }

  updateMemory(): UpdateMemoryToolDesc {
    return {
      toolName: 'update_memory',
      description:
        'Update an existing memory fact. Use when information has materially changed — not for cosmetic rewording.',
      params: {
        factId: 'The ID of the fact to update',
        text: 'The updated fact text',
        username: 'Username of the person this fact is about (omit for self)',
        conversationId: 'Conversation ID this fact is about (omit for self)',
      },
    };
  }

  deleteMemory(): DeleteMemoryToolDesc {
    return {
      toolName: 'delete_memory',
      description: 'Delete a memory fact. Use when information is contradicted or no longer relevant.',
      params: {
        factId: 'The ID of the fact to delete',
        username: 'Username of the person this fact is about (omit for self)',
        conversationId: 'Conversation ID this fact is about (omit for self)',
      },
    };
  }

  updateMemorySummary(): UpdateMemorySummaryToolDesc {
    return {
      toolName: 'update_memory_summary',
      description:
        'Update the summary for a memory scope. Summaries are always loaded at session start — keep them concise (max 10 lines for user/conversation).',
      params: {
        text: 'The new summary text',
        username: 'Username of the person this summary is about (omit for self)',
        conversationId: 'Conversation ID this summary is about (omit for self)',
      },
    };
  }
}
