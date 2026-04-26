# Foreman Stack

Foreman Stack is an orchestration system for parallel AI agents. It allows you to use a single "head" agent (**Foreman**) to decompose complex tasks and delegate them to specialized **Workers** (like Claude Code, Gemini CLI, or custom agents) that run in isolated environments.

By using the Agent Client Protocol (ACP) for user interaction and the Agent-to-Agent (A2A) protocol for inter-agent communication, Foreman Stack enables a multi-agent workflow where agents work in parallel without conflicting with your main workspace or each other.

## Architecture

```text
  User (Zed, Cursor, etc.)
          ↕
    [ ACP (stdio) ]
          ↕
       Foreman (Orchestrator & Plan Owner)
          ↕
    [ A2A (HTTP/SSE) ]
    /     |     \
  Proxy   Proxy   Proxy (Protocol Adapters)
    ↕       ↕       ↕
 [ ACP ] [ ACP ] [ ACP ]
    ↕       ↕       ↕
 Worker  Worker  Worker (Claude Code, Gemini, etc.)
   (In isolated Git Worktrees)
```

## Requirements

- **Node.js**: >= 24.0.0 (uses native TypeScript support)
- **pnpm**: 10.x
- **Anthropic API Key**: Required for the Foreman and Planner agents.

## Quick start

### 1. Install and build

```bash
git clone https://github.com/13W/foreman.git
cd foreman
pnpm install
pnpm build
```

### 2. Configure

Copy the example configurations and set your API key:

```bash
export ANTHROPIC_API_KEY=your_key_here

# Example configs are in packages/*/examples/
cp packages/proxy/examples/proxy.yaml ./proxy-refactorer.yaml
cp packages/foreman/examples/foreman.yaml ./foreman.yaml
```

### 3. Run

Start the components in separate terminals (or see [Getting started](docs/getting-started.md) for a full walkthrough):

```bash
# Start a proxy wrapping an agent (e.g., Claude Code)
node packages/proxy/dist/cli.js --config ./proxy-refactorer.yaml

# Start the Foreman
node packages/foreman/dist/cli.js --config ./foreman.yaml
```

## Documentation

- [**Getting started**](docs/getting-started.md) — Sequential tutorial from zero to running your first multi-agent task.
- [Architecture deep dive](docs/architecture.md) — (Coming soon) Detailed breakdown of protocols and components.
- [Configuration reference](docs/configuration.md) — (Coming soon) Exhaustive list of all configuration fields.
- [Troubleshooting](docs/troubleshooting.md) — (Coming soon) Common issues and how to fix them.

## Repository layout

- `packages/foreman` — The head agent that coordinates everything.
- `packages/proxy` — Protocol adapter that makes any ACP agent available over A2A.
- `packages/planner` — Specialized agent for task decomposition.
- `packages/shared` — Common schemas, types, and protocol utilities.
- `packages/integration-tests` — End-to-end test scenarios.

## Development

```bash
pnpm test          # Run all tests (vitest)
pnpm build         # Rebuild all packages
pnpm lint          # Run ESLint
pnpm format        # Run Prettier
```

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
