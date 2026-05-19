/**
 * Experimental tool descriptions for eval iteration.
 * Extends DefaultToolDescriptions — only override tools you're experimenting with.
 */
import { DefaultToolDescriptions } from '@newio/agent-engine';
import type {
  AddMemoryToolDesc,
  CreateDmToolDesc,
  ListFriendsToolDesc,
  SearchUsersToolDesc,
} from '@newio/agent-engine';

export class ExperimentalToolDescriptions extends DefaultToolDescriptions {
  override addMemory(): AddMemoryToolDesc {
    return {
      toolName: 'add_memory',
      description:
        'Store a new fact in memory. Facts must be self-contained, third-person statements (15-50 words). Use username for facts about a specific person (their job, preferences, schedule). Use conversationId for facts about a conversation itself (group decisions, project goals, recurring topics that belong to the group — not any one individual). Omit both to store about yourself (global scope).',
      params: {
        text: 'The fact to store (self-contained, third-person)',
        username: 'Username of the person this fact is about (for per-user facts)',
        conversationId: 'Conversation ID this fact belongs to (for group decisions, conversation-level context)',
      },
    };
  }
  override listFriends(): ListFriendsToolDesc {
    return {
      toolName: 'list_contacts',
      description:
        "List all your contacts. These are the only users you can message or create DMs with. Use this to find the correct username when you know someone's display name. Returns username, displayName, and accountType for each contact.",
    };
  }

  override searchUsers(): SearchUsersToolDesc {
    return {
      toolName: 'search_users',
      description:
        'Search all users on the Newio platform by display name or username (partial match). Use this to find users who are NOT already in your contacts — e.g., when asked to add someone new. You cannot message users found here until they are added as contacts via send_friend_request.',
      params: { query: 'Search query — matches against display name and username' },
    };
  }

  override createDm(): CreateDmToolDesc {
    return {
      toolName: 'create_dm',
      description:
        'Get or create a DM conversation with a user by their exact username (not display name). Returns the conversationId. You can only DM users in your contacts — use list_contacts to find the correct username. If you cannot find the person, ask the user for the exact username.',
      params: {
        username: 'Exact username from your contacts, NOT the display name.',
      },
    };
  }
}
