# @newio/e2e

Platform **end-to-end** tests for the Newio vertical:
**human ↔ backend ↔ connector ↔ agent**, exercising the real connector runtime
against a live backend, with a deterministic `@newio/acp-puppet` agent instead of
a real LLM.

This is the connector-internal layer of the broader e2e strategy. It covers the
flows the desktop UI can't easily observe (sessions, resume/rotation, signals,
memory writes) plus the core message round-trip. UI-level golden paths live in
the Conduit desktop e2e suite (Playwright + Electron), wired to the same puppet.

## What it does

`ConnectorHarness` boots the production code path — `AgentRuntimeManager` +
`AgentInstanceImpl`, the same wiring the daemon uses — minus the
launchd/systemd shell:

1. `OwnerBackend` (a thin REST client for the **human** side) creates an owner
   and registers + approves an agent, yielding the agent's own tokens.
2. The harness seeds a `FileAgentConfigManager` (temp dir) with a `custom` agent
   pointing at the puppet binary plus those tokens — so no browser approval is
   needed — and starts the runtime.
3. A `PuppetDriver` scripts the agent's behaviour live over the control socket.

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
- `src/connector-harness.ts` — `ConnectorHarness`, boots the real runtime + puppet.
- `src/config.ts` — backend URL resolution.
- `test/*.e2e.test.ts` — scenarios. `round-trip.e2e.test.ts` covers the message
  round-trip and a memory write via the `add_memory` MCP tool.

## Roadmap

- Session lifecycle: idle teardown + resume (`session/load`), rotation + handoff.
- Permission/action-message flows (puppet `requestPermission` → owner DM).
- Cross-conversation `send_message`/`send_dm` and more memory operations.
- Signals (live session info, cancel, compact).
