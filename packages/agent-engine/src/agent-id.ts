/**
 * Agent ID validation.
 *
 * Agent IDs are server-generated UUIDs, but they reach the engine from
 * untrusted callers (e.g. the daemon's `agent.*` JSON-RPC params) and get
 * joined into filesystem paths (`agents/<id>/...`). An unvalidated value like
 * `../..` would escape the data directory — `join(agentsDir, '../..')` resolves
 * outside it — turning a remove into an `rmSync` of an arbitrary directory.
 *
 * So every path-building operation validates the ID first. The allowlist
 * (letters, digits, `_`, `-`) admits UUIDs while rejecting path separators,
 * `.`/`..`, and anything else that could traverse.
 */
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeAgentId(agentId: string): boolean {
  return typeof agentId === 'string' && SAFE_AGENT_ID.test(agentId);
}

/** Throw if `agentId` is not a safe single path segment. */
export function assertSafeAgentId(agentId: string): void {
  if (!isSafeAgentId(agentId)) {
    throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
  }
}
