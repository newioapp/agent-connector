/**
 * macOS launchd service manager.
 *
 * Installs a LaunchAgent plist at ~/Library/LaunchAgents that runs
 * `<node> <cli> daemon run`. The plist living in LaunchAgents is what gives
 * login persistence; RunAtLoad controls start-on-login and KeepAlive
 * (`SuccessfulExit=false`) restarts only on crash — the launchd analog of
 * systemd's `Restart=on-failure`. ExitTimeOut bounds graceful shutdown before
 * launchd escalates to SIGKILL.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '@newio/agent-sdk';
import { getDaemonPaths, type Stage } from '../paths.js';
import type { InstallOptions, LogsOptions, ServiceManager, ServiceStatus } from './types.js';

const log = getLogger('launchd');

/** Reverse-DNS label, namespaced per stage so stages can coexist. */
export function launchdLabel(stage: Stage): string {
  return stage === 'prod' ? 'app.newio.connectord' : `app.newio.connectord.${stage}`;
}

function plistPath(stage: Stage): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(stage)}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Pure plist generator (exported for testing). */
export function buildPlist(label: string, opts: InstallOptions): string {
  const args = [opts.nodePath, opts.cliEntryPath, 'daemon', 'run'];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envXml = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const bool = (b: boolean): string => (b ? '<true/>' : '<false/>');

  // KeepAlive mirrors systemd's `Restart=on-failure`: relaunch only after an
  // UNsuccessful exit (a crash). A graceful shutdown calls process.exit(0) —
  // a successful exit — so `newio daemon stop` (SIGTERM) actually stays stopped
  // instead of being immediately relaunched by launchd. When the service isn't
  // enabled there's no persistence, so no auto-restart at all.
  const keepAlive = opts.enable
    ? `<dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>`
    : '<false/>';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  ${bool(opts.enable)}
  <key>KeepAlive</key>
  ${keepAlive}
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

export class LaunchdServiceManager implements ServiceManager {
  readonly stage: Stage;
  private readonly label: string;
  private readonly plist: string;

  constructor(stage: Stage) {
    this.stage = stage;
    this.label = launchdLabel(stage);
    this.plist = plistPath(stage);
  }

  private get domainTarget(): string {
    return `gui/${process.getuid?.() ?? 0}`;
  }

  private get serviceTarget(): string {
    return `${this.domainTarget}/${this.label}`;
  }

  private launchctl(args: string[]): string {
    log.debug(`launchctl ${args.join(' ')}`);
    return execFileSync('launchctl', args, { encoding: 'utf8' });
  }

  isInstalled(): boolean {
    return existsSync(this.plist);
  }

  install(opts: InstallOptions): void {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.plist, buildPlist(this.label, opts), { encoding: 'utf8', mode: 0o644 });
    log.info(`Wrote ${this.plist}`);
    // Re-bootstrap to pick up changes if already loaded.
    this.tryBootout();
    this.launchctl(['bootstrap', this.domainTarget, this.plist]);
    log.info(`Bootstrapped ${this.label}`);
  }

  private tryBootout(): void {
    try {
      this.launchctl(['bootout', this.serviceTarget]);
    } catch {
      /* not loaded — fine */
    }
  }

  uninstall(): void {
    this.tryBootout();
    if (existsSync(this.plist)) {
      unlinkSync(this.plist);
      log.info(`Removed ${this.plist}`);
    }
  }

  start(): void {
    // kickstart starts (or restarts) the already-bootstrapped service.
    this.launchctl(['kickstart', this.serviceTarget]);
  }

  stop(): void {
    // SIGTERM the daemon and let it shut down gracefully (exit 0). KeepAlive is
    // `SuccessfulExit=false`, so launchd won't relaunch a clean exit — the stop
    // sticks without unloading the plist. A force SIGKILL would be a kill-by-
    // signal (an UNsuccessful exit) and get relaunched, so a wedged daemon's
    // escape hatch is `uninstall` (bootout), which is launchd-managed and SIGKILLs
    // after ExitTimeOut.
    try {
      this.launchctl(['kill', 'SIGTERM', this.serviceTarget]);
    } catch {
      /* not running */
    }
  }

  restart(): void {
    this.launchctl(['kickstart', '-k', this.serviceTarget]);
  }

  status(): ServiceStatus {
    if (!this.isInstalled()) {
      return { state: 'not-installed' };
    }
    try {
      const out = this.launchctl(['list', this.label]);
      const match = /"PID"\s*=\s*(\d+)/.exec(out);
      if (match) {
        return { state: 'running', pid: Number(match[1]), enabled: true };
      }
      return { state: 'stopped', enabled: true };
    } catch {
      // Plist on disk but not loaded into launchd.
      return { state: 'stopped', enabled: false };
    }
  }

  logs(opts: LogsOptions): void {
    const { logPath } = getDaemonPaths(this.stage);
    const args = ['-n', String(opts.lines), ...(opts.follow ? ['-f'] : []), logPath];
    execFileSync('tail', args, { stdio: 'inherit' });
  }
}
