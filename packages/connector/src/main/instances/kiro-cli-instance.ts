/**
 * Kiro CLI agent instance — spawns a kiro-cli ACP process and bridges with Newio.
 *
 * Spawns `kiro-cli acp --agent <name> --trust-all-tools` as a child process,
 * communicates over stdio using the Agent Client Protocol (ACP).
 *
 * Incoming Newio messages are queued per conversation and forwarded to the
 * ACP agent as prompt turns. Agent responses (streamed via session updates)
 * are sent back to Newio.
 */
import { spawn, execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { BaseAgentInstance } from './base-agent-instance';
import { MessageQueue } from './message-queue';
import { KiroCliAcpClient } from './kiro-cli-acp-client';
import type { IncomingMessage } from '../newio-app';
import { Logger } from '../../shared/logger';

const SKIP_TOKEN = '_skip';
const log = new Logger('kiro-cli-instance');

/**
 * Resolve the absolute path to `kiro-cli`. Electron's PATH when launched from
 * the Dock is minimal, so we try multiple strategies.
 */
const resolvedKiroCliPath: string = (() => {
  try {
    execFileSync('kiro-cli', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return 'kiro-cli';
  } catch {
    // not on PATH
  }

  const shell = process.env.SHELL ?? '/bin/zsh';
  try {
    const path = execFileSync(shell, ['-ilc', 'which kiro-cli'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: 'dumb' },
    }).trim();
    if (path) {
      return path;
    }
  } catch {
    // shell resolution failed
  }

  for (const candidate of ['/Users/pineapple/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli']) {
    try {
      execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 3000 });
      return candidate;
    } catch {
      // not here
    }
  }

  return 'kiro-cli';
})();

// ---------------------------------------------------------------------------
// KiroCliInstance
// ---------------------------------------------------------------------------

export class KiroCliInstance extends BaseAgentInstance {
  private readonly messageQueue = new MessageQueue();
  private childProcess?: ChildProcess;
  private connection?: ClientSideConnection;
  private sessionId?: string;
  private acpClient?: KiroCliAcpClient;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected async onConnected(): Promise<void> {
    if (!this.app) {
      throw new Error('NewioApp not initialized');
    }
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }

    await this.spawnAndConnect();

    this.app.onMessage((msg) => {
      if (!msg.isOwnMessage) {
        this.messageQueue.enqueue(msg);
      }
    });
    void this.processLoop();
    await this.sendGreeting();
  }

  protected onStopped(): void {
    this.messageQueue.close();
    this.killProcess();
  }

  // ---------------------------------------------------------------------------
  // ACP connection
  // ---------------------------------------------------------------------------

  private async spawnAndConnect(): Promise<void> {
    if (!this.config.kiroCli) {
      throw new Error('Kiro CLI config missing');
    }
    const { agentName, model, kiroCliPath, cwd } = this.config.kiroCli;
    const executable = kiroCliPath ?? resolvedKiroCliPath;
    const args = ['acp', '--trust-all-tools'];
    if (agentName) {
      args.push('--agent', agentName);
    }
    if (model) {
      args.push('--model', model);
    }

    log.info(`Spawning: ${executable} ${args.join(' ')}`);

    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' },
      ...(cwd ? { cwd } : {}),
    });
    this.childProcess = child;

    child.stderr.on('data', (data: Buffer) => {
      log.debug(`[kiro-cli stderr] ${data.toString().trimEnd()}`);
    });

    child.on('error', (err) => {
      log.error(`kiro-cli process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      log.info(`kiro-cli exited (code=${String(code)}, signal=${String(signal)})`);
    });

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const client = new KiroCliAcpClient();
    this.acpClient = client;

    const conn = new ClientSideConnection((_agent) => client, stream);
    this.connection = conn;

    const initResult = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    log.info(`ACP initialized (protocol v${String(initResult.protocolVersion)})`);

    const sessionResult = await conn.newSession({
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    });
    this.sessionId = sessionResult.sessionId;
    log.info(`ACP session created: ${sessionResult.sessionId}`);
  }

  private killProcess(): void {
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = undefined;
    }
    this.connection = undefined;
    this.sessionId = undefined;
    this.acpClient = undefined;
  }

  // ---------------------------------------------------------------------------
  // Greeting
  // ---------------------------------------------------------------------------

  private async sendGreeting(): Promise<void> {
    if (!this.app?.identity.ownerId) {
      return;
    }

    const ownerName = this.app.getOwnerDisplayName() ?? 'your owner';
    const instruction = this.app.buildNewioInstruction();
    const prompt = `${instruction}\n\nYou just connected to the Newio messaging platform. Send a brief, friendly greeting to ${ownerName} to let them know you are online and ready. Keep it to 1-2 sentences.`;

    let greeting: string | undefined;
    try {
      greeting = await this.promptAgent(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`Kiro CLI connection test failed: ${message}`);
    }

    if (!greeting || greeting.trim().length === 0) {
      throw new Error('Kiro CLI test failed: agent returned an empty response');
    }

    await this.app.dmOwner(greeting.trim());
  }

  // ---------------------------------------------------------------------------
  // Processing loop
  // ---------------------------------------------------------------------------

  private async processLoop(): Promise<void> {
    for await (const [conversationId, messages] of this.messageQueue.batches()) {
      await this.processBatch(conversationId, messages);
    }
  }

  private async processBatch(conversationId: string, messages: readonly IncomingMessage[]): Promise<void> {
    if (!this.app) {
      return;
    }

    const userText = formatPrompt(messages);
    this.app.setStatus('thinking', conversationId);

    let response: string | undefined;
    try {
      response = await this.promptAgent(userText);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Prompt failed for ${conversationId}: ${errMsg}`);
      this.app.setStatus(null, conversationId);
      return;
    }

    this.app.setStatus(null, conversationId);

    if (!response || response.trim().toLowerCase() === SKIP_TOKEN) {
      return;
    }

    try {
      await this.app.sendMessage(conversationId, response.trim());
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(`Failed to send message to ${conversationId}: ${errMsg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // ACP prompt
  // ---------------------------------------------------------------------------

  private async promptAgent(text: string): Promise<string | undefined> {
    if (!this.connection || !this.sessionId || !this.acpClient) {
      return undefined;
    }

    const responsePromise = this.acpClient.startCollecting();

    const promptResult = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });

    this.acpClient.finishCollecting();

    if (promptResult.stopReason !== 'end_turn') {
      log.warn(`Prompt ended with stop reason: ${promptResult.stopReason}`);
    }

    return await responsePromise;
  }
}

// ---------------------------------------------------------------------------
// Prompt formatting (same YAML format as Claude instance)
// ---------------------------------------------------------------------------

function formatPrompt(messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const isGroup = first.conversationType === 'group' || first.conversationType === 'temp_group';
  if (isGroup) {
    return formatGroupBatch(first.conversationId, first.groupName, messages);
  }
  return formatDmBatch(first.conversationId, messages);
}

function formatSender(m: IncomingMessage): string {
  return [
    `    username: ${m.senderUsername ?? 'unknown'}`,
    `    displayName: ${m.senderDisplayName ?? 'Unknown'}`,
    `    accountType: ${m.senderAccountType ?? 'unknown'}`,
    `    inContact: ${String(m.inContact)}`,
  ].join('\n');
}

function formatDmBatch(conversationId: string, messages: readonly IncomingMessage[]): string {
  const first = messages[0];
  const lines = [`conversationId: ${conversationId}`, `type: dm`, `from:`, formatSender(first), `messages:`];
  for (const m of messages) {
    lines.push(`  - message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}

function formatGroupBatch(
  conversationId: string,
  groupName: string | undefined,
  messages: readonly IncomingMessage[],
): string {
  const lines = [
    `conversationId: ${conversationId}`,
    `type: group`,
    `groupName: ${groupName ?? 'Unnamed Group'}`,
    `messages:`,
  ];
  for (const m of messages) {
    lines.push(`  - from:`);
    lines.push(formatSender(m));
    lines.push(`    message: ${m.text}`);
    lines.push(`    timestamp: "${m.timestamp}"`);
  }
  return lines.join('\n');
}
