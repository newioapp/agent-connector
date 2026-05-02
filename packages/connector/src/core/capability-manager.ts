/**
 * CapabilityManager — tracks and broadcasts per-session capabilities,
 * dispatches capability invocations from the owner.
 *
 * Wired into BaseAgentInstance. Uses NewioApp's signal-based capability
 * methods for all communication with the owner's desktop.
 */
import type {
  NewioApp,
  AgentCapability,
  InvokeCapabilityPayload,
  InvokeCapabilityResponsePayload,
  CapabilitiesResponsePayload,
} from '@newio/agent-sdk';
import { Logger } from './logger';

const log = new Logger('capability-manager');

/** Handler for a specific capability invocation. */
export type CapabilityInvocationHandler = (
  targetId: string | undefined,
  params: Readonly<Record<string, unknown>> | undefined,
) => Promise<InvokeCapabilityResponsePayload>;

export class CapabilityManager {
  /** sessionId → capabilities */
  private readonly sessions = new Map<string, AgentCapability[]>();
  /** capabilityId → handler */
  private readonly handlers = new Map<string, CapabilityInvocationHandler>();
  private app: NewioApp | undefined;

  /** Wire to a NewioApp instance. Registers signal handlers. */
  wire(app: NewioApp): void {
    this.app = app;

    app.onCapabilitiesRequest((sessionId) => this.handleCapabilitiesRequest(sessionId));

    app.onCapabilityInvocation((invocation) => this.handleInvocation(invocation));
  }

  /** Register a handler for a specific capability ID. */
  registerHandler(capabilityId: string, handler: CapabilityInvocationHandler): void {
    this.handlers.set(capabilityId, handler);
  }

  /** Set capabilities for a session and broadcast to owner. */
  async setCapabilities(sessionId: string, capabilities: AgentCapability[]): Promise<void> {
    this.sessions.set(sessionId, capabilities);
    if (this.app) {
      await this.app.reportCapabilities(sessionId, capabilities);
    }
  }

  /** Update a single capability's currentValue and/or options, then broadcast. */
  async updateCapability(
    sessionId: string,
    capabilityId: string,
    update: { readonly currentValue?: string | boolean; readonly options?: AgentCapability['options'] },
  ): Promise<void> {
    const caps = this.sessions.get(sessionId);
    if (!caps) {
      return;
    }
    const idx = caps.findIndex((c) => c.id === capabilityId);
    if (idx === -1) {
      return;
    }
    caps[idx] = {
      ...caps[idx],
      ...(update.currentValue !== undefined ? { currentValue: update.currentValue } : {}),
      ...(update.options !== undefined ? { options: update.options } : {}),
    };
    if (this.app) {
      await this.app.reportCapabilities(sessionId, caps);
    }
  }

  /** Remove a session's capabilities (e.g. on session dispose). */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Get capabilities for a session. */
  getCapabilities(sessionId: string): readonly AgentCapability[] {
    return this.sessions.get(sessionId) ?? [];
  }

  private handleCapabilitiesRequest(sessionId?: string): CapabilitiesResponsePayload {
    const agentId = this.app?.identity.userId ?? '';
    if (sessionId) {
      const caps = this.sessions.get(sessionId) ?? [];
      return { agentId, sessions: [{ sessionId, capabilities: caps }] };
    }
    // Return all sessions
    const sessions = Array.from(this.sessions.entries()).map(([sid, caps]) => ({
      sessionId: sid,
      capabilities: caps,
    }));
    return { agentId, sessions };
  }

  private async handleInvocation(invocation: InvokeCapabilityPayload): Promise<InvokeCapabilityResponsePayload> {
    const handler = this.handlers.get(invocation.capabilityId);
    if (!handler) {
      log.warn(`Unknown capability: ${invocation.capabilityId}`);
      return { capabilityId: invocation.capabilityId, success: false, error: 'unknown_capability' };
    }
    return handler(invocation.targetId, invocation.params);
  }
}
