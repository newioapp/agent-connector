# @newio/e2e

Platform **end-to-end** tests for the Newio vertical:
**human ↔ backend ↔ connector ↔ agent**, exercising the real connector runtime
against a live backend, with a deterministic `@newio/acp-puppet` agent instead of
a real LLM.

This is the connector-internal layer of the broader e2e strategy. It covers the
flows the desktop UI can't easily observe (sessions, resume/rotation, signals,
memory writes) plus the core message round-trip. UI-level golden paths live in
the Conduit desktop e2e suite (Playwright + Electron), wired to the same puppet.

## Two harness layers

Both run the **human** side via `OwnerBackend` (a thin REST client that creates an
owner and registers + approves an agent for its tokens) and script the **agent**
with a `PuppetDriver` over the control socket. They differ in how the **connector**
runs:

- **`ConnectorHarness` — embedded (fast workhorse).** Boots `AgentRuntimeManager` +
  `AgentInstanceImpl` (the same runtime the daemon uses) **in-process**, with a
  `FileAgentConfigManager` seeded in a temp dir. Fast and fully isolated; use for
  the bulk of platform scenarios. Skips the CLI/daemon/RPC plumbing and hand-rolls
  its own `EngineConfig`.
- **`DaemonHarness` — full shipped stack (high fidelity).** Spawns the real
  `newio` daemon (`node dist/cli.js daemon run`) and configures it the way a user
  does — through the real CLI subcommands (`agent add` → `agent env set` →
  `agent start`). Covers the CLI entry + commands, the daemon process,
  `runDaemon`'s own `EngineConfig` (bridge command via `resolveSelfExec`), the RPC
  transport, and on-disk config — the parts the embedded harness skips. Isolated
  via `NEWIO_HOME` pointed at a temp dir. Requires the cli + puppet builds.

The embedded harness seeds config via `FileAgentConfigManager` + injected tokens.
The daemon harness defines the agent purely through the CLI; the only non-CLI
state is a one-line `.credentials.json` write (the CLI has no set-tokens command —
tokens only come from the approval flow), which stands in for the connector's own
approval-poll. Both get the agent's tokens from `OwnerBackend` (the human side,
which legitimately registers + approves the agent).

## Running

These tests hit the deployed **dev** backend and spawn a subprocess, so they are
gated behind `RUN_E2E=1`:

```bash
pnpm --filter @newio/e2e test:e2e
```

Backend URLs come from `NEWIO_API_URL` / `NEWIO_WS_URL` (defaulting to the shared
dev backend, the same one the Conduit integ + desktop-e2e suites use).

Without `RUN_E2E=1`, `pnpm test` collects but skips the suite (no network).

## Layout

- `src/backend.ts` — `OwnerBackend`, the human-side REST client.
- `src/connector-harness.ts` — `ConnectorHarness` (embedded runtime + puppet).
- `src/daemon-harness.ts` — `DaemonHarness` (real daemon subprocess + puppet).
- `src/config.ts` — backend URL resolution.
- `test/round-trip.e2e.test.ts` — embedded: message round-trip + `add_memory` MCP tool.
- `test/daemon-round-trip.e2e.test.ts` — full stack: same round-trip via the real daemon.

## Roadmap

- CLI integ tests (`agent add/start/stop`, `agent env`, RPC) on top of `DaemonHarness`.
- Session lifecycle: idle teardown + resume (`session/load`), rotation + handoff.
- Permission/action-message flows (puppet `requestPermission` → owner DM).
- Cross-conversation `send_message`/`send_dm` and more memory operations.
- Signals (live session info, cancel, compact).
