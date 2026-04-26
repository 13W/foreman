# Getting started

This tutorial takes you from a clean checkout to running a complete Foreman setup with one task executed end-to-end.

## 1. Prerequisites

- **Node.js**: >= 24.0.0
- **pnpm**: 10.x
- **Anthropic API Key**: You need an API key from [Anthropic](https://console.anthropic.com/).

## 2. Clone and build

First, clone the repository and build all packages:

```bash
git clone https://github.com/13W/foreman.git
cd foreman
pnpm install
pnpm build
```

Verify that the build is successful by running the tests:

```bash
pnpm test
```
All tests should pass.

## 3. Concept overview

Foreman Stack consists of several moving parts:

- **Foreman**: The orchestrator. It talks to you via ACP and manages the execution of tasks.
- **Proxy**: A protocol adapter that wraps a standard ACP agent (like Claude Code) and makes it available to the Foreman over the A2A protocol.
- **Planner**: A specialized agent that takes your goal and breaks it down into a structured plan of subtasks.
- **Workers**: The agents that perform the actual work in isolated Git worktrees.

## 4. Configure your first proxy

You need at least one worker to do the work. Let's configure a "refactorer" agent using Claude Code.

Create a file named `proxy-refactorer.yaml` in the root of the project:

```yaml
proxy:
  name: "refactorer"
  bind: "127.0.0.1:7001"

wrapped_agent:
  command: "claude"
  args: ["--acp"]

role:
  description: "TypeScript refactoring specialist."
  skills:
    - id: "typescript-refactoring"
      name: "TypeScript Refactoring"

worktrees:
  base_dir: "./worktrees"
  default_base_branch: "master"
```

*Note: Ensure you have `claude` (Claude Code) installed globally or provide the full path to the binary.*

## 5. Configure the planner

The Foreman needs a planner to decompose tasks. We'll use the built-in planner, also wrapped in a proxy.

Create `planner.yaml`:

```yaml
planner:
  name: "foreman-planner"
llm:
  model: "claude-3-5-sonnet-20240620"
```

And `proxy-planner.yaml` to wrap it:

```yaml
proxy:
  name: "planner"
  bind: "127.0.0.1:7003"

wrapped_agent:
  command: "node"
  args: ["packages/planner/dist/cli.js", "--config", "planner.yaml"]

role:
  description: "Expert agent for decomposing complex tasks."
  skills:
    - id: "task_decomposition"
```

## 6. Configure foreman

Now, create the main `foreman.yaml` to connect everything:

```yaml
foreman:
  name: "my-foreman"
  working_dir: "."

llm:
  backend: "anthropic"
  model: "claude-sonnet-4-7"

workers:
  - url: "http://127.0.0.1:7001"
    name_hint: "refactorer"
  - url: "http://127.0.0.1:7003"
    name_hint: "planner"
```

## 7. Start the subprocesses

You'll need three terminal windows or a tmux session.

**Terminal 1 (Refactorer Proxy):**
```bash
export ANTHROPIC_API_KEY=your_key_here
node packages/proxy/dist/cli.js --config proxy-refactorer.yaml
```

**Terminal 2 (Planner Proxy):**
```bash
export ANTHROPIC_API_KEY=your_key_here
node packages/proxy/dist/cli.js --config proxy-planner.yaml
```

**Terminal 3 (Foreman):**
```bash
export ANTHROPIC_API_KEY=your_key_here
node packages/foreman/dist/cli.js --config foreman.yaml
```

You should see logs in each terminal indicating that the services have started.

## 8. Connect with an ACP client

The easiest way to talk to the Foreman is using a simple Node.js script. First, install the ACP SDK in the root:

```bash
pnpm add -w @agentclientprotocol/sdk
```

Now, create `client.js` in the project root:

```javascript
import { spawn } from 'node:child_process';
import { AgentSideConnection } from '@agentclientprotocol/sdk';

const foreman = spawn('node', ['packages/foreman/dist/cli.js', '--config', 'foreman.yaml'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

const conn = new AgentSideConnection(foreman.stdout, foreman.stdin);

async function run() {
  await conn.initialize({
    protocolVersion: 1,
    clientInfo: { name: "test-client", version: "1.0.0" },
    clientCapabilities: { auth: { terminal: false }, fs: { readTextFile: true, writeTextFile: true }, terminal: false }
  });

  const { sessionId } = await conn.sessionNew({ cwd: process.cwd() });

  // Stream updates to console
  conn.onSessionUpdate((update) => {
    if (update.sessionId === sessionId) {
      update.content.forEach(part => {
        if (part.type === 'text') process.stdout.write(part.text);
      });
    }
  });

  console.log("Sending task to Foreman...");
  const response = await conn.sessionPrompt({
    sessionId,
    content: [{ type: "text", text: "Please refactor the logger.ts file to use a more descriptive format." }]
  });

  console.log("\nFinal response:", response);
  process.exit(0);
}

run().catch(console.error);
```

*Note: This script starts its own Foreman instance for simplicity.*

## 9. Send a simple task

Run the client script:

```bash
node client.js
```

Observe the logs:
1. Foreman receives the request.
2. Foreman dispatches the task to the **Planner**.
3. Planner returns a plan with subtasks.
4. Foreman dispatches subtasks to the **Refactorer**.
5. Refactorer works in a separate Git worktree.
6. Foreman collects results and responds to you.

## 10. Troubleshooting

- **`ANTHROPIC_API_KEY` not set**: Ensure the environment variable is exported in all terminals.
- **Worker unreachable**: Check if the proxies are running and listening on the correct ports (7001, 7003).
- **Git errors**: Ensure you are in a valid Git repository, as workers use worktrees.
- **Module not found**: Ensure you ran `pnpm build` before starting the services.

## 11. Next steps

- Explore `packages/proxy/examples/proxy.yaml` for more worker configuration options.
- Link your Foreman to more specialized agents.
- Read the Architecture and Configuration guides (coming soon) for advanced usage.
