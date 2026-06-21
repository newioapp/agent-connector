import { describe, it, expect, vi } from 'vitest';
import { AcpAgentSession } from '../../src/acp-agent-session';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';

/**
 * The chat-shared session serves many conversations from one slot keyed by the owner DM. A
 * context-window report must be attributed to the conversation whose turn is in flight (so clients
 * show usage against the conversation actually being viewed), not the slot's owner-DM key.
 */
describe('AcpAgentSession context-window reporting', () => {
  it('tags the report with the in-flight turn conversation, not the slot key', async () => {
    const reportContextWindow = vi.fn().mockResolvedValue(undefined);
    // prompt resolves immediately so the stream finishes and the turn completes cleanly.
    const connection = {
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    } as unknown as ClientSideConnection;

    const session = new AcpAgentSession({
      type: 'conversation',
      externalReferenceId: 'owner-dm-conv', // chat slot key
      promptFormatterVersion: '1.0.0',
      correlationId: 'sess-1',
      connection,
      sessionResponse: { sessionId: 'sess-1' } as unknown as NewSessionResponse,
      disposable: false,
      resumed: false,
      skipToken: '_skip',
      updateConfig: vi.fn().mockResolvedValue(undefined),
      reportContextWindow,
    });

    // Start a turn for a non-owner conversation. Starting the generator runs its body up to the
    // first suspension, which sets the in-flight conversation id synchronously.
    const gen = session.prompt('hi', 'conv-active');
    const drain = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) {
        /* consume segments until the stream finishes */
      }
    })();

    // Deliver a context-usage update mid-turn, while _currentConversationId === 'conv-active'.
    session.handleSessionUpdate({
      sessionId: 'sess-1',
      update: { sessionUpdate: 'usage_update', size: 100, used: 50 },
    } as never);

    await drain;

    expect(reportContextWindow).toHaveBeenCalledWith({ size: 100, used: 50 }, 'conv-active');
  });
});
