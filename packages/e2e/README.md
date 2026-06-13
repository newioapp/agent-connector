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
- **`DaemonSandbox` + `startPuppetAgent` — full shipped stack (high fidelity).**
  `DaemonSandbox` spawns the real `newio` daemon (`node dist/cli.js daemon run`)
  in a temp `NEWIO_HOME`; `startPuppetAgent(sandbox, …)` then configures one agent
  the way a user does — through the real CLI subcommands (`agent add` →
  `agent env set` → `agent start`) — and can be called repeatedly to run several
  puppet agents on one daemon. Covers the CLI entry + commands, the daemon process,
  `runDaemon`'s own `EngineConfig` (bridge command via `resolveSelfExec`), the RPC
  transport, and on-disk config — the parts the embedded harness skips. Requires
  the cli + puppet builds.

The embedded harness seeds config via `FileAgentConfigManager` + injected tokens.
The daemon path defines the agent purely through the CLI; the only non-CLI state
is a one-line `.credentials.json` write (the CLI has no set-tokens command —
tokens only come from the approval flow), which stands in for the connector's own
approval-poll. Both get the agent's tokens from `OwnerBackend` (the human side,
which legitimately registers + approves the agent).

## Running

These tests hit the deployed **dev** backend and spawn a subprocess, so they run
only via their dedicated config (the default `pnpm test` excludes the `*.e2e.test.ts`
specs and never imports them):

```bash
pnpm --filter @newio/e2e test:e2e
```

Backend URLs come from `NEWIO_API_URL` / `NEWIO_WS_URL` (the shared dev backend,
the same one the Conduit integ + desktop-e2e suites use). Set them in
`packages/e2e/.env` (copy `.env.example`) or the environment — if they're missing,
the tests fail fast with a message telling you to provide them.

## Layout

- `src/backend.ts` — `OwnerBackend`, the human-side REST client.
- `src/connector-harness.ts` — `ConnectorHarness` (embedded runtime + puppet).
- `src/daemon-sandbox.ts` — `DaemonSandbox` (real daemon subprocess + `runCli`).
- `src/puppet-agent.ts` — `addPuppetAgent` / `startAddedAgent` / `startPuppetAgent` (configure and/or start puppet agents on a sandbox).
- `src/config.ts` — backend URL resolution.
- `test/round-trip.e2e.test.ts` — embedded: message round-trip + `add_memory` MCP tool.
- `test/daemon-round-trip.e2e.test.ts` — full stack: same round-trip via the real daemon.
- `test/cross-conversation.e2e.test.ts` — embedded: `send_dm` / `send_message` (shared mode).
- `test/daemon-cross-conversation.e2e.test.ts` — full stack: same routing via the real daemon.
- `test/cli-lifecycle.e2e.test.ts` — full stack: single-agent stop/restart + `create-account`.
- `test/multi-agent-lifecycle.e2e.test.ts` — full stack: a fleet on one daemon (5 accounts × 3 configs = 15, 4 started), list/info/stop/restart.

## Roadmap

- CLI integ tests (`agent add/start/stop`, `agent env`, RPC) on top of `DaemonSandbox` +
  `startPuppetAgent`.
- Session lifecycle: idle teardown + resume (`session/load`), rotation + handoff.
- Permission/action-message flows (puppet `requestPermission` → owner DM).
- Cross-conversation `send_message`/`send_dm` and more memory operations.
- Signals (live session info, cancel, compact).
