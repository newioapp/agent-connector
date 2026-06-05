import { describe, it, expect } from 'vitest';
import { buildPlist, launchdLabel } from '../src/service/launchd';
import { buildUnit, systemdUnit } from '../src/service/systemd';
import type { InstallOptions } from '../src/service/types';

const baseOpts: InstallOptions = {
  nodePath: '/usr/local/bin/node',
  cliEntryPath: '/usr/local/lib/node_modules/@newio/cli/dist/cli.js',
  env: { NEWIO_STAGE: 'dev', NEWIO_API_URL: 'https://api.nan-dev.newio.app', HOME: '/Users/nan' },
  logPath: '/Users/nan/.newio-dev/connector/daemon.log',
  enable: true,
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

  it('sets RunAtLoad/KeepAlive from the enable flag', () => {
    expect(buildPlist('x', { ...baseOpts, enable: true })).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(buildPlist('x', { ...baseOpts, enable: false })).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
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
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/@newio/cli/dist/cli.js daemon run',
    );
    expect(unit).toContain('Environment="NEWIO_STAGE=dev"');
    expect(unit).toContain('Environment="HOME=/Users/nan"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('escapes quotes/backslashes in env values', () => {
    const unit = buildUnit({ ...baseOpts, env: { TOKEN: 'a"b\\c' } });
    expect(unit).toContain('Environment="TOKEN=a\\"b\\\\c"');
  });
});
