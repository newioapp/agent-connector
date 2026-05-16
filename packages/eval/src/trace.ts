/**
 * Trace collector — records per-event data during scenario execution.
 */
import type { EventTrace, ScriptedEvent, ToolCallRecord } from './types.js';

export class TraceCollector {
  private readonly traces: EventTrace[] = [];

  record(opts: {
    readonly eventIndex: number;
    readonly event: ScriptedEvent;
    readonly promptSent: string;
    readonly agentOutput: string;
    readonly isSkip: boolean;
    readonly toolCalls: readonly ToolCallRecord[];
    readonly latencyMs: number;
  }): void {
    this.traces.push(opts);
  }

  getAll(): readonly EventTrace[] {
    return this.traces;
  }

  getByIndex(eventIndex: number): EventTrace | undefined {
    return this.traces.find((t) => t.eventIndex === eventIndex);
  }

  clear(): void {
    this.traces.length = 0;
  }
}
