# Handoff: Refactor desktop to a daemon client (Task #7)

**Status:** core thin-client refactor in progress.
- ✅ Pre-work merged: handshake `stage`/`apiBaseUrl`, `getDaemonPaths`/`resolveStage` exports, late-attach approval snapshot (#197).
- ✅ Core rewiring (this PR): `main/index.ts` + `ipc-handler.ts` now talk to the daemon via `DaemonConnection` (a `DaemonConnector` wrapper); embedded `AgentRuntimeManager`/`FileAgentConfigManager`/cron store removed; handshake protocol check; "daemon not running" / "protocol mismatch" gate in the renderer with retry. Single build-time stage for now.
- ✅ **(Q2)** build-flag-gated dev/integ/prod env **selector** (Settings → stage persisted in electron-store → relaunch → attaches to that stage's daemon socket).
- ✅ **(Q1)** desktop-local **create-account**: the Add Agent form can register a new account (standalone `AuthManager`/`NewioClient` in main, browser approval, no local writes), then prefills the username for the login step.

The daemon-client refactor (Task #7) is now functionally complete.

Tasks #1–#6 are merged to `main` (PRs #183–#186).

> **Next — Task #8: bundle + supervise the daemon inside the Electron app**
> (Option B). The standalone SEA CLI + `curl|bash` distribution merged in PR #205;
> the desktop app should now *contain* the daemon and run it as a per-user
> LaunchAgent so desktop users don't install the CLI separately. This **reverses**
> the "daemon ships as a separate install only" decision under *Decisions to make
> before coding* below. Full plan in **Task #8** near the end of this doc.

## Goal

Make the Electron connector a **thin UI client of the daemon**, the same way the
CLI is. Today the desktop main process *embeds* the agent engine (its own
`AgentRuntimeManager` + `FileAgentConfigManager` + cron store). After this work,
the desktop should talk to the daemon over the Unix socket via `DaemonConnector`
(exported from `@newio/cli`) and own **only** native/UI concerns.

The payoff: a single runtime owns the agents (so the desktop and CLI see the same
live state), and the **single-writer guarantee** on `dataDir` is real — only the
daemon touches `config.json` / `tokens.json` / `cron.json`.

## The clean cut line

`@newio/cli` already exports everything the desktop needs:

```ts
import { DaemonConnector, DaemonClient, RPC_PROTOCOL_VERSION } from '@newio/cli';
import type { DaemonNotificationHandlers, DaemonHandshake } from '@newio/cli';
```

The desktop's current IPC surface maps almost 1:1 onto `DaemonConnector`:

| Desktop IPC (`ipc-handler.ts`)        | Becomes                                   |
|----------------------------------------|-------------------------------------------|
| `listAgents`                           | `connector.listAgents()`                  |
| `addAgent`                             | `connector.addAgent()`                    |
| `updateAgent`                          | `connector.updateAgent()`                 |
| `removeAgent`                          | `connector.removeAgent()`                 |
| `startAgent` / `stopAgent`             | `connector.startAgent/stopAgent()`        |
| `getAgentInfo`                         | `connector.getAgentInfo()`                |
| `listShells` / `getShellEnv`           | `connector.listShells/getShellEnv()`      |
| `updateAgentEnvVars`                   | `connector.updateAgentEnvVars()`          |
| `getVersion`/theme/update/`selectDirectory`/`openExternal` | **STAY in main (native)** |

Note: `addAgent`'s "auto-detect shell + populate envVars" logic already lives in
the **daemon handler** (`handler.ts` `agent.add` case), so the desktop's version
in `ipc-handler.ts:99-108` is now redundant — just call `connector.addAgent()`.

## Push events map 1:1 too

`shared/ipc-events.ts` `MainToRendererEvents` ↔ `DaemonNotificationHandlers`:

| EVENT_CHANNELS key       | DaemonNotificationHandlers callback |
|--------------------------|-------------------------------------|
| `agent-status-changed`   | `onStatusChanged`                   |
| `agent-approval-url`     | `onApprovalUrl`                     |
| `agent-poll-attempt`     | `onPollAttempt`                     |
| `agent-config-updated`   | `onConfigUpdated`                   |
| `agent-acp-info`         | `onAgentInfo`                       |

So in `main/index.ts`, instead of constructing `AgentRuntimeManager` with a
`StatusListener` that calls `mainWindowManager.send(...)`, connect a
`DaemonConnector` whose `DaemonNotificationHandlers` forward to the same
`mainWindowManager.send(EVENT_CHANNELS[...])` channels. **The renderer/Zustand
store does not change** — it still receives the same events on the same channels.

Important: `onApprovalUrl` in the current main process ALSO calls
`shell.openExternal(approvalUrl)` (`main/index.ts:96-98`). Keep that behavior in
the desktop's notification handler (the daemon can't open a browser).

## Concrete steps

1. **Add `@newio/cli` as a connector dependency** (workspace:*). Remove the
   connector's direct use of `FileAgentConfigManager` / `AgentRuntimeManager` /
   `JsonCronStore` / `SqliteCronStore` from `main/index.ts`.
2. **Replace engine construction in `main/index.ts`** with:
   - resolve stage + socket path (reuse the daemon's path convention — consider
     exporting `getDaemonPaths`/`resolveStage` from `@newio/cli`; today they live
     in `packages/cli/src/paths.ts` and are NOT yet exported — add them to
     `packages/cli/src/index.ts`).
   - `DaemonConnector.connect(socketPath, handlers)` where `handlers` forward to
     `mainWindowManager.send(EVENT_CHANNELS[...])` (+ `shell.openExternal` on
     approvalUrl).
   - verify `handshake().protocolVersion === RPC_PROTOCOL_VERSION`; surface a
     clear UI error on mismatch.
3. **Ensure the daemon is running.** Decision point (see below): bundle+spawn vs.
   require separate install. Minimum viable: detect "not reachable" and show a
   helpful state in the UI ("daemon not running"). The CLI's `openConnection`
   error copy is a good model.
4. **Rewrite `ipc-handler.ts`**: agent/env methods delegate to the connector;
   native methods (theme, updates, `selectDirectory`, `openExternal`,
   `getVersion`) stay as-is. `IpcHandlerDeps` drops the two engine managers, gains
   the connector.
5. **Drop the cron store + engine wiring from the desktop entirely** once nothing
   references them (the connector keeps `@newio/agent-engine` only if the
   renderer needs its *types* — those are `import type`, fine to keep).
6. **Lifecycle**: remove the `before-quit` engine `stopAll()` / `cronStore.close()`
   cleanup (`main/index.ts:134-169`) — the daemon owns that now. The desktop just
   disconnects its socket.
7. **Tests**: connector currently has 22 tests (keyboard-shortcuts + one more).
   Add main-process tests for the notification→event forwarding mapping. E2E is
   manual.

## Decisions resolved (2026-06-07)

Settled with the maintainer before implementation. These supersede the open
questions in "Decisions to make before coding" below.

- **Account creation — option (a), desktop-local register.** The desktop runs the
  standalone register flow **in its own main process** (the same
  `AuthManager`/`NewioClient` the CLI's `agent create-account` uses): open the
  approval URL via `shell.openExternal`, poll, read the assigned username via
  `getMe`. It writes **no local files** (no config/tokens), so the daemon stays
  the single writer. The user then runs "Add agent" (by username), which goes
  through the daemon (login path) and is where the runner config is actually
  created. The `apiBaseUrl` for the register call comes from the handshake (below),
  so accounts are created on the same backend the selected daemon uses.

- **Stage selection / multi-env — Conduit-style selector, build-flag gated.** Add a
  dev/integ/prod selector shown only in dev builds via an
  `INCLUDE_ENVIRONMENT_SELECTOR`-style flag (model on Conduit's desktop:
  `electron.vite.config.ts` flag → `define` global → splash `<select>`; persist in
  electron-store; **relaunch on switch**; clear cached state). Connector-specific
  twist: the selected stage maps to a **daemon socket** (`getDaemonPaths(stage)`)
  and the desktop attaches to *that stage's daemon*. The **daemon owns the backend
  URLs** (baked at its per-stage install from env). Do **NOT** add a hardcoded
  dev/integ URL map — this repo intentionally keeps non-prod URLs out of source
  (`paths.ts:55-57`). Instead the daemon's resolved `stage` + `apiBaseUrl` are
  returned in the **handshake**, so the desktop can show the active backend and use
  the apiBaseUrl for its create-account call. No daemon for the selected stage →
  show "daemon not running" guidance (matches the CLI's `openConnection` copy).

- **Protocol compatibility — dedicated `RPC_PROTOCOL_VERSION`, major-match at
  launch.** Do NOT couple the two packages' npm majors (`@newio/connector` and
  `@newio/cli` version independently; a UI-only bump must not force a daemon
  update). Keep the integer `RPC_PROTOCOL_VERSION` as the contract and treat it as
  the major: bump only on breaking RPC method/param changes. The connector verifies
  it on connect via `handshake` — the same strict check the CLI already does in
  `client/connect.ts` — and shows a clear "update the daemon / desktop" modal on
  mismatch. Additive response fields (like the new handshake `stage`/`apiBaseUrl`)
  are backward-compatible and do NOT bump it. A `major.minor` split (newer daemon
  serving older client within a major) is a future refinement, deferred.

### Pre-work landed before the connector refactor

(PR: "daemon-client pre-work" — `@newio/cli` + `@newio/agent-engine` only, no
connector changes, no behavior change to existing CLI flows.)

1. Export `getDaemonPaths`, `resolveStage`, and the `Stage`/`DaemonPaths` types from
   `@newio/cli` (`packages/cli/src/index.ts`) so the desktop can resolve the socket.
2. Add `stage` + `apiBaseUrl` to the `daemon.handshake` payload (`DaemonHandshake`,
   the `daemon.handshake` handler, `DaemonHandlerDeps`, and the `runDaemon` wiring).
3. Late-attach snapshot: `AgentRuntimeManager` tracks the last `approvalUrl` per
   agent and clears it once status leaves `awaiting_approval`; `agent.list` now
   includes `approvalUrl?` on `AgentStatusInfo` so a freshly-attached desktop can
   render a pending approval. (Chosen over a separate `agent.getRuntimeState` RPC —
   enriching the list the connector already calls on attach is one round-trip.)

## Decisions to make before coding

- **Daemon discovery/spawn.** ⚠️ **SUPERSEDED by Task #8 (2026-06-09).** The
  original decision was that the daemon ships as a **separate npm/global install**
  (`npm i -g @newio/cli`) and the desktop only *attaches* to a running daemon. We
  are now **reversing** this for the desktop: the Electron app **bundles and
  supervises** the daemon (still attaching over the same socket; the standalone CLI
  stays the headless/server path). See Task #8. The "what if none is running" UX
  below still applies as a fallback when the embedded daemon is disabled.
- **Protocol skew UX.** `handshake` mismatch → desktop must tell the user to update
  the daemon (or vice-versa). Design the message/modal.
- **Stage selection.** The desktop has a dev/prod environment selector
  (build-time `__NEWIO_STAGE__`). Make sure the socket path it connects to matches
  the stage the user picked. The daemon is per-stage.
- **Single-writer enforcement during migration.** Until this lands, do NOT run the
  desktop and the daemon against the same stage's `dataDir` simultaneously — both
  would write `config.json`/`cron.json`. After this lands, only the daemon writes.

## Deferred item to fold in here (from #186) — DONE in pre-work

A **transient-state snapshot** for late-attaching clients. Notifications
(`approvalUrl`, `pollAttempt`, `statusChanged`) are fire-and-forget broadcasts; a
desktop that connects mid-auth misses them. Landed in the pre-work PR:
`AgentRuntimeManager` tracks the last `approvalUrl` per agent and clears it once
status leaves `awaiting_approval`, and `agent.list` returns it as
`AgentStatusInfo.approvalUrl`. The connector renders any pending approval from the
`listAgents()` call it already makes on attach (no separate snapshot RPC needed).

## Key files

- `packages/connector/src/main/index.ts` — engine construction + listener wiring
  (the core change).
- `packages/connector/src/main/ipc-handler.ts` — IPC method impls (delegate to
  connector).
- `packages/connector/src/shared/ipc-events.ts` — push event channels (unchanged
  names; rewire the source).
- `packages/connector/src/shared/ipc-api.ts` — IPC contract (unchanged).
- `packages/cli/src/index.ts` — library exports (add `getDaemonPaths`/`resolveStage`
  here for the desktop).
- `packages/cli/src/connector.ts` / `client.ts` — the `DaemonConnector` the desktop
  will use.

## Task #8: Bundle + supervise the daemon in the Electron app (Option B)

**Status:** planned (2026-06-09). Reverses the "separate install only" decision above.

**Goal:** the desktop app **bundles and supervises** the daemon (as a LaunchAgent),
so desktop users don't install the CLI separately and the daemon inherits the app's
Developer ID signing/notarization + product-name attribution (and `sharp`/`blurhash`
work, since native modules are fine in Electron). The standalone SEA + `curl|bash`
CLI (PR #205) stays the **headless/server** path. Both run the same daemon code
against the same per-stage socket, so the Task #7 thin-client wiring is unchanged —
the app just becomes another way to *launch* the daemon it already connects to.

**Decisions already made (don't re-litigate):**
- **LaunchAgent, not a child process.** Background persistence when the app is closed
  is the point; a child process (`utilityProcess.fork`) gives none. Trade-off: BTM
  shows the product Name but the *Developer* stays the app's cert ("Nan Qin" until an
  org account — tracked separately).
- **Run via Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`), not a bundled SEA binary.**
  Electron already ships Node; bundling the ~109 MB SEA would duplicate the runtime.
  The LaunchAgent program is the app's own executable + a small asar-unpacked daemon
  entry that calls `runDaemon()`.
- **Register via the CLI's existing service manager first** (write plist/unit +
  `launchctl bootstrap`, reusing PR #205's `InstallOptions.programArguments`).
  Evaluate `SMAppService` (macOS 13+, best attribution + Login Items UX) as a
  follow-up — Electron has no agent API, so it needs a native shim.
- **Attach-if-running.** On launch, check the per-stage socket; attach if a daemon is
  already up (e.g. a user's CLI daemon), else install/start the app's LaunchAgent.
  Gate behind a setting (default on). Single-writer holds — the daemon refuses to
  start on a live socket.

**Gotchas an explorer won't infer:**
- The **MCP bridge** is spawned via `process.execPath` (= Electron here), so those
  spawns also need `ELECTRON_RUN_AS_NODE=1` (intersects `resolveSelfExec`'s non-SEA
  branch from PR #205; the bridge is already `asarUnpack`ed).
- The daemon runs V8 under the hardened runtime → the **JIT entitlements**
  (`allow-jit`, `allow-unsigned-executable-memory`) must cover the helper process,
  not just the renderer.
- **Uninstall**: removing the `.app` won't remove the LaunchAgent — needs an explicit
  "remove background service" path (the setting toggle + an uninstall hook).

**Where to start:** export `runDaemon` + `createServiceManager` from `@newio/cli`,
then add an `EmbeddedDaemon` launcher in the connector main (resolve socket → install
the LaunchAgent if not alive → `DaemonConnector.connect`). Reuse from PR #205: the
service managers, `InstallOptions.programArguments`, `resolveSelfExec`, and systemd
arg-quoting. Everything else (electron-builder config, `asarUnpack`, the IPC surface,
`@newio/cli` exports) is discoverable in-repo — explore it.

## Validation gate (run from agent-connector root before every push)

```
pnpm format:check   # fix: pnpm format:fix
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

PR workflow: branch off `main`, never push to `main`, rebase before opening +
before merging, squash-merge, delete branch. End commit messages with the
`Co-Authored-By: Claude Opus 4.8` trailer and PR bodies with the Claude Code
trailer.
