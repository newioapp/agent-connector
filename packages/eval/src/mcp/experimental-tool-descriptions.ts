/**
 * Experimental tool descriptions for eval iteration.
 * Extends DefaultToolDescriptions — only override tools you're experimenting with.
 */
import { DefaultToolDescriptions } from '@newio/agent-engine';
import type { CreateDmToolDesc, ListFriendsToolDesc, SearchUsersToolDesc } from '@newio/agent-engine';

export class ExperimentalToolDescriptions extends DefaultToolDescriptions {
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
