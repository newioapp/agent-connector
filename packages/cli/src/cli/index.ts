#!/usr/bin/env node
import { Command } from 'commander';
import { daemonCommand } from './daemon-cmd.js';
import { agentCommands } from './agent-cmd.js';
import { configCommands } from './config-cmd.js';
import { version } from '../../package.json';

const program = new Command().name('newio').description('Newio Agent Connector CLI').version(version);

program.addCommand(daemonCommand());
agentCommands(program);
configCommands(program);

program.parse();
