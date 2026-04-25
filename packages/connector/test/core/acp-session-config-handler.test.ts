import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpSessionConfigHandler } from '../../src/core/acp-session-config-handler';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';

/** Minimal mock connection — only setSessionMode and unstable_setSessionModel are used. */
function mockConnection(overrides?: Partial<ClientSideConnection>): ClientSideConnection {
  return {
    unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ClientSideConnection;
}

function makeSessionResponse(overrides?: Partial<NewSessionResponse>): NewSessionResponse {
  return {
    sessionId: 'sess-1',
    configOptions: null,
    models: null,
    modes: null,
    ...overrides,
  } as NewSessionResponse;
}

describe('AcpSessionConfigHandler', () => {
  describe('constructor — config extraction', () => {
    it('extracts model/mode from configOptions (preferred over legacy)', () => {
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          configOptions: [
            {
              type: 'select',
              category: 'model',
              currentValue: 'gpt-4',
              options: [
                { value: 'gpt-4', name: 'GPT-4' },
                { value: 'gpt-3.5', name: 'GPT-3.5', description: 'Faster' },
              ],
            },
            {
              type: 'select',
              category: 'mode',
              currentValue: 'code',
              options: [{ value: 'code', name: 'Code' }],
            },
          ] as never,
          // Legacy fields also present — should be ignored
          models: {
            availableModels: [{ modelId: 'legacy', name: 'Legacy' }],
            currentModelId: 'legacy',
          },
        }),
      );

      expect(handler.listModels()).toEqual({
        options: [
          { id: 'gpt-4', name: 'GPT-4', description: undefined },
          { id: 'gpt-3.5', name: 'GPT-3.5', description: 'Faster' },
        ],
        selectedId: 'gpt-4',
      });
      expect(handler.listModes()).toEqual({
        options: [{ id: 'code', name: 'Code', description: undefined }],
        selectedId: 'code',
      });
    });

    it('falls back to legacy models/modes when configOptions is null', () => {
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          models: {
            availableModels: [
              { modelId: 'm1', name: 'Model 1' },
              { modelId: 'm2', name: 'Model 2', description: 'Desc' },
            ],
            currentModelId: 'm1',
          },
          modes: {
            availableModes: [{ id: 'fast', name: 'Fast' }],
            currentModeId: 'fast',
          },
        }),
      );

      expect(handler.listModels()).toEqual({
        options: [
          { id: 'm1', name: 'Model 1', description: undefined },
          { id: 'm2', name: 'Model 2', description: 'Desc' },
        ],
        selectedId: 'm1',
      });
      expect(handler.listModes()).toEqual({
        options: [{ id: 'fast', name: 'Fast', description: undefined }],
        selectedId: 'fast',
      });
    });

    it('returns undefined for models/modes when nothing is provided', () => {
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());

      expect(handler.listModels()).toBeUndefined();
      expect(handler.listModes()).toBeUndefined();
    });

    it('flattens grouped configOptions', () => {
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          configOptions: [
            {
              type: 'select',
              category: 'model',
              currentValue: 'a',
              options: [
                {
                  label: 'Group 1',
                  options: [
                    { value: 'a', name: 'A' },
                    { value: 'b', name: 'B' },
                  ],
                },
                { value: 'c', name: 'C' },
              ],
            },
          ] as never,
        }),
      );

      expect(handler.listModels()?.options).toEqual([
        { id: 'a', name: 'A', description: undefined },
        { id: 'b', name: 'B', description: undefined },
        { id: 'c', name: 'C', description: undefined },
      ]);
    });

    it('ignores non-select configOptions', () => {
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          configOptions: [{ type: 'toggle', category: 'model', currentValue: true }] as never,
        }),
      );

      expect(handler.listModels()).toBeUndefined();
    });
  });

  describe('setModel', () => {
    it('calls connection.unstable_setSessionModel and updates local state', async () => {
      const conn = mockConnection();
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        conn,
        makeSessionResponse({
          models: {
            availableModels: [{ modelId: 'a', name: 'A' }],
            currentModelId: 'a',
          },
        }),
      );

      await handler.setModel('b');

      expect(conn.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('fires configChangedListener on setModel', async () => {
      const listener = vi.fn();
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );
      handler.setOnConfigChanged(listener);

      await handler.setModel('b');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('throws with ACP error details on failure', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ data: { details: 'Model not found' } }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        conn,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await expect(handler.setModel('bad')).rejects.toThrow('Model not found');
    });

    it('throws with error.message when no data.details', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue(new Error('connection lost')),
      } as never);
      const handler = new AcpSessionConfigHandler('sess-1', conn, makeSessionResponse());

      await expect(handler.setModel('x')).rejects.toThrow('connection lost');
    });

    it('throws fallback message for non-Error objects without details', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ code: 42 }),
      } as never);
      const handler = new AcpSessionConfigHandler('sess-1', conn, makeSessionResponse());

      await expect(handler.setModel('x')).rejects.toThrow('Failed to set model to "x"');
    });
  });

  describe('setMode', () => {
    it('calls connection.setSessionMode and updates local state', async () => {
      const conn = mockConnection();
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        conn,
        makeSessionResponse({
          modes: { availableModes: [{ id: 'fast', name: 'Fast' }], currentModeId: 'fast' },
        }),
      );

      await handler.setMode('slow');

      expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'slow' });
      expect(handler.listModes()?.selectedId).toBe('slow');
    });

    it('throws with ACP error message on failure', async () => {
      const conn = mockConnection({
        setSessionMode: vi.fn().mockRejectedValue({ message: 'invalid mode' }),
      } as never);
      const handler = new AcpSessionConfigHandler('sess-1', conn, makeSessionResponse());

      await expect(handler.setMode('bad')).rejects.toThrow('invalid mode');
    });
  });

  describe('handleSessionUpdate', () => {
    it('handles current_mode_update', () => {
      const listener = vi.fn();
      const handler = new AcpSessionConfigHandler(
        'sess-1',
        mockConnection(),
        makeSessionResponse({
          modes: { availableModes: [{ id: 'a', name: 'A' }], currentModeId: 'a' },
        }),
      );
      handler.setOnConfigChanged(listener);

      const handled = handler.handleSessionUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'b',
      } as never);

      expect(handled).toBe(true);
      expect(handler.listModes()?.selectedId).toBe('b');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('current_mode_update is no-op when modeConfig is undefined', () => {
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());

      const handled = handler.handleSessionUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'b',
      } as never);

      expect(handled).toBe(true);
      expect(handler.listModes()).toBeUndefined();
    });

    it('handles config_option_update for model', () => {
      const listener = vi.fn();
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());
      handler.setOnConfigChanged(listener);

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            category: 'model',
            currentValue: 'new-model',
            options: [{ value: 'new-model', name: 'New Model' }],
          },
        ],
      } as never);

      expect(handler.listModels()).toEqual({
        options: [{ id: 'new-model', name: 'New Model', description: undefined }],
        selectedId: 'new-model',
      });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('handles config_option_update for mode', () => {
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            category: 'mode',
            currentValue: 'turbo',
            options: [{ value: 'turbo', name: 'Turbo' }],
          },
        ],
      } as never);

      expect(handler.listModes()).toEqual({
        options: [{ id: 'turbo', name: 'Turbo', description: undefined }],
        selectedId: 'turbo',
      });
    });

    it('skips non-select config options in config_option_update', () => {
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [{ type: 'toggle', category: 'model', currentValue: true }],
      } as never);

      expect(handler.listModels()).toBeUndefined();
    });

    it('returns false for unrecognized update types', () => {
      const handler = new AcpSessionConfigHandler('sess-1', mockConnection(), makeSessionResponse());

      expect(handler.handleSessionUpdate({ sessionUpdate: 'agent_message_chunk' } as never)).toBe(false);
      expect(handler.handleSessionUpdate({ sessionUpdate: 'unknown' } as never)).toBe(false);
    });
  });
});
