/**
 * DaemonHandler — application-level JSON-RPC dispatch.
 *
 * Implements RequestHandler; called by DaemonServer for each incoming request.
 * Every method decodes its params through the typed Params/decoder helpers
 * rather than `as`-casting untyped wire data.
 */
import type { AgentConfigManager, AgentRuntimeManager } from '@newio/agent-engine';
import type { RequestHandler } from './server.js';
import type { Stage } from '../paths.js';
import { Params, RpcError, RPC_PROTOCOL_VERSION } from './rpc.js';
import { decodeAddAgentInput, decodeUpdateAgentInput } from './decode-agent.js';

export interface DaemonHandlerDeps {
  readonly agentConfigManager: AgentConfigManager;
  agentRuntimeManager: AgentRuntimeManager;
  readonly version: string;
  /** Stage the daemon was installed for — surfaced in the handshake. */
  readonly stage: Stage;
  /** Backend API base URL the daemon resolved — surfaced in the handshake. */
  readonly apiBaseUrl: string;
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
          const { status, error, errorCode, wsStatus } = rt.getStatus(config.id);
          const approvalUrl = rt.getApprovalUrl(config.id);
          return {
            id: config.id,
            config,
            runtimeStatus: status,
            error,
            ...(errorCode ? { errorCode } : {}),
            ...(approvalUrl ? { approvalUrl } : {}),
            ...(wsStatus ? { wsStatus } : {}),
          };
        });
      }
      case 'agent.add': {
        // Clients capture and supply envVars themselves (CLI/desktop, via captureEnv);
        // the daemon never sources an environment of its own.
        return cfg.add(decodeAddAgentInput(params.object(0, 'input')));
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
        return cfg.update(agentId, { envVars });
      }
      case 'daemon.handshake':
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          version: this.deps.version,
          stage: this.deps.stage,
          apiBaseUrl: this.deps.apiBaseUrl,
        };
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
