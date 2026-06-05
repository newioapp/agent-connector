/**
 * JSON-RPC error types and param decoding.
 *
 * The params array arrives as untyped `unknown[]` off the wire. Rather than
 * `as`-casting (which would silently accept malformed input), every handler
 * decodes its arguments through these helpers, which validate and narrow — and
 * throw a typed RpcError(INVALID_PARAMS) on mismatch.
 */

/**
 * RPC protocol version. Bump on breaking changes to the method/params contract
 * so clients (CLI, desktop) can detect skew via `daemon.handshake`.
 */
export const RPC_PROTOCOL_VERSION = 1;

/** Standard JSON-RPC 2.0 error codes (plus an app-level range). */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Application error (server-defined range is -32000..-32099). */
  AppError: -32000,
} as const;

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

/** A JSON-RPC error carrying a numeric code, mapped onto the wire response. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }

  static methodNotFound(method: string): RpcError {
    return new RpcError(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
  }

  static invalidParams(message: string): RpcError {
    return new RpcError(JsonRpcErrorCode.InvalidParams, message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a positional argument with validation + narrowing. */
export class Params {
  private readonly params: unknown[];

  constructor(params: unknown[]) {
    this.params = params;
  }

  /** Required string at position `i`. */
  string(i: number, name: string): string {
    const value = this.params[i];
    if (typeof value !== 'string') {
      throw RpcError.invalidParams(`Expected ${name} (param ${i}) to be a string.`);
    }
    return value;
  }

  /** Optional string at position `i` (undefined or null → undefined). */
  optionalString(i: number, name: string): string | undefined {
    const value = this.params[i];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw RpcError.invalidParams(`Expected ${name} (param ${i}) to be a string when present.`);
    }
    return value;
  }

  /** Required `Record<string, string>` at position `i`. */
  stringRecord(i: number, name: string): Record<string, string> {
    const value = this.params[i];
    if (!isRecord(value)) {
      throw RpcError.invalidParams(`Expected ${name} (param ${i}) to be an object.`);
    }
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val !== 'string') {
        throw RpcError.invalidParams(`Expected ${name}.${key} to be a string.`);
      }
      result[key] = val;
    }
    return result;
  }

  /** Required object at position `i`, returned as a record for further decoding. */
  object(i: number, name: string): Record<string, unknown> {
    const value = this.params[i];
    if (!isRecord(value)) {
      throw RpcError.invalidParams(`Expected ${name} (param ${i}) to be an object.`);
    }
    return value;
  }
}
