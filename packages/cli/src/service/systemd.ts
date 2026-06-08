/**
 * Linux systemd (--user) service manager.
 *
 * Installs a user unit at ~/.config/systemd/user that runs
 * `<node> <cli> daemon run`. stdout/stderr are captured by journald; logs are
 * read via `journalctl --user`. Restart=on-failure gives crash recovery;
 * `enable` adds boot/login persistence (WantedBy=default.target).
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '@newio/agent-sdk';
import type { Stage } from '../paths.js';
import type { InstallOptions, LogsOptions, ServiceManager, ServiceStatus } from './types.js';

const log = getLogger('systemd');

/** Unit name, namespaced per stage so stages can coexist. */
export function systemdUnit(stage: Stage): string {
  return stage === 'prod' ? 'newio-connectord.service' : `newio-connectord-${stage}.service`;
}

function unitPath(stage: Stage): string {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnit(stage));
}

/** Quote a value for an `Environment=` line (systemd uses double quotes). */
function envLine(key: string, value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Environment="${key}=${escaped}"`;
}

/** Pure unit-file generator (exported for testing). */
export function buildUnit(opts: InstallOptions): string {
  const exec = `${opts.nodePath} ${opts.cliEntryPath} daemon run`;
  const envLines = Object.entries(opts.env)
    .map(([k, v]) => envLine(k, v))
    .join('\n');

  return `[Unit]
Description=Newio Agent Connector daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}
Restart=on-failure
RestartSec=5
# Signal only the daemon on stop and let it tear down agents through its own
# ordered shutdown (mark-stopping → cleanup → kill ACP child). This keeps the
# daemon the single lifecycle authority and avoids systemd delivering SIGTERM to
# ACP children out of band (which races the daemon's teardown). The cgroup is
# still the backstop: after TimeoutStopSec, systemd SIGKILLs every remaining
# process in the cgroup, so wedged children/grandchildren are never orphaned.
KillMode=mixed
# Graceful shutdown is bounded (~5s: agents stop concurrently, each waits ≤5s for
# its ACP child before SIGKILL). 30s leaves headroom over that while capping a
# wedged daemon well under systemd's 90s default before it escalates to SIGKILL.
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

export class SystemdServiceManager implements ServiceManager {
  readonly stage: Stage;
  private readonly unit: string;
  private readonly unitFile: string;

  constructor(stage: Stage) {
    this.stage = stage;
    this.unit = systemdUnit(stage);
    this.unitFile = unitPath(stage);
  }

  private systemctl(args: string[]): string {
    log.debug(`systemctl --user ${args.join(' ')}`);
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  }

  private trySystemctl(args: string[]): void {
    try {
      this.systemctl(args);
    } catch {
      /* best-effort */
    }
  }

  isInstalled(): boolean {
    return existsSync(this.unitFile);
  }

  install(opts: InstallOptions): void {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.unitFile, buildUnit(opts), { encoding: 'utf8', mode: 0o644 });
    log.info(`Wrote ${this.unitFile}`);
    this.systemctl(['daemon-reload']);
    if (opts.enable) {
      this.systemctl(['enable', '--now', this.unit]);
    } else {
      this.systemctl(['start', this.unit]);
    }
    log.info(`Started ${this.unit}`);
  }

  uninstall(): void {
    this.trySystemctl(['disable', '--now', this.unit]);
    if (existsSync(this.unitFile)) {
      unlinkSync(this.unitFile);
      log.info(`Removed ${this.unitFile}`);
    }
    this.trySystemctl(['daemon-reload']);
  }

  start(): void {
    this.systemctl(['start', this.unit]);
  }

  stop(): void {
    this.systemctl(['stop', this.unit]);
  }

  restart(): void {
    this.systemctl(['restart', this.unit]);
  }

  status(): ServiceStatus {
    if (!this.isInstalled()) {
      return { state: 'not-installed' };
    }
    const enabled = this.isEnabled();
    if (this.isActive()) {
      return { state: 'running', pid: this.mainPid(), enabled };
    }
    return { state: 'stopped', enabled };
  }

  private isActive(): boolean {
    try {
      // is-active exits non-zero when inactive, so capture and compare.
      return this.systemctl(['is-active', this.unit]).trim() === 'active';
    } catch {
      return false;
    }
  }

  private isEnabled(): boolean {
    try {
      return this.systemctl(['is-enabled', this.unit]).trim() === 'enabled';
    } catch {
      return false;
    }
  }

  private mainPid(): number | undefined {
    try {
      const out = this.systemctl(['show', this.unit, '--property=MainPID', '--value']).trim();
      const pid = Number(out);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  logs(opts: LogsOptions): void {
    const args = ['--user', '-u', this.unit, '-n', String(opts.lines), ...(opts.follow ? ['-f'] : [])];
    execFileSync('journalctl', args, { stdio: 'inherit' });
  }
}
