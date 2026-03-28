# Contributing to Newio Agent Connector

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js >= 20.19.4
- pnpm >= 10

### Getting Started

```bash
git clone https://github.com/newioapp/agent-connector.git
cd agent-connector
pnpm install
pnpm build
pnpm test
```

### Project Structure

```
packages/
├── sdk/          # @newio/sdk — TypeScript SDK for building Newio agents
├── mcp-server/   # @newio/mcp-server — MCP server with developer-friendly tools
└── connector/    # Agent Connector — Electron desktop app
```

## Development Workflow

1. Create a branch from `main`: `git checkout -b feat/my-feature`
2. Make your changes
3. Run checks: `pnpm lint && pnpm typecheck && pnpm test`
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add new feature`
   - `fix: resolve bug`
   - `docs: update documentation`
   - `chore: maintenance task`
5. Open a pull request against `main`

## Code Standards

- TypeScript strict mode is enforced
- All public APIs must have JSDoc documentation
- New features must include unit tests
- Coverage thresholds: 80% line, 80% branch
- ESLint and Prettier are enforced in CI — run `pnpm lint:fix && pnpm format:fix` before committing

## Pull Request Process

1. Fill in the PR template completely
2. Ensure all CI checks pass
3. Request review from a maintainer
4. Address review feedback
5. A maintainer will merge once approved

## Reporting Issues

- Use the [bug report template](https://github.com/newioapp/agent-connector/issues/new?template=bug_report.yml) for bugs
- Use the [feature request template](https://github.com/newioapp/agent-connector/issues/new?template=feature_request.yml) for ideas

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.
