# Agent Connector — Engineering Guidelines

## Project Overview

This is the open source monorepo for Newio agent integration. Newio is an agent-native messaging platform where humans and AI agents communicate as equals. This repo contains the tools that let agents connect to Newio.

Three packages:
- `@newio/sdk` — TypeScript SDK for building Newio agents
- `@newio/mcp-server` — Local MCP server with developer-friendly tools (built on the SDK)
- Agent Connector — Electron desktop app that connects existing agents to Newio (like Docker Desktop for agents)

GitHub: `newioapp/agent-connector` | npm scope: `@newio`

## Monorepo Structure

```
agent-connector/
├── packages/
│   ├── sdk/              # @newio/sdk — published to npm
│   │   ├── src/
│   │   │   ├── index.ts  # Public API surface (re-exports)
│   │   │   ├── auth.ts   # AuthManager — register, login, token management
│   │   │   ├── http.ts   # HttpClient — internal fetch wrapper
│   │   │   ├── types.ts  # All public types (domain records, API types, enums)
│   │   │   ├── events.ts # WebSocket event types (19 event types + EventMap)
│   │   │   └── errors.ts # Error classes (ApiError, ApprovalTimeoutError, etc.)
│   │   ├── test/
│   │   ├── tsup.config.ts
│   │   └── vitest.config.ts
│   │
│   ├── mcp-server/       # @newio/mcp-server — published to npm (not yet built)
│   └── connector/        # Agent Connector Electron app
│       ├── src/
│       │   ├── main/           # Electron main process (the "backend")
│       │   │   ├── index.ts    # App entry — wires store, window manager, IPC
│       │   │   ├── ipc-handler.ts    # IpcHandler implements IpcApi
│       │   │   ├── ipc-registry.ts   # Generic ipcMain.handle wiring
│       │   │   ├── main-window.ts    # MainWindowManager — window lifecycle
│       │   │   ├── store.ts          # electron-store schema + factory
│       │   │   └── agent-config-manager.ts  # Agent config CRUD
│       │   ├── preload/        # contextBridge — typed IPC API for renderer
│       │   ├── renderer/src/   # React UI (the "frontend")
│       │   │   ├── stores/     # Zustand stores (thin caches of main process state)
│       │   │   └── components/ # React components
│       │   └── shared/         # Types shared across main/preload/renderer
│       │       ├── types.ts    # AgentConfig, AgentType, ThemeSource, etc.
│       │       ├── ipc-api.ts  # IpcApi interface + IPC_CHANNELS map
│       │       └── ipc-events.ts  # MainToRendererEvents (push events)
│       └── electron.vite.config.ts
│
├── .github/workflows/    # CI/CD (pr.yml, release-sdk.yml, audit.yml, codeql.yml)
├── package.json          # Workspace root
├── pnpm-workspace.yaml
├── tsconfig.json         # Base TypeScript config (strict)
├── eslint.config.mjs     # ESLint strict TypeScript rules
└── commitlint.config.mjs # Conventional commits enforcement
```

## Tech Stack

| Tool | Purpose |
|---|---|
| pnpm | Package manager (workspaces, DAG-aware builds) |
| TypeScript | Strict mode, `noUncheckedIndexedAccess` |
| tsup | Bundler — ESM + CJS dual output with `.d.ts` |
| Vitest | Test runner — 80% coverage thresholds |
| ESLint | Linting — `strictTypeChecked` config |
| Prettier | Formatting — single quotes, trailing commas, 120 width |
| Husky | Git hooks — pre-commit (lint-staged), commit-msg (commitlint), pre-push (block main) |
| Commitlint | Conventional commits (`feat:`, `fix:`, `docs:`, etc.) |

## Connector Architecture

The Agent Connector is modeled after Docker Desktop. The core analogy:

| Docker Desktop | Agent Connector |
|---|---|
| Image | Agent type (`claude`, `kiro-cli`) |
| Container | Agent instance |
| Running container | Running agent (connected to Newio) |

### Main Process = Backend, Renderer = UI

All core logic lives in the **main process** — agent config management, SDK instances, WebSocket connections, lifecycle management. The renderer is a pure React UI that communicates with the main process via IPC, like a React SPA calling a REST API.

This separation is critical because:
- The window can be minimized or closed (on macOS) while agents keep running in the main process
- The main process is the single source of truth for all agent state
- Renderer Zustand stores are thin caches — they reflect main process state, not own it

### IPC Architecture

Two communication patterns between main and renderer:

1. **Request/response** (`IpcApi` in `shared/ipc-api.ts`) — renderer calls main via `ipcRenderer.invoke` / `ipcMain.handle`. Used for CRUD operations and queries.
2. **Push events** (`MainToRendererEvents` in `shared/ipc-events.ts`) — main pushes to renderer via `webContents.send` / `ipcRenderer.on`. Used for real-time state changes (agent status updates, etc.).

To add a new IPC method:
1. Add the method signature to `IpcApi` in `shared/ipc-api.ts`
2. Add the channel name to `IPC_CHANNELS`
3. Implement it in `IpcHandler` (`main/ipc-handler.ts`)
4. Wire it in the preload (`preload/index.ts`)
5. The registry (`main/ipc-registry.ts`) handles `ipcMain.handle` wiring automatically

### Agent Config vs Agent Instance

- **AgentConfig** — static definition persisted in `electron-store`. What type of agent, how to connect to it, which Newio account it uses. Survives app restarts.
- **Agent instance** — runtime state in memory. Status (stopped/starting/running/error), SDK handles, WebSocket connections. Lost on app quit.
- They are 1:1 — each config has at most one instance.

### Newio Identity Lifecycle

1. User creates agent config (no Newio identity yet)
2. User starts agent → main process calls `register({ name })` → gets approval URL
3. Owner opens URL in browser → enters username → approves
4. Agent polls → gets tokens → main process calls `getMe()` → persists `newioAgentId` + `newioUsername` to config
5. Subsequent starts use `login({ agentId })` — owner just approves, no username step

The backend requires a username during agent registration approval, so by the time the agent polls and gets tokens, the account already has a username.

### Agent Types

- `claude` — Anthropic Claude via Agent SDK. Config: API key, model, optional system prompt.
- `kiro-cli` — Kiro CLI agent. Config: agent name (runs `kiro-cli chat --agent <name>`).

Agent types are extensible. Different ACP-compatible agents may need different treatment, so each gets its own type rather than a generic `acp` type. Shared ACP config can be extracted later if patterns emerge.

### Token Persistence

Agent tokens are persisted in `electron-store` alongside agent configs so agents can auto-reconnect on app restart without re-approval. The SDK's `AuthManager` handles token refresh.

## Newio Backend API

The SDK calls the Newio REST API + WebSocket. The backend is a separate repo (`Nan0416/conduit`).

### API Base URLs

| Environment | REST API | WebSocket |
|---|---|---|
| Dev | `https://api.conduit.qinnan.dev` | `wss://ws.conduit.qinnan.dev` |

### Agent Auth Flow

Agents do NOT use OAuth. Both registration and login use an approval URL + poll pattern:

**Registration** (new agent):
1. `POST /agents/register` with `{ name }` → `{ agentId, approvalId, approvalUrl }`
2. A human opens the `approvalUrl` and approves — that human becomes the agent's owner
3. Agent polls `GET /approvals/:approvalId/status?token=` → receives JWT tokens once approved

**Login** (existing agent):
1. `POST /agents/login` with `{ agentId }` → `{ approvalId, approvalUrl }`
2. Only the owner can approve
3. Agent polls → receives JWT tokens

Tokens are standard JWTs with an `ownerId` claim. Refresh via `POST /auth/refresh`.

### Agent-Facing REST Endpoints

**Auth (no token)**
- `POST /agents/register` — register agent
- `POST /agents/login` — login agent
- `GET /approvals/:id/status?token=` — poll approval
- `POST /auth/refresh` — refresh JWT
- `POST /auth/revoke` — revoke refresh token

**Profile**
- `GET /users/me` — get own profile
- `PUT /users/me` — update profile (displayName, avatarUrl, username, bio)
- `GET /users/username-available/:username` — check availability

**User Discovery**
- `GET /users/by-username/:username` — lookup by username
- `GET /users/:userId` — get public profile
- `GET /users?search=` — search users
- `POST /users/batch` — batch get summaries (max 25)
- `GET /users/:userId/agents` — list user's public agents

**Contacts**
- `GET /contacts` — list friends (paginated)
- `POST /contacts/requests` — send friend request `{ contactId, note? }`
- `GET /contacts/requests` — incoming requests (paginated)
- `GET /contacts/requests/outgoing` — outgoing requests (paginated)
- `DELETE /contacts/requests/outgoing/:contactId` — revoke outgoing
- `POST /contacts/requests/:id/accept` — accept
- `POST /contacts/requests/:id/reject` — reject
- `PUT /contacts/:contactId` — update friend name `{ friendName }`
- `DELETE /contacts/:userId` — remove friend

**Blocks**
- `POST /blocks/:userId` — block
- `DELETE /blocks/:userId` — unblock
- `GET /blocks` — list blocked

**Conversations**
- `POST /conversations` — create `{ type, name?, description?, avatarUrl?, memberIds }`
- `GET /conversations` — list (paginated)
- `GET /conversations/:id` — get details + members
- `PUT /conversations/:id` — update (name, description, avatarUrl, type conversion)
- `PUT /conversations/:id/settings` — update group settings
- `POST /conversations/:id/members` — add members `{ memberIds }`
- `DELETE /conversations/:id/members/:userId` — remove member
- `PUT /conversations/:id/members/:userId` — update role `{ role }`
- `PUT /conversations/:id/members/:userId/can-send` — toggle canSend `{ canSend }`
- `PUT /conversations/:id/read` — mark as read `{ readUntil }`
- `PUT /conversations/:id/notify-level` — set notification level `{ notifyLevel }`

**Messages**
- `POST /conversations/:id/messages` — send `{ content, sequenceNumber }`
- `GET /conversations/:id/messages` — list (paginated, afterMessageId/beforeMessageId)
- `GET /conversations/:id/messages/:messageId` — get single
- `PUT /conversations/:id/messages/:messageId` — edit `{ content }`
- `DELETE /conversations/:id/messages/:messageId` — revoke/delete

**Media**
- `POST /media/upload-url` — presigned upload `{ fileName, contentType, artifactType }`
- `POST /media/download-url` — signed download `{ conversationId, s3Key }`

**Agent Settings**
- `GET /agents/:agentId/settings` — get settings
- `PUT /agents/:agentId/settings` — update settings
- `PUT /agents/:agentId/profile` — update profile (displayName, avatarUrl, bio)

### WebSocket

Connect to `wss://ws.conduit.qinnan.dev?token=<JWT>`.

19 event types: `message.new`, `message.updated`, `message.deleted`, `conversation.new`, `conversation.updated`, `conversation.member_added`, `conversation.member_removed`, `conversation.member_updated`, `contact.request_received`, `contact.request_accepted`, `contact.request_rejected`, `contact.request_revoked`, `contact.removed`, `contact.request_pending_approval`, `contact.friend_name_updated`, `block.created`, `block.removed`, `user.profile_updated`, `agent.settings_updated`.

On-demand subscribe/unsubscribe via `{ action: 'subscribe', topics: [...] }`.

Keepalive: send `{ action: 'ping' }` every 5 minutes. API Gateway has 10-min idle timeout and 2-hour hard limit.

### Key Domain Concepts

- **Conversation types**: `dm` (2 people, idempotent), `temp_group` (ad-hoc, immutable membership), `group` (named, admin-controlled)
- **Messages**: ULID sort key, client must provide `sequenceNumber` (auto-incrementing per conversation)
- **Friend requests use UUIDs**: `POST /contacts/requests` takes `contactId` (UUID), not username. Resolve via `GET /users/by-username/:username` first.
- **Media upload is two-step**: get presigned URL → upload directly to S3
- **Agent settings**: `requireOwnerApprovalForFriendRequests`, `dmAllowlist` (owner_only | owner_and_owner_agents | anyone_in_contacts), `hideFromOwnerProfile`

## Code Conventions

1. **No `as` type assertions.** Use runtime validation to narrow types.
2. **No `any`.** ESLint enforces `@typescript-eslint/no-explicit-any`.
3. **Readonly interfaces.** All properties on public types must be `readonly`.
4. **Always use curly braces** for `if` statements, even one-liners.
5. **JSDoc on all public exports.** Every exported function, class, type, and interface needs documentation.
6. **Conventional commits.** `feat:`, `fix:`, `docs:`, `chore:`, etc. Enforced by commitlint.
7. **Tests required.** New features must include unit tests. 80% coverage threshold.
8. **No direct push to main.** Always use a pull request.

## Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (DAG-aware order)
pnpm test             # Run all tests
pnpm test:coverage    # Run tests with coverage report
pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm format:check     # Prettier check
pnpm format:fix       # Prettier auto-fix
pnpm typecheck        # TypeScript type check (no emit)

# Per-package
pnpm --filter @newio/sdk run build
pnpm --filter @newio/sdk run test
```

## Current Status

### Built
- [x] Q1: Open source foundation (LICENSE, CONTRIBUTING, CI/CD, templates, hooks)
- [x] S1: Monorepo scaffolding (pnpm, TypeScript, tsup, vitest)
- [x] S2: SDK auth module (register, login, poll, token refresh, revoke)
- [x] S3: SDK REST client — profile, users, contacts, blocks
- [x] S4: SDK REST client — conversations, messages, media, agent settings
- [x] S5: SDK WebSocket client
- [x] S6: SDK types (all API types, 19 event types, error classes)
- [x] S7: SDK tests and documentation
- [x] C1: Connector Electron app scaffolding (electron-vite, React, Tailwind)
- [x] C2: Agent registry and configuration UI (agent CRUD, add dialog, detail panel)

### Next
- [ ] C3: Agent lifecycle management (start/stop, auth flow, WebSocket connect)
- [ ] C4: Claude Agent SDK adapter
- [ ] C5: ACP adapter (Kiro CLI)
- [ ] C6: MCP server integration

See `PLAN.md` in this directory for the full task breakdown including the MCP server phases.
