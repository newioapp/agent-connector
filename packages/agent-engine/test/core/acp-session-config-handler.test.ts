import { describe, it, expect, vi } from 'vitest';
import { AcpSessionConfigHandler } from '../../src/acp-session-config-handler';
import type { SessionConfig } from '../../src/types';
import type { ClientSideConnection, NewSessionResponse } from '@agentclientprotocol/sdk';

/** Expose private methods for testing. */
interface TestableConfigHandler {
  applyConfig(configId: 'model' | 'mode', value: string): Promise<void>;
  reportConfig(): Promise<void>;
}

/**
 * Minimal mock connection. Defaults to a modern agent that implements the generic
 * setSessionConfigOption; legacy-agent tests override it to reject with -32601.
 */
function mockConnection(overrides?: Partial<ClientSideConnection>): ClientSideConnection {
  return {
    setSessionConfigOption: vi.fn().mockResolvedValue(undefined),
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
              id: 'model',
              currentValue: 'gpt-4',
              options: [
                { value: 'gpt-4', name: 'GPT-4' },
                { value: 'gpt-3.5', name: 'GPT-3.5', description: 'Faster' },
              ],
            },
            {
              type: 'select',
              category: 'mode',
              id: 'mode',
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
              id: 'model',
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

  describe('applyConfig — model', () => {
    it('sets model via setSessionConfigOption keyed by the config id', async () => {
      const conn = mockConnection();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse({
          configOptions: [
            {
              type: 'select',
              category: 'model',
              id: 'model',
              currentValue: 'a',
              options: [
                { value: 'a', name: 'A' },
                { value: 'b', name: 'B' },
              ],
            },
          ] as never,
        }),
      );

      await (handler as unknown as TestableConfigHandler).applyConfig('model', 'b');

      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        configId: 'model',
        value: 'b',
      });
      expect(conn.unstable_setSessionModel).not.toHaveBeenCalled();
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('uses the config id even when the agent advertised only the legacy models field', async () => {
      const conn = mockConnection();
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

      await (handler as unknown as TestableConfigHandler).applyConfig('model', 'b');

      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'sess-1', configId: 'model', value: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('falls back to unstable_setSessionModel when setSessionConfigOption is not implemented', async () => {
      const unstable_setSessionModel = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        // -32601 = JSON-RPC "method not found": agent predates the generic config-option API.
        setSessionConfigOption: vi.fn().mockRejectedValue({ code: -32601, message: 'Method not found' }),
        unstable_setSessionModel,
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

      await (handler as unknown as TestableConfigHandler).applyConfig('model', 'b');

      expect(unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-1', modelId: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
    });

    it('does not fall back for non method-not-found errors', async () => {
      const unstable_setSessionModel = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue({ data: { details: 'Model not found' } }),
        unstable_setSessionModel,
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

      await expect((handler as unknown as TestableConfigHandler).applyConfig('model', 'bad')).rejects.toThrow(
        'Model not found',
      );
      expect(unstable_setSessionModel).not.toHaveBeenCalled();
    });

    it('throws the fallback error when unstable_setSessionModel also fails', async () => {
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue({ code: -32601, message: 'Method not found' }),
        unstable_setSessionModel: vi.fn().mockRejectedValue({ data: { details: 'Unknown model' } }),
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

      await expect((handler as unknown as TestableConfigHandler).applyConfig('model', 'bad')).rejects.toThrow(
        'Unknown model',
      );
    });

    it('throws with error.message when setSessionConfigOption rejects an Error', async () => {
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue(new Error('connection lost')),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).applyConfig('model', 'x')).rejects.toThrow(
        'connection lost',
      );
    });

    it('throws the fallback message for non-Error rejections without details', async () => {
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue({ code: 42 }),
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).applyConfig('model', 'x')).rejects.toThrow(
        'Failed to set model to "x"',
      );
    });
  });

  describe('applyConfig — mode', () => {
    it('sets mode via setSessionConfigOption', async () => {
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

      await (handler as unknown as TestableConfigHandler).applyConfig('mode', 'slow');

      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        configId: 'mode',
        value: 'slow',
      });
      expect(conn.setSessionMode).not.toHaveBeenCalled();
      expect(handler.listModes()?.selectedId).toBe('slow');
    });

    it('falls back to setSessionMode when setSessionConfigOption is not implemented', async () => {
      const setSessionMode = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue({ code: -32601, message: 'Method not found' }),
        setSessionMode,
      } as never);
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

      await (handler as unknown as TestableConfigHandler).applyConfig('mode', 'slow');

      expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-1', modeId: 'slow' });
      expect(handler.listModes()?.selectedId).toBe('slow');
    });

    it('surfaces a non method-not-found mode error without falling back', async () => {
      const setSessionMode = vi.fn().mockResolvedValue(undefined);
      const conn = mockConnection({
        setSessionConfigOption: vi.fn().mockRejectedValue({ message: 'invalid mode' }),
        setSessionMode,
      } as never);
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      await expect((handler as unknown as TestableConfigHandler).applyConfig('mode', 'bad')).rejects.toThrow(
        'invalid mode',
      );
      expect(setSessionMode).not.toHaveBeenCalled();
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
            id: 'model',
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
            id: 'mode',
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

    it('ignores a config_option_update whose id is not a supported config id', () => {
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        mockUpdateConfig(),
        makeSessionResponse(),
      );

      // A non-model/mode dimension (e.g. category 'thought_level', id 'effort') is not tracked here.
      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            category: 'thought_level',
            id: 'effort',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
      } as never);

      expect(handler.listModels()).toBeUndefined();
      expect(handler.listModes()).toBeUndefined();
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
    it('applies a persisted model the agent advertises and does not report', async () => {
      const conn = mockConnection();
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
              { modelId: 'a', name: 'A' },
              { modelId: 'b', name: 'B' },
            ],
            currentModelId: 'a',
          },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'b' });

      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: 'sess-1', configId: 'model', value: 'b' });
      expect(handler.listModels()?.selectedId).toBe('b');
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('does NOT apply a persisted model the agent does not advertise; keeps current and reports it (Codex scenario)', async () => {
      // A Codex runner inherits a persisted "opus" model from its Claude days.
      // setSessionConfigOption would accept it silently and only the later prompt would
      // fail, so we must not apply it — leave Codex on its valid current model.
      const conn = mockConnection();
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
              { modelId: 'gpt-5-codex', name: 'GPT-5 Codex' },
              { modelId: 'gpt-5', name: 'GPT-5' },
            ],
            currentModelId: 'gpt-5-codex',
          },
        }),
      );

      await handler.applySessionConfig({ acpModel: 'opus' });

      expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
      expect(handler.listModels()?.selectedId).toBe('gpt-5-codex');
      // Only the dimension the agent advertises a value for is reported; mode is omitted, not nulled.
      expect(updateConfig).toHaveBeenCalledWith({ acpModel: 'gpt-5-codex' });
    });

    it('does NOT apply or report when the agent advertises no model (undefined = unknown, not cleared)', async () => {
      const conn = mockConnection();
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse(),
      );

      await handler.applySessionConfig({ acpModel: 'opus' });

      expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('applies a persisted mode the agent advertises and does not report', async () => {
      const conn = mockConnection();
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse({
          modes: {
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'review', name: 'Review' },
            ],
            currentModeId: 'code',
          },
        }),
      );

      await handler.applySessionConfig({ acpMode: 'review' });

      expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        configId: 'mode',
        value: 'review',
      });
      expect(handler.listModes()?.selectedId).toBe('review');
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('does NOT apply a persisted mode the agent does not advertise; keeps current and reports it', async () => {
      const conn = mockConnection();
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        conn,
        updateConfig,
        makeSessionResponse({
          modes: { availableModes: [{ id: 'code', name: 'Code' }], currentModeId: 'code' },
        }),
      );

      await handler.applySessionConfig({ acpMode: 'plan' });

      expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
      expect(handler.listModes()?.selectedId).toBe('code');
      expect(updateConfig).toHaveBeenCalledWith({ acpMode: 'code' });
    });
  });

  describe('reportConfig', () => {
    it('reports the runner default for a fresh session with nothing persisted', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }], currentModelId: 'sonnet' },
          modes: { availableModes: [{ id: 'default', name: 'Default' }], currentModeId: 'default' },
        }),
      );

      await (handler as unknown as TestableConfigHandler).reportConfig();

      expect(updateConfig).toHaveBeenCalledWith({ acpModel: 'sonnet', acpMode: 'default' });
    });

    it('omits a field the runner does not advertise a current value for (no-change, not cleared)', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        // Runner advertises a current mode but no model.
        makeSessionResponse({
          modes: { availableModes: [{ id: 'plan', name: 'Plan' }], currentModeId: 'plan' },
        }),
      );

      await (handler as unknown as TestableConfigHandler).reportConfig();

      expect(updateConfig).toHaveBeenCalledWith({ acpMode: 'plan' });
    });

    it('does not report when the runner advertises no current model or mode', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse(),
      );

      await (handler as unknown as TestableConfigHandler).reportConfig();

      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('does not report for non-conversation sessions (cron)', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'cron',
        'cron-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }], currentModelId: 'sonnet' },
        }),
      );

      await (handler as unknown as TestableConfigHandler).reportConfig();

      expect(updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('handleSessionUpdate — reports changes to the backend', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('reports the new mode on current_mode_update', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          modes: {
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'plan', name: 'Plan' },
            ],
            currentModeId: 'code',
          },
        }),
      );

      handler.handleSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' } as never);
      await flush();

      expect(updateConfig).toHaveBeenCalledWith({ acpMode: 'plan' });
    });

    it('does not report a current_mode_update when the session advertises no modes', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse(),
      );

      handler.handleSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' } as never);
      await flush();

      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('reports the new model on config_option_update', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse(),
      );

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            category: 'model',
            id: 'model',
            currentValue: 'opus',
            options: [{ value: 'opus', name: 'Opus' }],
          },
        ],
      } as never);
      await flush();

      expect(updateConfig).toHaveBeenCalledWith({ acpModel: 'opus' });
    });

    it('does not report a config_option_update with no select options', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse(),
      );

      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [{ type: 'toggle', category: 'model', currentValue: true }],
      } as never);
      await flush();

      expect(updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('backend reconcile', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('reports the runner default on a fresh conversation (nothing persisted)', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          models: { availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }], currentModelId: 'sonnet' },
          modes: { availableModes: [{ id: 'default', name: 'Default' }], currentModeId: 'default' },
        }),
      );

      await handler.applySessionConfig({});

      expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ acpModel: 'sonnet', acpMode: 'default' });
    });

    it('does not re-report when the runner echoes a value we just applied (no double report)', async () => {
      const conn = mockConnection();
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
              { modelId: 'a', name: 'A' },
              { modelId: 'b', name: 'B' },
            ],
            currentModelId: 'a',
          },
        }),
      );

      // Backend already holds 'b'; the agent applies it → in sync, nothing to report.
      await handler.applySessionConfig({ acpModel: 'b' });
      expect(updateConfig).not.toHaveBeenCalled();

      // The runner echoes the confirmed change as a session update — still in sync, no report.
      handler.handleSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          { type: 'select', category: 'model', id: 'model', currentValue: 'b', options: [{ value: 'b', name: 'B' }] },
        ],
      } as never);
      await flush();

      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('reports an agent-initiated change made after the startup reconcile', async () => {
      const updateConfig = mockUpdateConfig();
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          modes: {
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'plan', name: 'Plan' },
            ],
            currentModeId: 'code',
          },
        }),
      );

      await handler.applySessionConfig({});
      expect(updateConfig).toHaveBeenNthCalledWith(1, { acpMode: 'code' });

      handler.handleSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' } as never);
      await flush();

      expect(updateConfig).toHaveBeenNthCalledWith(2, { acpMode: 'plan' });
    });

    it('serializes reconcile writes so a slow earlier write cannot clobber a later one', async () => {
      const resolvers: Array<() => void> = [];
      const calls: SessionConfig[] = [];
      const updateConfig = vi.fn().mockImplementation((cfg: SessionConfig) => {
        calls.push(cfg);
        return new Promise<void>((resolve) => resolvers.push(resolve));
      });
      const handler = new AcpSessionConfigHandler(
        'conversation',
        'conv-1',
        'sess-1',
        mockConnection(),
        updateConfig,
        makeSessionResponse({
          modes: {
            availableModes: [
              { id: 'code', name: 'Code' },
              { id: 'plan', name: 'Plan' },
              { id: 'ask', name: 'Ask' },
            ],
            currentModeId: 'code',
          },
        }),
      );

      // First change: its backend write starts and stays in flight (unresolved).
      handler.handleSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' } as never);
      await flush();
      expect(calls).toEqual([{ acpMode: 'plan' }]);

      // Second change arrives while the first write is still pending — it must NOT start concurrently.
      handler.handleSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'ask' } as never);
      await flush();
      expect(calls).toHaveLength(1);

      // Once the first write completes, the queued reconcile runs with the latest selection.
      resolvers[0]!();
      await flush();
      expect(calls).toEqual([{ acpMode: 'plan' }, { acpMode: 'ask' }]);

      resolvers[1]!();
      await flush();
    });
  });
});
