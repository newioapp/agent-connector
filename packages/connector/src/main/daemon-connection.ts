/**
 * Owns the connection to the per-stage daemon (the runtime the desktop is a thin
 * client of). Connects over the Unix socket, verifies the RPC protocol version,
 * forwards daemon push notifications to the renderer, and tracks connection state
 * so the UI can show "daemon not running" / "protocol mismatch" and offer retry.
 */
import { shell } from 'electron';
import { DaemonClient, DaemonConnector, RPC_PROTOCOL_VERSION, getDaemonPaths } from '@newio/cli';
import type { Stage } from '@newio/cli';
import type { MainWindowManager } from './main-window';
import { EVENT_CHANNELS } from '../shared/ipc-events';
import type { DaemonConnectionStatus } from '../shared/ipc-events';
import { Logger } from '../shared/logger';

const log = new Logger('daemon-connection');

export class DaemonConnection {
  private readonly client = new DaemonClient();
  readonly connector = new DaemonConnector(this.client);
  private status: DaemonConnectionStatus = { kind: 'connecting' };
  /** Guards against overlapping connect() attempts (e.g. a double-clicked Retry). */
  private connecting = false;

  constructor(
    private readonly stage: Stage,
    private readonly windows: MainWindowManager,
  ) {}

  getStatus(): DaemonConnectionStatus {
    return this.status;
  }

  /** The connected daemon's backend API base URL, if currently connected. */
  getApiBaseUrl(): string | undefined {
    return this.status.kind === 'connected' ? this.status.apiBaseUrl : undefined;
  }

  /** Connect (or reconnect) and run the protocol handshake. Never throws — failures become status. */
  async connect(): Promise<void> {
    // A connect is already settling; ignore the overlapping call so its late
    // result can't clobber a newer attempt's status.
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      await this.attemptConnect();
    } finally {
      this.connecting = false;
    }
  }

  private async attemptConnect(): Promise<void> {
    // Drop any previous socket before reconnecting.
    this.connector.disconnect();
    this.setStatus({ kind: 'connecting' });

    const { socketPath } = getDaemonPaths(this.stage);
    try {
      await this.connector.connect(socketPath, {
        onStatusChanged: (agentId, status, error, errorCode) =>
          this.windows.send(EVENT_CHANNELS['agent-status-changed'], { agentId, status, error, errorCode }),
        onApprovalUrl: (agentId, approvalUrl) => {
          this.windows.send(EVENT_CHANNELS['agent-approval-url'], { agentId, approvalUrl });
          // The daemon can't open a browser; the desktop does it on the daemon's behalf.
          void shell.openExternal(approvalUrl);
        },
        onPollAttempt: (agentId) => this.windows.send(EVENT_CHANNELS['agent-poll-attempt'], { agentId }),
        onConfigUpdated: (agentId, config) =>
          this.windows.send(EVENT_CHANNELS['agent-config-updated'], { agentId, config }),
        onAgentInfo: (agentId, info) => this.windows.send(EVENT_CHANNELS['agent-acp-info'], { agentId, info }),
        onDisconnect: () => {
          log.warn('Daemon connection dropped');
          this.setStatus({ kind: 'unreachable' });
        },
      });
    } catch (err) {
      log.warn(`Daemon not reachable at ${socketPath}`, err);
      this.setStatus({ kind: 'unreachable' });
      return;
    }

    try {
      const handshake = await this.connector.handshake();
      if (handshake.protocolVersion !== RPC_PROTOCOL_VERSION) {
        log.warn(`Protocol mismatch: daemon v${handshake.protocolVersion}, desktop v${RPC_PROTOCOL_VERSION}`);
        this.connector.disconnect();
        this.setStatus({
          kind: 'protocol-mismatch',
          daemonProtocol: handshake.protocolVersion,
          clientProtocol: RPC_PROTOCOL_VERSION,
        });
        return;
      }
      log.info(`Connected to daemon v${handshake.version} (stage ${handshake.stage}, ${handshake.apiBaseUrl})`);
      this.setStatus({
        kind: 'connected',
        daemonVersion: handshake.version,
        stage: handshake.stage,
        apiBaseUrl: handshake.apiBaseUrl,
      });
    } catch (err) {
      log.warn('Handshake failed', err);
      this.connector.disconnect();
      this.setStatus({ kind: 'unreachable' });
    }
  }

  disconnect(): void {
    this.connector.disconnect();
  }

  private setStatus(status: DaemonConnectionStatus): void {
    this.status = status;
    this.windows.send(EVENT_CHANNELS['daemon-connection-changed'], status);
  }
}
