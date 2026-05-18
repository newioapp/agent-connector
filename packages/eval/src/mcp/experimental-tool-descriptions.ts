/**
 * Experimental tool descriptions for eval iteration.
 *
 * Extends DefaultToolDescriptions — only override tools you're experimenting with.
 * All others fall through to production defaults.
 */
import { DefaultToolDescriptions } from '@newio/agent-engine';
import type {
  InitiateConversationToolDesc,
  AddMemoryToolDesc,
  UpdateMemoryToolDesc,
  DeleteMemoryToolDesc,
  UpdateMemorySummaryToolDesc,
  GetMemoryToolDesc,
  SendMessageToolDesc,
  SendDmToolDesc,
  DmOwnerToolDesc,
} from '@newio/agent-engine';

export class ExperimentalToolDescriptions extends DefaultToolDescriptions {
  override initiateConversation(): InitiateConversationToolDesc {
    return {
      description:
        "Delegate a task to another conversation's session. The target session is another instance of you — same agent, same memory — in a different conversation. It will receive the context you provide and compose an appropriate reply in that conversation. Fire-and-forget: you will not receive a response back.",
      params: {
        conversationId: 'Target conversation ID to delegate to. Use create_dm or list_conversations to find it.',
        context:
          "Concise instruction for the target session: what to say, who triggered the request, and relevant details. Don't re-introduce yourself or your owner — the target session already knows.",
      },
    };
  }

  override getMemory(): GetMemoryToolDesc {
    return {
      description:
        'Load memory for a specific person or conversation not pre-loaded at session start. Call this BEFORE adding/updating memory to avoid duplicates. Provide username OR conversationId, not both.',
      params: {
        username: 'Username of the person to load memory about',
        conversationId: 'Conversation ID to load memory about',
      },
    };
  }

  override addMemory(): AddMemoryToolDesc {
    return {
      description:
        'Store a new fact. Facts are self-contained, third-person, 15-50 words. Pass the 4-gate test: (1) useful in future sessions, (2) not already stored, (3) factual not ephemeral, (4) no secrets/PII. Omit username and conversationId for global (self) scope.',
      params: {
        text: 'Self-contained fact in third person. No pronouns. Example: "Alice prefers TypeScript strict mode."',
        username: 'Username this fact is about. Omit for self/global scope.',
        conversationId: 'Conversation this fact is about. Omit for self/global scope.',
      },
    };
  }

  override updateMemory(): UpdateMemoryToolDesc {
    return {
      description:
        'Replace an existing fact with updated information. Only use when the information has materially changed — not for cosmetic rewording. Call get_memory first to find the factId.',
      params: {
        factId: 'ID of the fact to update (from get_memory response)',
        text: 'Updated fact text (same format rules as add_memory)',
        username: 'Username this fact is about. Omit for self/global scope.',
        conversationId: 'Conversation this fact is about. Omit for self/global scope.',
      },
    };
  }

  override deleteMemory(): DeleteMemoryToolDesc {
    return {
      description:
        'Delete a fact that is contradicted, obsolete, or no longer relevant. Call get_memory first to find the factId.',
      params: {
        factId: 'ID of the fact to delete (from get_memory response)',
        username: 'Username this fact is about. Omit for self/global scope.',
        conversationId: 'Conversation this fact is about. Omit for self/global scope.',
      },
    };
  }

  override updateMemorySummary(): UpdateMemorySummaryToolDesc {
    return {
      description:
        'Replace the summary for a memory scope. Summaries are loaded at every session start — keep concise (max 8 lines). Summarize the relationship/purpose, not individual facts.',
      params: {
        text: 'New summary text. Max 8 lines. High-level overview only.',
        username: 'Username this summary is about. Omit for self/global scope.',
        conversationId: 'Conversation this summary is about. Omit for self/global scope.',
      },
    };
  }

  override sendMessage(): SendMessageToolDesc {
    return {
      description:
        'Send a message to a DIFFERENT group/work session. Supports @mentions (@username, @everyone, @here) and file attachments. WARNING: Never use this to reply to the current conversation — your text output is already delivered there.',
      params: {
        conversationId: 'Target conversation ID (must be different from current)',
        text: 'Message text (markdown supported)',
        filePaths: 'Optional file paths to attach (max 5)',
      },
    };
  }

  override sendDm(): SendDmToolDesc {
    return {
      description:
        'Send a DM to a user by username. Use only to INITIATE contact — if you are already responding to their DM, your text output is delivered automatically. Do not double-send.',
      params: {
        username: 'Recipient username',
        text: 'Message text (markdown supported)',
        filePaths: 'Optional file paths to attach (max 5)',
      },
    };
  }

  override dmOwner(): DmOwnerToolDesc {
    return {
      description:
        'Send a DM to your owner. Use only to INITIATE contact or report issues — if you are already responding to their DM, your text output is delivered automatically. Do not double-send.',
      params: {
        text: 'Message text (markdown supported)',
        filePaths: 'Optional file paths to attach (max 5)',
      },
    };
  }
}
