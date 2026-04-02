import { ApiError } from './errors.js';
import { getLogger } from './logger.js';

const log = getLogger('http');

/** Token provider callback — returns the current access token. */
export type TokenProvider = () => string | Promise<string>;

/**
 * Lightweight HTTP client used internally by the SDK.
 * Wraps `fetch` with JSON handling, auth headers, and error mapping.
 */
export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider?: TokenProvider,
  ) {}

  async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    log.debug(`${method} ${path}`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) },
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      log.warn(`${method} ${path} failed: ${res.status}`);
      throw ApiError.fromResponse(res.status, body);
    }
    log.debug(`${method} ${path} → ${res.status}`);
    return body as T;
  }

  async requestNoContent(path: string, opts: RequestInit = {}): Promise<void> {
    const method = opts.method ?? 'GET';
    log.debug(`${method} ${path}`);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      log.warn(`${method} ${path} failed: ${res.status}`);
      throw ApiError.fromResponse(res.status, body);
    }
    log.debug(`${method} ${path} → ${res.status}`);
  }

  /** Build a query string from an object, omitting undefined values. */
  qs(params: Record<string, string | number | undefined>): string {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (entries.length === 0) {
      return '';
    }
    return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  }
}
