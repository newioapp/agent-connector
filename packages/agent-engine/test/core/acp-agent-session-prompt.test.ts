import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';
import { AcpAgentSession } from '../../src/acp-agent-session.js';
import { AgentPromptError } from '../../src/errors.js';
import type { AcpAgentSessionInit } from '../../src/acp-agent-session.js';

function makeInit(connection: Partial<ClientSideConnection>): AcpAgentSessionInit {
  return {
    type: 'conversation',
    externalReferenceId: 'conv-1',
    promptFormatterVersion: 'v1',
    correlationId: 'corr-1',
    connection: connection as ClientSideConnection,
    sessionResponse: { sessionId: 'corr-1' } as unknown as NewSessionResponse,
    disposable: true,
    resumed: false,
    skipToken: '<skip>',
    updateConfig: vi.fn().mockResolvedValue(undefined),
    reportContextWindow: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AcpAgentSession.prompt — error handling', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('throws AgentPromptError (preserving cause) when the ACP prompt fails — no unhandled rejection', async () => {
    const acpError = { code: -32603, message: 'Internal error: [ede_diagnostic] stop_reason=tool_use' };
    const session = new AcpAgentSession(makeInit({ prompt: vi.fn().mockRejectedValue(acpError) }));

    let thrown: unknown;
    try {
      for await (const _segment of session.prompt('hello', 'conv-1')) {
        // drain
      }
    } catch (err: unknown) {
      thrown = err;
    }

    // Let any orphaned rejection escalate to the unhandledRejection handler.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(thrown).toBeInstanceOf(AgentPromptError);
    expect((thrown as AgentPromptError).cause).toBe(acpError);
    expect(unhandled).toEqual([]);
  });

  it('does not leak an unhandled rejection when the consumer abandons the generator mid-turn', async () => {
    const acpError = new Error('boom');
    const session = new AcpAgentSession(makeInit({ prompt: vi.fn().mockRejectedValue(acpError) }));

    const gen = session.prompt('hello', 'conv-1');
    // Abandon without fully draining (skips `await promptDone`).
    await gen.return(undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unhandled).toEqual([]);
  });

  it('completes cleanly without throwing when the prompt succeeds', async () => {
    const session = new AcpAgentSession(makeInit({ prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }) }));

    await expect(
      (async () => {
        for await (const _segment of session.prompt('hello', 'conv-1')) {
          // drain
        }
      })(),
    ).resolves.toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });
});
