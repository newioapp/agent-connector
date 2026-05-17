import { Command } from 'commander';
import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getSocketPath, connectOrExit } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function getDaemonBinPath(): string {
  // When installed, the daemon binary is next to this file in dist/
  const local = join(__dirname, 'daemon.js');
  if (existsSync(local)) return local;
  // Fallback: resolve from package
  return require.resolve('@newio/cli/daemon');
}

function isServiceRegistered(): boolean {
  const platform = process.platform;
  if (platform === 'linux') {
    return (
      existsSync('/etc/systemd/system/newio-connectord.service') ||
      existsSync(`${process.env['HOME']}/.config/systemd/user/newio-connectord.service`)
    );
  }
  if (platform === 'darwin') {
    return existsSync(`${process.env['HOME']}/Library/LaunchAgents/app.newio.connectord.plist`);
  }
  return false;
}

async function startViaServiceManager(): Promise<boolean> {
  const platform = process.platform;
  return new Promise((resolve) => {
    if (platform === 'linux') {
      execFile('systemctl', ['--user', 'start', 'newio-connectord'], (err) => resolve(!err));
    } else if (platform === 'darwin') {
      execFile('launchctl', ['load', `${process.env['HOME']}/Library/LaunchAgents/app.newio.connectord.plist`], (err) =>
        resolve(!err),
      );
    } else {
      resolve(false);
    }
  });
}

export function daemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the newio-connectord daemon');

  cmd
    .command('start')
    .description('Start the daemon')
    .action(async () => {
      const socketPath = getSocketPath();
      if (existsSync(socketPath)) {
        console.log('Daemon is already running.');
        return;
      }

      // Try OS service manager first
      if (isServiceRegistered()) {
        const ok = await startViaServiceManager();
        if (ok) {
          console.log('Daemon started via service manager.');
          return;
        }
      }

      // Fall back to spawning directly
      const bin = getDaemonBinPath();
      const child = spawn(process.execPath, [bin], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      console.log(`Daemon started (pid ${child.pid ?? 'unknown'}).`);
    });

  cmd
    .command('stop')
    .description('Stop the daemon')
    .action(async () => {
      const connector = await connectOrExit();
      await connector.stop();
      connector.disconnect();
      console.log('Daemon stopped.');
    });

  cmd
    .command('status')
    .description('Show daemon status and version')
    .action(async () => {
      const socketPath = getSocketPath();
      if (!existsSync(socketPath)) {
        console.log('Daemon is not running.');
        return;
      }
      const connector = await connectOrExit();
      const ver = await connector.version();
      connector.disconnect();
      console.log(`Daemon is running. Version: ${ver}`);
    });

  cmd
    .command('install-service')
    .description('Print instructions for registering the daemon as a system service')
    .action(() => {
      const bin = getDaemonBinPath();
      const node = process.execPath;
      const platform = process.platform;

      if (platform === 'linux') {
        console.log(`# Create ~/.config/systemd/user/newio-connectord.service:
[Unit]
Description=Newio Agent Connector Daemon

[Service]
ExecStart=${node} ${bin}
Restart=on-failure

[Install]
WantedBy=default.target

# Then run:
systemctl --user daemon-reload
systemctl --user enable --now newio-connectord`);
      } else if (platform === 'darwin') {
        const plist = `${process.env['HOME']}/Library/LaunchAgents/app.newio.connectord.plist`;
        console.log(`# Create ${plist}:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.newio.connectord</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${bin}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>

# Then run:
launchctl load ${plist}`);
      } else {
        console.log('Service installation is not yet supported on this platform.');
        console.log(`Run the daemon manually: ${node} ${bin}`);
      }
    });

  cmd
    .command('reload')
    .description('Reload agent config (stops all agents and restarts previously-running ones)')
    .action(async () => {
      const connector = await connectOrExit();
      await connector.reload();
      connector.disconnect();
      console.log('Reloaded.');
    });

  return cmd;
}
