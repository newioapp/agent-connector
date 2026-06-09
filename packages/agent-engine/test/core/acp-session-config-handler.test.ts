import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpSessionConfigHandler } from '../../src/acp-session-config-handler';
import type { SessionConfig } from '../../src/types';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';

/** Expose private methods for testing. */
interface TestableConfigHandler {
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
}

/** Minimal mock connection — only setSessionMode and unstable_setSessionModel are used. */
function mockConnection(overrides?: Partial<ClientSideConnection>): ClientSideConnection {
  return {
    unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
    setSessionMode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ClientSideConnection;
}

function mockUpdateConfig(): (config: SessionConfig) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
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
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
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
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
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
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      expect(handler.listModels()).toBeUndefined();
      expect(handler.listModes()).toBeUndefined();
    });

    it('flattens grouped configOptions', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
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
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
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
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          models: {
            availableModels: [{ modelId: 'a', name: 'A' }],
            currentModelId: 'a',
          },
        }),
      );

      await (handler as unknown as TestableConfigHandler).setModel('b');

      expect(conn.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('throws with ACP error details on failure', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ data: { details: 'Model not found' } }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await expect((handler as unknown as TestableConfigHandler).setModel('bad')).rejects.toThrow('Model not found');
    });

    it('falls back to setSessionConfigOption when unstable_setSessionModel is not implemented', async () => {
      const setSessionConfigOption = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        // -32601 = JSON-RPC "method not found": agent doesn't implement the unstable API.
        unstable_setSessionModel: vi.fn().mockRejectedValue({ code: -32601, message: 'Method not found' }),
        setSessionConfigOption,
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await (handler as unknown as TestableConfigHandler).setModel('b');

      expect(setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'sess-1', configId: 'model', value: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('does not fall back for non method-not-found errors', async () => {
      const setSessionConfigOption = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ data: { details: 'Model not found' } }),
        setSessionConfigOption,
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await expect((handler as unknown as TestableConfigHandler).setModel('bad')).rejects.toThrow('Model not found');
      expect(setSessionConfigOption).not.toHaveBeenCalled();
    });

    it('throws fallback error when setSessionConfigOption also fails', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ code: -32601, message: 'Method not found' }),
        setSessionConfigOption: vi.fn().mockRejectedValue({ data: { details: 'Unknown model' } }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await expect((handler as unknown as TestableConfigHandler).setModel('bad')).rejects.toThrow('Unknown model');
    });

    it('throws with error.message when no data.details', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue(new Error('connection lost')),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).setModel('x')).rejects.toThrow('connection lost');
    });

    it('throws fallback message for non-Error objects without details', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue({ code: 42 }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).setModel('x')).rejects.toThrow(
        'Failed to set model to "x"',
      );
    });
  });

  describe('setMode', () => {
    it('calls connection.setSessionMode and updates local state', async () => {
      const conn = mockConnection();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          modes: { availableModes: [{ id: 'fast', name: 'Fast' }], currentModeId: 'fast' },
        }),
      );

      await (handler as unknown as TestableConfigHandler).setMode('slow');

      expect(conn.setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'slow' });
      expect(handler.listModes()?.selectedId).toBe('slow');
    });

    it('throws with ACP error message on failure', async () => {
      const conn = mockConnection({
        setSessionMode: vi.fn().mockRejectedValue({ message: 'invalid mode' }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).setMode('bad')).rejects.toThrow('invalid mode');
    });
  });

  describe('handleSessionUpdate', () => {
    it('handles current_mode_update', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse({
          modes: { availableModes: [{ id: 'a', name: 'A' }], currentModeId: 'a' },
        }),
      );

      const handled = handler.handleSessionUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'b',
      } as never);

      expect(handled).toBe(true);
      expect(handler.listModes()?.selectedId).toBe('b');
    });

    it('current_mode_update is no-op when modeConfig is undefined', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      const handled = handler.handleSessionUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'b',
      } as never);

      expect(handled).toBe(true);
      expect(handler.listModes()).toBeUndefined();
    });

    it('handles config_option_update for model', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

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
    });

    it('handles config_option_update for mode', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

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
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [{ type: 'toggle', category: 'model', currentValue: true }],
      } as never);

      expect(handler.listModels()).toBeUndefined();
    });

    it('returns false for unrecognized update types', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      expect(handler.handleSessionUpdate({ sessionUpdate: 'agent_message_chunk' } as never)).toBe(false);
      expect(handler.handleSessionUpdate({ sessionUpdate: 'unknown' } as never)).toBe(false);
    });
  });

  describe('applySessionConfig', () => {
    it('reports corrected config when setModel fails', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue(new Error('model not available')),
      });
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'fallback', name: 'Fallback' }], currentModelId: 'fallback' },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'unavailable-model' });

      expect(conn.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'unavailable-model' });
      expect(updateConfig).toHaveBeenCalledWith({
        acpModel: 'fallback',
        acpMode: null,
      });
    });

    it('falls back to an advertised model when the persisted model is incompatible (Codex scenario)', async () => {
      // A Codex runner inherits a persisted "opus" model and defaults to its own
      // 'default' placeholder. Both must be skipped in favour of a real model.
      const unstable_setSessionModel = vi.fn().mockImplementation(({ modelId }: { modelId: string }) => {
        if (modelId === 'opus' || modelId === 'default') {
          return Promise.reject(new Error(`The '${modelId}' model is not supported`));
        }
        return Promise.resolve(undefined);
      });
      const conn = mockConnection({ unstable_setSessionModel } as never);
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse({
          models: {
            availableModels: [
              { modelId: 'default', name: 'Default' },
              { modelId: 'gpt-5-codex', name: 'GPT-5 Codex' },
            ],
            currentModelId: 'default',
          },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'opus' });

      // Tried the persisted model, skipped 'default', landed on the real model.
      expect(unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'opus' });
      expect(unstable_setSessionModel).not.toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'default' });
      expect(unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'gpt-5-codex' });
      expect(handler.listModels()?.selectedId).toBe('gpt-5-codex');
      expect(updateConfig).toHaveBeenCalledWith({ acpModel: 'gpt-5-codex', acpMode: null });
    });

    it('reports the original selection when no usable fallback model exists', async () => {
      const conn = mockConnection({
        unstable_setSessionModel: vi.fn().mockRejectedValue(new Error('model not available')),
      });
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse({
          // Only the failed id and 'default' are advertised — nothing to fall back to.
          models: {
            availableModels: [
              { modelId: 'opus', name: 'Opus' },
              { modelId: 'default', name: 'Default' },
            ],
            currentModelId: 'default',
          },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'opus' });

      expect(handler.listModels()?.selectedId).toBe('default');
      expect(updateConfig).toHaveBeenCalledWith({ acpModel: 'default', acpMode: null });
    });

    it('does not report when setModel succeeds', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'a' });

      expect(updateConfig).not.toHaveBeenCalled();
    });
  });
});
