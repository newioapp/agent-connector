# Agent Connector — Project Plan

Last updated: 2026-03-28

## Vision

Three layers of agent integration for the Newio messaging platform:

1. **@newio/sdk** — Open source TypeScript SDK for developers to build agents that connect to Newio. Exposes agent-specific APIs only (no human-only endpoints).
2. **Agent Connector** — Open source Electron desktop app that connects existing agents to Newio. Like Docker Desktop for agents — manage multiple agent instances, each with its own Newio identity. Supports Claude (via Agent SDK) and ACP-compatible agents.
3. **@newio/mcp-server** — Local MCP server built on the SDK. Provides developer-friendly tools (username-based lookups instead of UUIDs). Runs inside the connector, pre-authenticated per agent.

All three live in a monorepo at `/Users/pineapple/workspace/agent-connector` (GitHub: `newioapp/agent-connector`).

## Key Decisions

- **npm scope**: `@newio` (registered, owned)
- **GitHub org**: `newioapp`
- **SDK is fully separate from `@conduit/client`** — no shared dependency, standalone package
- **TypeScript first**, Python SDK later once TS interface is stable
- **No separate API Gateway for agents** — same backend, SDK just exposes the agent-relevant subset
- **Auth flow**: Register (no owner ID needed, approver becomes owner) → poll for tokens. Login (agentId) → owner approves → poll for tokens. Same approval URL + poll pattern for both.
- **Agent Connector is open source** — human login API is internal/first-party only, so the connector uses agent auth exclusively. Future: OAuth 2.0 support for human identity.
- **MCP server runs inside the connector**, pre-authenticated per agent. For Claude (Agent SDK), tools are registered directly. For ACP agents, exposed over stdio or local HTTP.
- **Build order**: SDK → Connector → MCP Server (built into connector)

## Monorepo Structure

```
agent-connector/
├── packages/
│   ├── sdk/                  # @newio/sdk
│   │   ├── src/
│   │   │   ├── client.ts     # REST API client (agent-only endpoints)
│   │   │   ├── websocket.ts  # WebSocket client (real-time events)
│   │   │   ├── auth.ts       # Registration, login, token management
│   │   │   ├── types.ts      # Public types
│   │   │   └── index.ts      # Public API surface
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── mcp-server/           # @newio/mcp-server
│   │   ├── src/
│   │   │   ├── tools/        # MCP tool handlers (uses @newio/sdk)
│   │   │   └── server.ts
│   │   └── package.json
│   │
│   └── connector/            # Agent Connector desktop app (Electron)
│       ├── src/
│       │   ├── main/         # Electron main process
│       │   ├── renderer/     # UI (React)
│       │   ├── adapters/     # Agent protocol adapters
│       │   │   ├── claude.ts # Claude Agent SDK adapter
│       │   │   └── acp.ts    # ACP client adapter
│       │   └── runtime/      # Agent lifecycle management
│       └── package.json
│
├── package.json              # Workspace root
├── tsconfig.json
└── README.md
```

## SDK API Surface

See `GUIDELINES.md` for the full backend API reference (endpoints, request shapes, WebSocket events, domain concepts). The SDK methods map 1:1 to those endpoints, with convenience wrappers for username-based lookups and auto-managed sequenceNumbers.

## Task Breakdown

### Phase 0: Project Quality & Open Source Foundation (Q1)

**Q1: Open source project foundation**

This is an open source project that handles agent identity and messaging. Trust is paramount. All quality infrastructure must be in place before any feature code lands.

Repository & Community:
- `README.md` — project overview, badges (CI, npm version, license), quickstart, architecture diagram
- `LICENSE` (MIT)
- `CONTRIBUTING.md` — how to contribute, development setup, coding standards, PR process
- `CODE_OF_CONDUCT.md` — Contributor Covenant
- `SECURITY.md` — vulnerability reporting process (email, response SLA)
- `CHANGELOG.md` — keep-a-changelog format, updated per release
- `.github/FUNDING.yml` — if applicable

GitHub Templates:
- `.github/ISSUE_TEMPLATE/bug_report.yml` — structured bug report (YAML form, not markdown)
- `.github/ISSUE_TEMPLATE/feature_request.yml` — structured feature request
- `.github/ISSUE_TEMPLATE/config.yml` — disable blank issues, link to discussions
- `.github/pull_request_template.md` — checklist (tests, docs, changelog, breaking changes)
- `.github/CODEOWNERS` — auto-assign reviewers

CI/CD (GitHub Actions):
- **PR checks workflow** (`pr.yml`):
  - Lint (ESLint + Prettier check)
  - Type check (`tsc --noEmit`)
  - Unit tests with coverage report
  - Build all packages
  - Package size check (report bundle size delta on PRs)
  - Spell check on docs/comments (cspell)
- **Release workflow** (`release.yml`):
  - Triggered by version tags (`sdk-v*`, `mcp-server-v*`)
  - Build → test → publish to npm
  - Generate GitHub Release with changelog
  - Provenance attestation (npm `--provenance` flag for supply chain security)
- **Dependency audit** (`audit.yml`):
  - Weekly `npm audit` run
  - Dependabot or Renovate for automated dependency updates
- **CodeQL** (`codeql.yml`):
  - GitHub CodeQL analysis for security vulnerabilities
  - Runs on PRs and weekly schedule

Code Quality:
- ESLint with strict TypeScript rules (no-explicit-any, strict-boolean-expressions, etc.)
- Prettier for formatting
- `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`
- Husky + lint-staged for pre-commit hooks (lint + format changed files)
- Commitlint for conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `BREAKING CHANGE:`)
- `.editorconfig` for consistent editor settings across contributors

Testing Standards:
- Vitest as test runner (fast, ESM-native, good TypeScript support)
- Coverage thresholds enforced in CI (80% line, 80% branch minimum)
- Coverage report posted as PR comment

Documentation:
- JSDoc on every public export
- API reference auto-generated from JSDoc (TypeDoc)
- `docs/` directory with guides (getting started, authentication, messaging, events)
- Examples directory (`examples/`) with runnable sample agents

Package Quality:
- `tsup` for bundling — ESM + CJS dual output
- `package.json` `exports` field properly configured
- `files` field to keep published package minimal
- `engines` field specifying minimum Node.js version
- `types` field pointing to generated `.d.ts`
- `sideEffects: false` for tree-shaking
- `npm pack --dry-run` in CI to verify package contents

### Phase 1: SDK Foundation (S1–S7)

**S1: Monorepo scaffolding**
- Initialize monorepo with pnpm workspaces
- TypeScript config (base + per-package extends)
- Build tooling (tsup for SDK bundling)
- Wire up all Q1 infrastructure (CI workflows, linting, hooks, templates)

**S2: SDK — Auth module**
- `register({ name })` → returns approval handle with `waitForApproval()`
- `login({ agentId })` → returns approval handle with `waitForApproval()`
- `waitForApproval()` polls on interval, resolves with tokens, rejects on expiry
- `TokenManager` — auto-refresh before expiry, dedup concurrent refreshes
- Token storage interface (in-memory default, pluggable for persistent storage)
- `revoke()` for logout

**S3: SDK — REST client (profile, users, contacts)**
- `NewioClient` class — main entry point, takes `{ baseUrl, tokenProvider }`
- Profile: `getMe()`, `updateMe()`, `checkUsernameAvailability()`
- User discovery: `getUserByUsername()`, `getUser()`, `searchUsers()`, `getUserSummaries()`, `getUserAgents()`
- Contacts: `listFriends()`, `sendFriendRequest()`, `sendFriendRequestByUsername()`, `listIncomingRequests()`, `listOutgoingRequests()`, `revokeOutgoingRequest()`, `acceptFriendRequest()`, `rejectFriendRequest()`, `updateFriendName()`, `removeFriend()`
- Blocks: `blockUser()`, `unblockUser()`, `listBlocks()`

**S4: SDK — REST client (conversations, messages, media)**
- Conversations: `createConversation()`, `createDm()`, `createDmByUsername()`, `listConversations()`, `getConversation()`, `updateConversation()`, `updateConversationSettings()`, `addMembers()`, `removeMember()`, `updateMemberRole()`, `markRead()`
- Messages: `sendMessage()` (auto sequenceNumber), `listMessages()`, `getMessage()`, `editMessage()`, `deleteMessage()`
- Media: `uploadFile()` (presigned URL + upload in one call), `uploadAvatar()`, `getDownloadUrl()`
- Agent settings: `getMySettings()`, `updateMySettings()`, `updateMyProfile()`

**S5: SDK — WebSocket client**
- `connect()` / `disconnect()`
- Auto-reconnect with exponential backoff
- Keepalive ping (5 min interval)
- Proactive reconnect at 1h50m
- Typed event handlers: `on(event, handler)` / `off(event, handler)`
- On-demand topic subscribe/unsubscribe
- Connection state listeners

**S6: SDK — Types and public API**
- Define all public types (request/response interfaces, event types, enums)
- Types are standalone — no dependency on `@conduit/shared`
- Export clean public API from `index.ts`
- Ensure tree-shakeable ESM + CJS dual output

**S7: SDK — Tests and documentation**
- Unit tests for auth module (register, login, poll, token refresh)
- Unit tests for REST client methods
- Unit tests for WebSocket client (connect, reconnect, event dispatch)
- README with quickstart guide
- JSDoc on all public methods
- Publish to npm as `@newio/sdk`

### Phase 2: Agent Connector (C1–C8)

**C1: Connector — Electron app scaffolding**
- Electron + React + Tailwind + shadcn/ui (same stack as Newio desktop for consistency)
- Main/renderer process split
- Basic window with navigation
- App icon, metadata

**C2: Connector — Agent registry and configuration UI**
- Agent type registry (Claude, ACP — extensible)
- Per-agent-type configuration form:
  - Claude: Anthropic API key, model, system prompt
  - ACP: server URL, transport (stdio/HTTP)
- Agent instance creation flow: pick type → configure → enter/create Newio agent username
- Persist agent configurations to local storage (Electron app data)

**C3: Connector — Agent lifecycle management**
- Agent instance model: config + Newio identity + runtime state (stopped/starting/running/error)
- Start agent: SDK auth (register or login) → approval URL → poll → tokens → connect WebSocket
- Stop agent: disconnect WebSocket, revoke tokens
- Agent list view with status indicators
- Auto-restart on crash (with backoff)

**C4: Connector — Claude Agent SDK adapter**
- Integrate `@anthropic-ai/agent-sdk` (runs in-process)
- Bridge: Newio message.new events → Claude agent conversation turn
- Bridge: Claude agent responses → Newio sendMessage
- Register Newio MCP tools directly on the Claude session (no separate MCP server process needed)
- Handle multi-turn conversations

**C5: Connector — ACP adapter**
- ACP client implementation
- Spawn ACP agent server as child process (stdio transport) or connect to remote (HTTP transport)
- Bridge: Newio events → ACP messages
- Bridge: ACP responses → Newio messages
- Pass MCP server to ACP agent via stdio or local HTTP endpoint

**C6: Connector — MCP server integration**
- Build `@newio/mcp-server` package
- Tools: `send_message`, `create_conversation`, `list_conversations`, `get_messages`, `send_friend_request` (by username), `list_friends`, `search_users`, `upload_file`, etc.
- Username-based lookups where possible (resolve internally via SDK)
- Per-agent instance: MCP server pre-authenticated with that agent's tokens
- For Claude adapter: register tools directly via Agent SDK
- For ACP adapter: expose as stdio MCP server or local HTTP

**C7: Connector — Settings and polish**
- Global settings (default API endpoint, theme)
- Per-agent logs viewer
- Error handling and user-friendly error messages
- System tray support (run in background)

**C8: Connector — Packaging and distribution**
- electron-builder config for macOS (arm64 + x64)
- Linux (AppImage + deb)
- Windows (NSIS installer)
- Auto-update mechanism
- GitHub Actions release workflow

### Phase 3: MCP Server Standalone (M1–M2)

**M1: MCP server — standalone mode**
- `@newio/mcp-server` can also run standalone (outside the connector)
- CLI entry point: `npx @newio/mcp-server --agent-id <id>`
- Handles its own auth flow (register/login + approval)
- Stdio transport for use with Claude Desktop, Cursor, etc.

**M2: MCP server — documentation**
- Setup guide for Claude Desktop, Cursor, Windsurf
- Tool reference documentation
- Example workflows (register agent → add friend → send message)

## Dependency Graph

```
Q1 (Quality Foundation)
└── S1 (Scaffolding) ── wires up Q1 infra
    ├── S2 (Auth) ──┬── S3 (REST: profile/contacts)
    │               └── S5 (WebSocket)
    ├── S6 (Types) ─── used by S2, S3, S4, S5
    └── S4 (REST: conversations/messages/media) ── depends on S3 patterns

S7 (Tests/Docs) ── after S2–S6

C1 (Electron scaffolding)
├── C2 (Registry/Config UI)
├── C3 (Lifecycle) ── depends on S2 (SDK auth)
├── C4 (Claude adapter) ── depends on C3, C6
├── C5 (ACP adapter) ── depends on C3, C6
├── C6 (MCP server) ── depends on S3, S4
├── C7 (Settings/Polish) ── after C2–C6
└── C8 (Packaging) ── after C7

M1 (Standalone MCP) ── depends on C6
M2 (MCP docs) ── after M1
```

## Suggested Build Order

| Sprint | Tasks | What ships |
|---|---|---|
| 1 | Q1, S1, S2, S6 | Quality infra + monorepo + SDK auth + types |
| 2 | S3, S4 | Full REST client |
| 3 | S5, S7 | WebSocket + tests + publish @newio/sdk |
| 4 | C1, C2, C3 | Connector app with agent management |
| 5 | C6 | MCP server package |
| 6 | C4 | Claude adapter (end-to-end Claude ↔ Newio) |
| 7 | C5 | ACP adapter |
| 8 | C7, C8 | Polish + packaging |
| 9 | M1, M2 | Standalone MCP server + docs |

## Backend Gaps to Address (in conduit repo)

1. **Username-based friend requests**: Currently `POST /contacts/requests` requires `contactId` (UUID). The SDK works around this by resolving username → userId first, but a native `username` param on the endpoint would be cleaner. Low priority — SDK convenience method handles it.
2. **Agent login without owner presence**: The approval URL + poll flow requires a human to open a browser. For headless/server deployments, consider a long-lived API key mechanism in the future. Not blocking for v1 — the connector has the user present.
