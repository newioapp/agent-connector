/**
 * Backend URL resolution for e2e runs.
 *
 * Mirrors the connector's own convention: dev/integ backends are addressed via
 * the `NEWIO_API_URL` / `NEWIO_WS_URL` env vars (the prod URLs are never used by
 * tests). Defaults target the shared dev backend that the Conduit integ and
 * desktop-e2e suites also run against.
 */
export interface BackendUrls {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly stage: 'dev' | 'integ' | 'prod';
}

const DEV_API_URL = 'https://api.nan-dev.newio.app';
const DEV_WS_URL = 'wss://ws.nan-dev.newio.app';

export function resolveBackendUrls(): BackendUrls {
  return {
    apiBaseUrl: process.env.NEWIO_API_URL ?? DEV_API_URL,
    wsUrl: process.env.NEWIO_WS_URL ?? DEV_WS_URL,
    stage: 'dev',
  };
}
