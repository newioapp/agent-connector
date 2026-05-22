import type { ToolCallRecord } from '../types.js';

export class ToolInterceptor {
  private readonly calls: ToolCallRecord[] = [];
  private currentEventIndex: number | undefined;

  setEventIndex(index: number | undefined): void {
    this.currentEventIndex = index;
  }

  record(tool: string, args: Record<string, unknown>, result?: unknown): void {
    this.calls.push({ tool, args, timestamp: Date.now(), eventIndex: this.currentEventIndex, result });
  }

  getAll(): readonly ToolCallRecord[] {
    return this.calls;
  }

  getSince(startIndex: number): readonly ToolCallRecord[] {
    return this.calls.slice(startIndex);
  }

  get count(): number {
    return this.calls.length;
  }

  clear(): void {
    this.calls.length = 0;
  }
}
