/**
 * ACP Client implementation for the Kiro CLI agent.
 *
 * Implements the `acp.Client` interface following the recommended ACP pattern.
 * Handles session updates (collecting agent response text), permission requests
 * (auto-approve), and file system access for the agent.
 */
import * as fs from 'fs/promises';
import type * as acp from '@agentclientprotocol/sdk';
import { Logger } from '../../shared/logger';

const log = new Logger('kiro-cli-acp-client');

export class KiroCliAcpClient implements acp.Client {
  private chunks: string[] = [];
  private resolve: ((text: string) => void) | null = null;

  /** Reset for a new prompt turn. Returns a promise that resolves with the full response. */
  startCollecting(): Promise<string> {
    this.chunks = [];
    return new Promise<string>((r) => {
      this.resolve = r;
    });
  }

  /** Called when the prompt() call returns to flush collected chunks. */
  finishCollecting(): void {
    const text = this.chunks.join('');
    this.chunks = [];
    this.resolve?.(text);
    this.resolve = null;
  }

  // ---------------------------------------------------------------------------
  // acp.Client — session updates
  // ---------------------------------------------------------------------------

  sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') {
          this.chunks.push(u.content.text);
        }
        break;
      case 'tool_call':
        log.debug(`Tool call: ${u.title} (${u.status})`);
        break;
      case 'tool_call_update':
        log.debug(`Tool call update: ${u.toolCallId} ${u.status}`);
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') {
          log.debug(`Thought: ${u.content.text}`);
        }
        break;
      default:
        break;
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // acp.Client — permissions (auto-approve)
  // ---------------------------------------------------------------------------

  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const allowOption = params.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once');
    return Promise.resolve({
      outcome: {
        outcome: 'selected',
        optionId: allowOption?.optionId ?? params.options[0].optionId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // acp.Client — file system
  // ---------------------------------------------------------------------------

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.readFile(params.path, 'utf-8');
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.writeFile(params.path, params.content, 'utf-8');
    return {};
  }

  // ---------------------------------------------------------------------------
  // acp.Client — extensions
  // ---------------------------------------------------------------------------

  extMethod(method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    log.debug(`ext method: ${method}`);
    return Promise.resolve({});
  }

  extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    log.debug(`ext notification: ${method}`);
    return Promise.resolve();
  }
}
