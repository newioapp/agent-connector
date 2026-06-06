/**
 * Interactive Claude authentication.
 *
 * Spawns the bundled claude-agent-acp login flow (`--cli auth login
 * --claudeai|--console`). These are browser-OAuth flows: the native `claude`
 * binary prints a URL and runs a localhost loopback callback, so we don't need a
 * TTY — we pipe its output to the renderer (via the `claude-auth-output` event)
 * and auto-open the first URL we see in the user's browser.
 *
 * Running the bundled, signed binary here (rather than an externally-installed
 * copy) is what makes the macOS Keychain credential readable at runtime: the
 * same binary writes and later reads the Keychain item.
 */
import { spawn } from 'child_process';
import { shell } from 'electron';
import { buildClaudeAuthCommand } from '@newio/agent-engine';
import type { ClaudeAuthMethod } from '@newio/agent-engine';
import type { ClaudeAuthResult } from '../shared/types';
import { Logger } from '../shared/logger';

const log = new Logger('claude-auth');

const URL_RE = /\bhttps?:\/\/[^\s'"]+/;

/**
 * Run the interactive Claude login. `emit` forwards each output line to the
 * renderer; the returned promise resolves once the process exits.
 */
export function runClaudeAuth(method: ClaudeAuthMethod, emit: (line: string) => void): Promise<ClaudeAuthResult> {
  const { command, args, env } = buildClaudeAuthCommand(method);
  log.info(`Starting Claude auth (${method})`);

  return new Promise<ClaudeAuthResult>((resolve) => {
    let openedUrl = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    const handleChunk = (raw: Buffer, bufRef: 'stdout' | 'stderr'): void => {
      const buf = (bufRef === 'stdout' ? stdoutBuf : stderrBuf) + raw.toString();
      const lines = buf.split('\n');
      // Keep the trailing partial line in the buffer.
      const rest = lines.pop() ?? '';
      if (bufRef === 'stdout') {
        stdoutBuf = rest;
      } else {
        stderrBuf = rest;
      }
      for (const line of lines) {
        emit(line);
        log.debug(`[${method}] ${line}`);
        if (!openedUrl) {
          const match = URL_RE.exec(line);
          if (match) {
            openedUrl = true;
            void shell.openExternal(match[0]);
          }
        }
      }
    };

    child.stdout.on('data', (d: Buffer) => handleChunk(d, 'stdout'));
    child.stderr.on('data', (d: Buffer) => handleChunk(d, 'stderr'));

    child.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Claude auth failed to start: ${message}`);
      emit(`Failed to start authentication: ${message}`);
      resolve({ ok: false });
    });

    child.on('exit', (code) => {
      // Flush any buffered partial lines.
      if (stdoutBuf) {
        emit(stdoutBuf);
      }
      if (stderrBuf) {
        emit(stderrBuf);
      }
      const ok = code === 0;
      log.info(`Claude auth (${method}) exited with code ${code ?? 'null'}`);
      emit(ok ? '✓ Login successful. Credentials saved.' : `Authentication exited with code ${code ?? 'unknown'}.`);
      resolve({ ok, ...(code !== null ? { code } : {}) });
    });
  });
}
