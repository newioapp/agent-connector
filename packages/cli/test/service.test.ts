import { describe, it, expect } from 'vitest';
import { buildPlist, launchdLabel } from '../src/service/launchd';
import { buildUnit, systemdUnit } from '../src/service/systemd';
import type { InstallOptions } from '../src/service/types';

const baseOpts: InstallOptions = {
  programArguments: ['/usr/local/bin/node', '/usr/local/lib/node_modules/@newio/cli/dist/cli.js', 'daemon', 'run'],
  env: { NEWIO_STAGE: 'dev', NEWIO_API_URL: 'https://api.example.test', HOME: '/Users/nan' },
  logPath: '/Users/nan/.newio-dev/connector/daemon.log',
  enable: true,
};

// A SEA build runs the signed `newio` binary directly, with no script path.
const seaOpts: InstallOptions = {
  ...baseOpts,
  programArguments: ['/Users/nan/.newio/bin/newio', 'daemon', 'run'],
};

describe('launchd', () => {
  it('namespaces the label per stage', () => {
    expect(launchdLabel('prod')).toBe('app.newio.connectord');
    expect(launchdLabel('dev')).toBe('app.newio.connectord.dev');
  });

  it('builds a plist running `daemon run` with baked env', () => {
    const plist = buildPlist('app.newio.connectord.dev', baseOpts);
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<key>NEWIO_STAGE</key>');
    expect(plist).toContain('<string>dev</string>');
    expect(plist).toContain('<string>/Users/nan/.newio-dev/connector/daemon.log</string>');
  });

  it('builds a plist that runs the SEA binary directly (no node/script args)', () => {
    const plist = buildPlist('app.newio.connectord', seaOpts);
    expect(plist).toContain('<string>/Users/nan/.newio/bin/newio</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).not.toContain('<string>/usr/local/bin/node</string>');
  });

  it('sets RunAtLoad/KeepAlive from the enable flag', () => {
    expect(buildPlist('x', { ...baseOpts, enable: true })).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(buildPlist('x', { ...baseOpts, enable: false })).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  it('restarts only on crash (KeepAlive=SuccessfulExit:false) when enabled', () => {
    // Enabled: relaunch only after an unsuccessful exit (the launchd analog of
    // systemd Restart=on-failure), so a clean `daemon stop` stays stopped.
    expect(buildPlist('x', { ...baseOpts, enable: true })).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
    // Not enabled: no persistence, no auto-restart at all.
    expect(buildPlist('x', { ...baseOpts, enable: false })).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it('bounds graceful shutdown with a 30s ExitTimeOut before SIGKILL', () => {
    expect(buildPlist('x', baseOpts)).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
  });

  it('XML-escapes env values', () => {
    const plist = buildPlist('x', { ...baseOpts, env: { TOKEN: 'a&b<c>"d' } });
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;&quot;d</string>');
  });
});

describe('systemd', () => {
  it('namespaces the unit per stage', () => {
    expect(systemdUnit('prod')).toBe('newio-connectord.service');
    expect(systemdUnit('dev')).toBe('newio-connectord-dev.service');
  });

  it('builds a unit running `daemon run` with baked env and crash restart', () => {
    const unit = buildUnit(baseOpts);
    // Each argv element is double-quoted (systemd command-line, not a raw array).
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/@newio/cli/dist/cli.js" "daemon" "run"',
    );
    expect(unit).toContain('Environment="NEWIO_STAGE=dev"');
    expect(unit).toContain('Environment="HOME=/Users/nan"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('TimeoutStopSec=30');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('builds a unit that runs the SEA binary directly', () => {
    const unit = buildUnit(seaOpts);
    expect(unit).toContain('ExecStart="/Users/nan/.newio/bin/newio" "daemon" "run"');
  });

  it('keeps a binary path with spaces as a single ExecStart argument', () => {
    // Reachable via a NEWIO_INSTALL_DIR override; an unquoted join would split
    // "/home/me/Newio Bin/newio" into two arguments and break the unit.
    const unit = buildUnit({
      ...baseOpts,
      programArguments: ['/home/me/Newio Bin/newio', 'daemon', 'run'],
    });
    expect(unit).toContain('ExecStart="/home/me/Newio Bin/newio" "daemon" "run"');
  });

  it('escapes %, quotes, and backslashes in ExecStart args', () => {
    const unit = buildUnit({ ...baseOpts, programArguments: ['a%b"c\\d', 'run'] });
    // % -> %% (specifier), " -> \", \ -> \\, each arg double-quoted.
    expect(unit).toContain('ExecStart="a%%b\\"c\\\\d" "run"');
  });

  it('escapes quotes/backslashes/percent in env values', () => {
    const unit = buildUnit({ ...baseOpts, env: { TOKEN: 'a"b\\c%d' } });
    expect(unit).toContain('Environment="TOKEN=a\\"b\\\\c%%d"');
  });
});
