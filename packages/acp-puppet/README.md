# @newio/acp-puppet

A **deterministic, test-driven ACP agent** — a "puppet" the connector can spawn
in place of a real LLM-backed agent (kiro-cli, claude-code, …) for platform
end-to-end tests.

## Why

Platform e2e tests answer _"does the plumbing work?"_ — a message routed
desktop → backend → connector → agent and back, with the right sessions and
permissions. A real LLM in that loop is flaky, slow, costly, and drags in the
agent's whole runtime environment (binaries installed, logged in, API keys). The
puppet removes all of that: it speaks the ACP protocol exactly like a real agent
but does precisely — and only — what the test scripts.

> Agent _behaviour_ correctness (did it say the right thing?) is a different
> question, answered by `@newio/eval` with real agents + an LLM judge. Keep the
> two concerns in separate harnesses.

## How it works

- The connector spawns the puppet as a `custom` agent (`executablePath`), and
  talks to it over stdio as the ACP **client**. The puppet is the ACP **agent**:
  it implements `initialize` / `newSession` / `loadSession` / `prompt` / `cancel`,
  and advertises `loadSession` (which the connector requires).
- Replies are emitted as `agent_message_chunk` updates. The connector
  auto-delivers those to the current conversation, so the basic message
  round-trip needs **no MCP** at all.
- On session create/load the puppet spawns the Newio MCP bridge the connector
  asked for (without speaking MCP over it) purely so the connector's per-launch
  MCP-wiring wait resolves immediately instead of timing out.
- Behaviour is decided live by a `PuppetDriver` inside the test, over a Unix
  **control socket** the connector passes via `PUPPET_CONTROL_SOCKET`. Each
  prompt turn, the puppet asks the driver what to do and blocks until told.

```
        ACP (stdio)                         control channel (UDS)
connector  ───────────►  puppet (bin.js)  ◄─────────────────────►  PuppetDriver (test)
  client                  ACP agent          PUPPET_CONTROL_SOCKET     onPrompt(...)
```

## Usage (from a test / harness)

```ts
import { PuppetDriver } from '@newio/acp-puppet';

const driver = await PuppetDriver.start();
driver.onPrompt(({ text }) => (text.includes('PING') ? 'pong' : 'hello'));

// Configure the connector's `custom` agent with:
//   executablePath: driver.executablePath          // `<node> <dist/bin.js>`
//   envVars:        { PUPPET_CONTROL_SOCKET: driver.socketPath }

// A handler may return a string (one message), a TurnAction[] (ordered
// messages/thoughts), or a full TurnInstruction (stopReason, delays).
await driver.stop();
```

## Status

Implemented: message round-trip (text replies + thoughts), live control channel,
MCP-bridge spawn to avoid wiring timeouts, graceful fallback when no driver is
attached.

Not yet: acting as a real MCP **client** (so the puppet can call
`send_message` / `send_dm` / memory tools to drive cross-conversation and
memory flows). That's the next extension for richer platform scenarios.
