/**
 * Backend URL resolution for e2e runs.
 *
 * The dev/integ backend hostnames are private, so they are NOT committed. Set
 * `NEWIO_API_URL` / `NEWIO_WS_URL` in `packages/e2e/.env` (gitignored; copy from
 * `.env.example`) or in the environment. The connector itself uses the same env
 * vars (the prod URLs are never used by tests).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BackendUrls {
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly stage: 'dev' | 'integ' | 'prod';
}

// Load packages/e2e/.env (gitignored) if present, so the private dev URLs stay
// out of the repo. Existing process env always wins (loadEnvFile doesn't clobber).
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export function resolveBackendUrls(): BackendUrls {
  const apiBaseUrl = process.env.NEWIO_API_URL;
  const wsUrl = process.env.NEWIO_WS_URL;
  if (!apiBaseUrl || !wsUrl) {
    throw new Error(
      'Missing backend URLs for e2e. Set NEWIO_API_URL and NEWIO_WS_URL in packages/e2e/.env ' +
        '(copy packages/e2e/.env.example) or in the environment.',
    );
  }
  return { apiBaseUrl, wsUrl, stage: 'dev' };
}
