/**
 * DaemonHandler — application-level JSON-RPC dispatch.
 *
 * Implements RequestHandler; called by DaemonServer for each incoming request.
 */
import type { AgentConfigManager, AgentRuntimeManager } from '@newio/agent-engine';
import type { RequestHandler } from './server.js';
import { listAvailableShells, getShellEnv } from './shell-env.js';

export interface DaemonHandlerDeps {
  readonly agentConfigManager: AgentConfigManager;
  agentRuntimeManager: AgentRuntimeManager;
  readonly version: string;
  readonly onReload: () => Promise<void>;
  readonly onStop: () => Promise<void>;
}

export class DaemonHandler implements RequestHandler {
  readonly deps: DaemonHandlerDeps;

  constructor(deps: DaemonHandlerDeps) {
    this.deps = deps;
  }

  async handle(method: string, params: unknown[]): Promise<unknown> {
    const { agentConfigManager: cfg, agentRuntimeManager: rt } = this.deps;

    switch (method) {
      case 'agent.list': {
        return cfg.list().map((config) => {
          const { status, error } = rt.getStatus(config.id);
          return { id: config.id, config, runtimeStatus: status, error };
        });
      }
      case 'agent.add': {
        const [input] = params as [Parameters<AgentConfigManager['add']>[0]];
        const shells = listAvailableShells();
        const selectedShell = shells[0];
        const envVars = selectedShell ? await getShellEnv(selectedShell) : undefined;
        return cfg.add({ ...input, ...(envVars ? { envVars, envVarsShell: selectedShell } : {}) });
      }
      case 'agent.update': {
        const [agentId, updates] = params as [string, Parameters<AgentConfigManager['update']>[1]];
        return cfg.update(agentId, updates);
      }
      case 'agent.remove': {
        const [agentId] = params as [string];
        await rt.stop(agentId);
        cfg.remove(agentId);
        return null;
      }
      case 'agent.start': {
        const [agentId] = params as [string];
        rt.start(agentId);
        return null;
      }
      case 'agent.stop': {
        const [agentId] = params as [string];
        await rt.stop(agentId);
        return null;
      }
      case 'agent.getInfo': {
        const [agentId] = params as [string];
        return rt.getAgentInfo(agentId) ?? null;
      }
      case 'agent.updateEnvVars': {
        const [agentId, envVars, shell] = params as [string, Record<string, string>, string?];
        return cfg.update(agentId, { envVars, ...(shell ? { envVarsShell: shell } : {}) });
      }
      case 'env.listShells':
        return listAvailableShells();
      case 'env.getShellEnv': {
        const [shell] = params as [string];
        return getShellEnv(shell);
      }
      case 'daemon.version':
        return this.deps.version;
      case 'daemon.ping':
        return 'pong';
      case 'daemon.reload':
        await this.deps.onReload();
        return null;
      case 'daemon.stop':
        setImmediate(() => void this.deps.onStop());
        return null;
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }
}
