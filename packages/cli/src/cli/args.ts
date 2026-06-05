/**
 * Minimal arg parsing helpers for CLI commands.
 *
 * Options are consumed out of the argument list so the remaining positionals
 * (ids, KEY=VALUE pairs) can be read cleanly.
 */
import { resolveStage, type Stage } from '../paths.js';

/** Remove `--name <value>` (first match) and return the value + remaining args. */
export function extractOption(args: string[], names: string[]): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (value === undefined && names.includes(arg)) {
      value = args[i + 1];
      i++; // skip the value
      continue;
    }
    rest.push(arg);
  }
  return { value, rest };
}

/** Remove a boolean flag (e.g. `--follow`) and return whether it was present. */
export function extractFlag(args: string[], names: string[]): { present: boolean; rest: string[] } {
  const rest: string[] = [];
  let present = false;
  for (const arg of args) {
    if (names.includes(arg)) {
      present = true;
    } else {
      rest.push(arg);
    }
  }
  return { present, rest };
}

/** Pull `--stage <s>` (falling back to NEWIO_STAGE) out of the args. */
export function extractStage(args: string[]): { stage: Stage; rest: string[] } {
  const { value, rest } = extractOption(args, ['--stage']);
  return { stage: resolveStage(value ?? process.env['NEWIO_STAGE']), rest };
}
