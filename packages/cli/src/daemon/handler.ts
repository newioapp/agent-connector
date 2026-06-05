/**
 * DaemonHandler — application-level JSON-RPC dispatch.
 *
 * Implements RequestHandler; called by DaemonServer for each incoming request.
 * Every method decodes its params through the typed Params/decoder helpers
 * rather than `as`-casting untyped wire data.
 */
import type { AgentConfigManager, AgentRuntimeManager } from '@newio/agent-engine';
import type { RequestHandler } from './server.js';
import { listAvailableShells, getShellEnv } from './shell-env.js';
import { Params, RpcError, RPC_PROTOCOL_VERSION } from './rpc.js';
import { decodeAddAgentInput, decodeUpdateAgentInput } from './decode-agent.js';

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

  async handle(method: string, rawParams: unknown[]): Promise<unknown> {
    const { agentConfigManager: cfg, agentRuntimeManager: rt } = this.deps;
    const params = new Params(rawParams);

    switch (method) {
      case 'agent.list': {
        return cfg.list().map((config) => {
          const { status, error } = rt.getStatus(config.id);
          return { id: config.id, config, runtimeStatus: status, error };
        });
      }
      case 'agent.add': {
        const input = decodeAddAgentInput(params.object(0, 'input'));
        const shells = listAvailableShells();
        const selectedShell = shells[0];
        const envVars = selectedShell ? await getShellEnv(selectedShell) : undefined;
        return cfg.add({ ...input, ...(envVars ? { envVars, envVarsShell: selectedShell } : {}) });
      }
      case 'agent.update': {
        const agentId = params.string(0, 'agentId');
        const updates = decodeUpdateAgentInput(params.object(1, 'updates'));
        return cfg.update(agentId, updates);
      }
      case 'agent.remove': {
        const agentId = params.string(0, 'agentId');
        await rt.stop(agentId);
        cfg.remove(agentId);
        return null;
      }
      case 'agent.start': {
        rt.start(params.string(0, 'agentId'));
        return null;
      }
      case 'agent.stop': {
        await rt.stop(params.string(0, 'agentId'));
        return null;
      }
      case 'agent.getInfo': {
        return rt.getAgentInfo(params.string(0, 'agentId')) ?? null;
      }
      case 'agent.updateEnvVars': {
        const agentId = params.string(0, 'agentId');
        const envVars = params.stringRecord(1, 'envVars');
        const shell = params.optionalString(2, 'shell');
        return cfg.update(agentId, { envVars, ...(shell ? { envVarsShell: shell } : {}) });
      }
      case 'env.listShells':
        return listAvailableShells();
      case 'env.getShellEnv': {
        return getShellEnv(params.string(0, 'shell'));
      }
      case 'daemon.handshake':
        return { protocolVersion: RPC_PROTOCOL_VERSION, version: this.deps.version };
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
        throw RpcError.methodNotFound(method);
    }
  }
}
