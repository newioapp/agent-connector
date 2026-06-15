/**
 * macOS launchd service manager.
 *
 * Installs a LaunchAgent plist at ~/Library/LaunchAgents that runs the daemon
 * (`… daemon run`, from the caller's SEA-aware `programArguments`). For a SEA
 * build that is the signed `newio` binary running itself, so launchd (and macOS
 * privacy prompts) attribute the daemon to our signature rather than to the
 * generic `node`. The plist living in LaunchAgents is what gives login
 * persistence; RunAtLoad controls start-on-login and KeepAlive
 * (`SuccessfulExit=false`) restarts only on crash — the launchd analog of
 * systemd's `Restart=on-failure`. ExitTimeOut bounds graceful shutdown before
 * launchd escalates to SIGKILL.
 *
 * Logging: rather than capturing stdout to an unbounded file via
 * StandardOutPath, the plist bakes `NEWIO_LOG_FILE` and the daemon writes its
 * own size-rotated log there (see daemon/file-log.ts) — the rough equivalent of
 * journald's built-in rotation on the systemd side.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getLogger } from '@newio/agent-sdk';
import { getDaemonPaths, type Stage } from '../paths.js';
import type { InstallOptions, LogsOptions, ServiceManager, ServiceStatus } from './types.js';

const log = getLogger('launchd');

/** Synchronously block the calling thread for `ms` (install runs synchronously). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
  const argXml = opts.programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  // Bake NEWIO_LOG_FILE so the daemon writes (and rotates) its own log file
  // rather than launchd capturing stdout into an unbounded file via
  // StandardOutPath. See packages/cli/src/daemon/file-log.ts.
  const env = { ...opts.env, NEWIO_LOG_FILE: opts.logPath };
  const envXml = Object.entries(env)
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
    // Capture stderr instead of inheriting it, so expected failures — e.g. a
    // `bootout` of an unloaded label on first install — don't leak
    // "Boot-out failed: 3: No such process" to the user's console. The text is
    // still attached to the thrown error for callers that surface it.
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
    // `daemon start` means start now. Even with RunAtLoad=true, `bootstrap`
    // returns before launchd has actually spun the job up, so the status() read
    // that follows would race and report `stopped`. kickstart starts the job
    // synchronously (and is a no-op if RunAtLoad already launched it), so always
    // call it — matching the systemd path, which always `start`s on install.
    this.start();
  }

  private tryBootout(): void {
    try {
      this.launchctl(['bootout', this.serviceTarget]);
    } catch {
      /* not loaded — nothing to boot out, and nothing to wait for */
      return;
    }
    // `bootout` is asynchronous: launchctl returns as soon as it has signalled
    // the job, before launchd finishes tearing it down. Our daemon shuts down
    // gracefully on SIGTERM (stops every agent, closes the socket), so the label
    // lingers in the domain for a moment. Re-`bootstrap`ing it during that
    // window fails with "5: Input/output error", so wait until it's actually
    // gone first.
    this.waitUntilUnloaded();
  }

  /** True while the label is still registered in the launchd domain. */
  private isLoaded(): boolean {
    try {
      this.launchctl(['list', this.label]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Block until a just-booted-out label leaves the domain. Bounded by the
   * plist's ExitTimeOut (30s) plus headroom; if it somehow never unloads we fall
   * through and let the following `bootstrap` surface the real error rather than
   * hang forever.
   */
  private waitUntilUnloaded(): void {
    const deadlineMs = 35_000;
    const stepMs = 200;
    const start = Date.now();
    while (this.isLoaded()) {
      if (Date.now() - start > deadlineMs) {
        log.warn(`Service ${this.label} still loaded after ${deadlineMs}ms; proceeding anyway`);
        return;
      }
      sleepSync(stepMs);
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
    // `enabled` means start-on-login/boot, which for launchd is RunAtLoad — read
    // it from the plist we wrote rather than inferring it from "is loaded" (a
    // `--no-enable` service is loaded and can be running, yet RunAtLoad=false).
    const enabled = this.runAtLoad();
    try {
      const out = this.launchctl(['list', this.label]);
      const match = /"PID"\s*=\s*(\d+)/.exec(out);
      if (match) {
        return { state: 'running', pid: Number(match[1]), enabled };
      }
      return { state: 'stopped', enabled };
    } catch {
      // Plist on disk but not currently loaded into launchd. It's still
      // start-on-login: a LaunchAgent in ~/Library/LaunchAgents auto-loads at
      // the next login, so `enabled` follows RunAtLoad, not the live load state.
      return { state: 'stopped', enabled };
    }
  }

  /** Whether the installed plist has RunAtLoad set (start-on-login/boot). */
  private runAtLoad(): boolean {
    try {
      return /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(readFileSync(this.plist, 'utf8'));
    } catch {
      return false;
    }
  }

  logs(opts: LogsOptions): void {
    const { logPath } = getDaemonPaths(this.stage);
    // `-F` (not `-f`) follows by name and reopens on rotation. The daemon writes
    // a size-rotated log (see daemon/file-log.ts), so when the active file is
    // renamed away a plain `-f` would keep reading the stale inode and miss all
    // subsequent lines; `-F` reattaches to the freshly-created daemon.log.
    const args = ['-n', String(opts.lines), ...(opts.follow ? ['-F'] : []), logPath];
    execFileSync('tail', args, { stdio: 'inherit' });
  }
}
