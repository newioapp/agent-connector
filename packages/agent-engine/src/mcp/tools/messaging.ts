/**
 * Messaging tools — thin MCP wrappers over NewioApp messaging methods.
 *
 * What's exposed is decided per session by a {@link MessagingProfile}, not by the agent-wide session
 * mode: a session can only write to the conversation(s) it is responsible for. A session that maps 1:1
 * to a conversation (isolated conversation session, chat-shared work session) gets a `send_message`
 * that takes NO conversationId — it always targets that session's conversation. Multi-conversation
 * sessions (chat-shared chat hub, shared) keep an explicit-conversationId `send_message`. To reach a
 * conversation owned by a DIFFERENT session, a session uses `share_context` instead (the owning session
 * surfaces the message), which keeps that session's visibility complete.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IdGetter, NewioAppForMcp, ToolCallHook } from '../types';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/**
 * How `send_message` is exposed to a session:
 * - 'none'              — not registered (cron / contact sessions own no conversation).
 * - 'current'           — no conversationId arg; always sends to this session's own conversation.
 * - 'explicit'          — takes a conversationId (multi-conversation session).
 * - 'explicit-guarded'  — takes a conversationId but rejects work sessions (temp_group), which belong
 *                          to their own session and must be reached via share_context.
 */
export type SendMessageMode = 'none' | 'current' | 'explicit' | 'explicit-guarded';

/**
 * How `share_context` is exposed to a session:
 * - 'none'      — not registered (shared mode: a single session owns everything, nothing to hand off).
 * - 'explicit'  — takes a target conversationId (peer hand-off / hub → spoke).
 * - 'to-hub'    — no conversationId arg; always hands to the chat hub (chat-shared spoke → hub).
 */
export type ShareContextMode = 'none' | 'explicit' | 'to-hub';

export interface MessagingProfile {
  readonly sendMessage: SendMessageMode;
  readonly shareContext: ShareContextMode;
}

export function registerMessagingTools(
  server: McpServer,
  app: NewioAppForMcp,
  shareContext: (convId: string, context: string) => void,
  getCurrentConversationId: IdGetter,
  profile: MessagingProfile,
  /**
   * The conversation this session is responsible for (a 1:1 session's own conversation). Used as the
   * target for the 'current' send_message — it is stable, unlike the per-turn current conversation,
   * which is undefined on events that don't originate from a conversation (e.g. system.share_context).
   */
  ownConversationId: string | undefined,
  /** For shareContext 'to-hub': the chat hub (owner DM) conversation the context is handed to. */
  hubConversationId: string | undefined,
  onToolCall?: ToolCallHook,
): void {
  const filePathsSchema = z
    .array(z.string())
    .max(5)
    .optional()
    .describe('Optional local file paths to attach (max 5, absolute or relative)');

  if (profile.sendMessage === 'current') {
    server.registerTool(
      'send_message',
      {
        description:
          'Send a message into THIS conversation — the one this session is responsible for, optionally with file attachments (max 5). Use @username to mention members, @everyone to notify all, or @here to notify online members. When you are replying to a message, your reply is already delivered automatically — only use this to send an ADDITIONAL message, or to speak up after absorbing context from another session (system.share_context), where your text reply is NOT auto-sent.',
        inputSchema: {
          text: z.string().describe('Message text (supports markdown)'),
          filePaths: filePathsSchema,
        },
      },
      async ({ text: msgText, filePaths }) => {
        onToolCall?.('send_message', { text: msgText, filePaths });
        // Always the conversation this session is responsible for — stable across events (unlike the
        // live current conversation, which is undefined on e.g. a share_context turn). The 'current'
        // profile is only given to conversation-bound sessions, so this is always set.
        if (!ownConversationId) {
          return error('No conversation for this session — cannot send a message right now.');
        }
        await app.sendMessage(ownConversationId, msgText, filePaths ? { filePaths } : undefined);
        return text('Message sent');
      },
    );
  } else if (profile.sendMessage === 'explicit' || profile.sendMessage === 'explicit-guarded') {
    const guarded = profile.sendMessage === 'explicit-guarded';
    server.registerTool(
      'send_message',
      {
        description:
          'Send a message to a group chat or DM you are responsible for, optionally with file attachments (max 5). Use @username to mention members, @everyone to notify all, or @here to notify online members. ⚠️ Only use this for a DIFFERENT conversation — if you are replying to the current conversation, your reply is delivered automatically (using this would send it twice). To reach a work session, use share_context instead (it belongs to its own session).',
        inputSchema: {
          conversationId: z.string().describe('Conversation ID to send the message to'),
          text: z.string().describe('Message text (supports markdown)'),
          filePaths: filePathsSchema,
        },
      },
      async ({ conversationId, text: msgText, filePaths }) => {
        onToolCall?.('send_message', { conversationId, text: msgText, filePaths });
        if (getCurrentConversationId() === conversationId) {
          return error("Can't send to the current conversation — your reply is delivered automatically.");
        }
        const opts = filePaths ? { filePaths } : undefined;
        try {
          // The hub (guarded) must not message a work session — that belongs to its own session. The
          // work-session check lives in the app so this layer stays thin; it throws on a work session.
          if (guarded) {
            await app.sendMessageToManagedConversation(conversationId, msgText, opts);
          } else {
            await app.sendMessage(conversationId, msgText, opts);
          }
        } catch (err: unknown) {
          return error(err instanceof Error ? err.message : 'Could not send the message.');
        }
        return text('Message sent');
      },
    );
  }

  if (profile.shareContext === 'explicit') {
    server.registerTool(
      'share_context',
      {
        description:
          "Hand context to another of your own sessions, identified by its conversationId — e.g. brief a work session you just created (call create_work_session first) on why it exists and the goal, or pass a request to a conversation handled by a different session. The target is another instance of YOU — same agent, owner, and memory — in its own context window. Fire-and-forget: you get NO response, and it does NOT post a user-visible message by itself. The target session decides whether to surface anything (it must send_message explicitly). Don't use this for the current conversation; your reply is delivered automatically.",
        inputSchema: {
          conversationId: z.string().describe('Conversation ID of the target session to hand context to'),
          context: z
            .string()
            .describe(
              'The context to hand over — what the target should know and why. It already knows who you are and who your owner is; focus on the task, goal, who requested it, and any details it needs to act.',
            ),
        },
      },
      ({ conversationId, context }) => {
        onToolCall?.('share_context', { conversationId, context });
        if (getCurrentConversationId() === conversationId) {
          return error("Can't share context with the current conversation — your reply is delivered automatically.");
        }
        shareContext(conversationId, context);
        return text('Context shared with the target session.');
      },
    );
  } else if (profile.shareContext === 'to-hub') {
    server.registerTool(
      'share_context',
      {
        description:
          "Hand context back to your chat session — the session that handles your owner's DMs and group chats. Use this to report progress, a result, or anything you want surfaced to a person outside this work session. The chat session is another instance of YOU (same agent, owner, memory) and decides whether and where to message someone. Fire-and-forget: you get NO response, and it does NOT post a user-visible message by itself. To say something inside THIS work session, use send_message instead.",
        inputSchema: {
          context: z
            .string()
            .describe(
              'The context to hand to your chat session — what it should know and why (e.g. who to tell and what). It already knows who you are and who your owner is.',
            ),
        },
      },
      ({ context }) => {
        onToolCall?.('share_context', { context });
        if (!hubConversationId) {
          return error('No chat session is available to hand context to.');
        }
        shareContext(hubConversationId, context);
        return text('Context handed to your chat session.');
      },
    );
  }

  server.registerTool(
    'list_messages',
    {
      description: 'List messages in a conversation (paginated, newest first)',
      inputSchema: {
        conversationId: z.string().describe('Conversation ID'),
        limit: z.number().optional().describe('Max messages to return (default 20)'),
        beforeMessageId: z.string().optional().describe('Get messages before this message ID (for pagination)'),
      },
    },
    async ({ conversationId, limit, beforeMessageId }) => {
      onToolCall?.('list_messages', { conversationId, limit, beforeMessageId });
      const resp = await app.listMessages(conversationId, limit ?? 20, beforeMessageId);
      const messages = resp.messages.map((m) => ({
        messageId: m.messageId,
        senderId: m.senderId,
        text: m.content.text,
        attachments: m.content.attachments?.map((a) => ({
          fileName: a.fileName,
          contentType: a.contentType,
          size: a.size,
          s3Key: a.s3Key,
        })),
        createdAt: m.createdAt,
      }));
      return json(messages);
    },
  );
}
