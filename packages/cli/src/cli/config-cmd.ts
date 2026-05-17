import { Command } from 'commander';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { getDataDir, connectOrExit } from './utils.js';

export function configCommands(program: Command): void {
  program
    .command('reload')
    .description('Reload agent config (stops all agents and restarts previously-running ones)')
    .action(async () => {
      const connector = await connectOrExit();
      await connector.reload();
      connector.disconnect();
      console.log('Reloaded.');
    });

  const config = program.command('config').description('Manage configuration');

  config
    .command('path')
    .description('Print the path to config.json')
    .action(() => {
      console.log(join(getDataDir(), 'config.json'));
    });

  config
    .command('edit')
    .description('Open config.json in $EDITOR')
    .action(() => {
      const configPath = join(getDataDir(), 'config.json');
      if (!existsSync(configPath)) {
        mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
        writeFileSync(configPath, '[]\n', 'utf8');
      }
      const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'vi';
      const child = spawn(editor, [configPath], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
