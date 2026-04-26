# Configuration reference

This document provides an exhaustive reference for all configuration fields used by the Foreman orchestrator and the Foreman Proxy adapter.

## Overview

Foreman Stack uses YAML files for configuration. By default, the tools look for configuration files in the following locations:

- **Proxy**: `~/.foreman/proxy.yaml`
- **Foreman**: `~/.foreman/foreman.yaml`

You can override these defaults by passing the `--config` flag when running the tools.

All configuration files are validated against a strict Zod schema at startup. Any missing required fields or invalid values will cause the process to exit with a descriptive error message.

---

## Proxy configuration

The Proxy configuration governs how the protocol adapter wraps an ACP agent and manages the A2A server.

### `proxy`
Basic identity and network binding for the proxy server.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `name` | string | - | Yes | The identity of the proxy. This name is published in the Agent Card and used by the Foreman for tool identification (e.g., `dispatch_refactorer`). |
| `version` | string | `0.1.0` | No | SemVer version of the proxy role/agent. |
| `bind` | string | - | Yes | The `host:port` to bind the A2A server to. **Must be a loopback address** (e.g., `127.0.0.1:7001`, `localhost:7002`). Remote binds are rejected for security. |

### `wrapped_agent`
Configuration for the underlying ACP agent subprocess managed by the proxy.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `command` | string | - | Yes | The binary to execute. Can be a name in the PATH or an absolute path. |
| `args` | string[] | `[]` | No | Command-line arguments passed to the agent. For many agents, this includes `--acp` or `--stdio`. |
| `env` | object | `{}` | No | Key-value pairs of environment variables injected into the agent's environment. Useful for providing agent-specific API keys. |
| `cwd_strategy` | string | `worktree` | No | How the working directory is managed. Currently, only `worktree` is supported, which ensures each task runs in an isolated Git worktree. |
| `startup_timeout_sec` | integer | `30` | No | Maximum time in seconds to wait for the agent to respond to the initial ACP `initialize` request. |

### `role`
Defines the skills and persona of the agent as presented to the Foreman and Planner.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `description` | string | - | Yes | A detailed prose description of the agent's expertise. The Planner uses this to decide if this worker is suitable for a specific subtask. |
| `skills` | object[] | `[]` | No | A list of structured skills defined below. |

#### Skill object
| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `id` | string | - | Yes | Unique identifier for the skill (e.g., `typescript_refactoring`). |
| `name` | string | - | Yes | Human-readable name of the skill. |
| `description` | string | - | Yes | Prose description of what the skill covers. |
| `tags` | string[] | `[]` | No | List of keywords for indexing and discovery. |
| `examples` | string[] | `[]` | No | Examples of queries this skill can handle. |

### `mcps`
Personal Model Context Protocol (MCP) servers that are always attached to the agent's sessions.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `personal` | object[] | `[]` | No | List of MCP server definitions. Each server has `name`, `command`, `args`, and `env`. |

### `permissions`
Governs how the proxy handles sensitive operations requested by the worker.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `terminal_whitelist` | string[] | `[]` | No | A list of terminal command basenames (e.g., `["npm", "pnpm", "git"]`) that are automatically approved. All others are escalated. |
| `permission_timeout_sec` | integer | `300` | No | The window in seconds during which a permission decision must be received before the task is aborted with a timeout error. |

### `worktrees`
Settings for managing isolated Git worktrees for each task.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `base_dir` | string | - | Yes | The root directory where task worktrees will be created. Should be outside the main project tree to avoid confusion. |
| `branch_prefix` | string | `foreman/task-` | No | The prefix used for temporary Git branches. |
| `default_base_branch` | string | `main` | No | The branch used as the starting point for new worktrees if the Foreman does not specify one. |
| `cleanup_policy` | string | `never` | No | Strategy for removing worktrees: `never` (manual), `on_success`, `always`, or `ttl` (future). |

### `runtime`
Performance and capacity constraints for the proxy process.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `max_subprocesses` | integer | `1` | No | The maximum number of independent ACP agent processes to run. |
| `max_sessions_per_subprocess` | integer | `1` | No | The maximum number of parallel tasks to run within a single subprocess using ACP multi-session support. |
| `task_hard_timeout_sec` | integer | `3600` | No | A global hard cap on task duration (in seconds) to prevent runaway processes. |

### `logging`
| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `level` | string | `info` | No | Verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `format` | string | `json` | No | Format: `json` (for logging stacks) or `pretty` (for terminal usage). |
| `destination` | string | `stderr` | No | Where to write logs: `stderr` or `stdout`. |

---

## Foreman configuration

The Foreman configuration governs the behavior of the central orchestrator.

### `foreman`
Primary identity and workspace configuration.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `name` | string | - | Yes | Name of this Foreman instance. |
| `version` | string | `0.1.0` | No | Version of the Foreman instance. |
| `working_dir` | string | - | Yes | The absolute path to the Git repository the Foreman is managing. |

### `llm`
Configuration for the Large Language Model used for decision making, planning, and synthesis.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `backend` | string | `anthropic` | No | The LLM provider. Currently `anthropic` and `openai` are supported. |
| `model` | string | - | Yes | The specific model identifier (e.g., `claude-3-5-sonnet-20241022`). |
| `api_key_env` | string | - | Yes | The name of the environment variable containing the API key (e.g., `ANTHROPIC_API_KEY`). |
| `max_tokens_per_turn` | integer | `8192` | No | Hard limit on tokens generated in a single LLM response. |

### `workers`
A list of available workers (A2A endpoints) that the Foreman can delegate tasks to.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `url` | string | - | Yes | The A2A endpoint URL (e.g., `http://127.0.0.1:7001`). |
| `name_hint` | string | - | No | A hint for the worker's name used in logs before discovery is complete. |

### `mcps`
Configuration for Model Context Protocol (MCP) servers.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `personal` | object[] | `[]` | No | MCP servers used directly by the Foreman (e.g., for querying Jira or Slack). |
| `injected` | object[] | `[]` | No | MCP servers injected into every task sent to a worker (e.g., a shared documentation tool). |

#### MCP server object
| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `name` | string | - | Yes | Unique name for the MCP server. |
| `command` | string | - | Yes | Binary to execute. |
| `args` | string[] | `[]` | No | Arguments for the command. |
| `env` | object | `{}` | No | Environment variables for the MCP subprocess. |
| `read_only_tools` | string[] | `[]` | No | List of tool names to force as read-only (auto-approved). |
| `write_tools` | string[] | `[]` | No | List of tool names to force as write (escalated). |

### `runtime`
Orchestration and safety limits.

| Field | Type | Default | Required | Effect |
| :--- | :--- | :--- | :--- | :--- |
| `max_concurrent_sessions` | integer | `5` | No | Maximum number of simultaneous user sessions (ACP) allowed. |
| `max_parallel_dispatches` | integer | `5` | No | Global limit on simultaneous worker dispatches (A2A). |
| `default_task_timeout_sec` | integer | `1800` | No | Default time limit for tasks sent to workers if not specified in the plan. |
| `worker_discovery_timeout_sec` | integer | `10` | No | Time to wait for a worker's Agent Card during startup. |
| `planner_response_timeout_sec` | integer | `300` | No | Time to wait for the Planner to respond to a worker escalation. |

### `logging`
Same structure as the Proxy's `logging` section.

---

## Detailed configuration guide

### Working with MCPs

Foreman Stack distinguishes between **personal** and **injected** MCPs:

1. **Personal MCPs**: These are tools that the Foreman (or Proxy) uses for its own internal logic. For example, a Foreman might use a Jira MCP to read issue descriptions. These tools are *not* visible to the workers dispatched by the Foreman.
2. **Injected MCPs**: These are tools that the Foreman "loans" to its workers. When a task is dispatched, the Foreman includes the configuration for these MCPs in the task payload. The Proxy then starts these MCP servers and connects them to the worker's ACP session.

**Name collisions**: If a Proxy has a personal MCP named `files` and the Foreman tries to inject an MCP also named `files`, the task will fail with an `mcp_name_collision` error. Ensure unique naming across your stack.

### Permission policies

Permissions are evaluated in layers. When a worker requests a tool call:

1. **Agent Native Layer**: The agent itself (e.g., Claude Code) checks its local settings. If the tool is permitted there, the Proxy never sees the request.
2. **Proxy Layer**: If the agent asks for permission, the Proxy checks its `terminal_whitelist`. For file operations, it checks if the path is within the task's worktree. If it matches a safe pattern, the Proxy auto-approves.
3. **Escalation Layer**: If the request is not auto-approved, it is escalated to the **Plan Owner** (usually the Planner agent). If the Plan Owner can't decide, it finally reaches the **User**.

### Scaling the Proxy

The `runtime` settings in `proxy.yaml` allow you to tune capacity:

- For maximum isolation, set `max_subprocesses` to a high number and `max_sessions_per_subprocess` to `1`. Each task gets its own OS process.
- For maximum efficiency, set `max_subprocesses` to `1` and `max_sessions_per_subprocess` to a higher number. Tasks share a single agent process but have isolated conversation contexts.

---

## Worked examples

### 1. Minimal local development
A single proxy wrapping Claude Code and a Foreman managing a local repo.

**proxy.yaml**
```yaml
proxy:
  name: "coder"
  bind: "127.0.0.1:7001"
wrapped_agent:
  command: "claude"
  args: ["--acp"]
role:
  description: "General purpose TypeScript developer."
worktrees:
  base_dir: "/tmp/foreman-worktrees"
```

**foreman.yaml**
```yaml
foreman:
  name: "my-project"
  working_dir: "/home/user/code/my-project"
llm:
  model: "claude-3-5-sonnet-20241022"
  api_key_env: "ANTHROPIC_API_KEY"
workers:
  - url: "http://127.0.0.1:7001"
```

### 2. Specialized worker pool
A setup with multiple specialized proxies and a planner.

**foreman.yaml**
```yaml
foreman:
  name: "engineering-team"
  working_dir: "/opt/repo"
llm:
  model: "claude-3-5-sonnet-20241022"
  api_key_env: "ANTHROPIC_API_KEY"
workers:
  - url: "http://127.0.0.1:7001" # Coder
  - url: "http://127.0.0.1:7002" # Tester
  - url: "http://127.0.0.1:7003" # Reviewer
  - url: "http://127.0.0.1:7004" # Planner
```

---

## Best practices and tips

### 1. Setting up Claude Code as a worker
To use Claude Code (the `claude` CLI) as a worker, ensure you have logged in on the machine running the proxy.
- **Config**:
  ```yaml
  wrapped_agent:
    command: "claude"
    args: ["--acp"]
  ```
- **Tip**: Claude Code maintains its own state in `~/.claude`. If you run multiple proxies as different users, ensure each has performed `claude login`.

### 2. Managing worktrees effectively
- **Base Directory**: Use a directory like `/tmp/foreman-worktrees` or a dedicated folder in your home directory. Avoid putting it inside a directory that is being watched by other tools (like a heavy IDE indexer) to prevent performance lag.
- **Cleanup**: The default `never` policy is great for debugging but can consume disk space over time. Periodically run `git worktree prune` in your main repository to clean up stale references.

### 3. Tuning capacity
- If your workers are LLM-heavy and wait a lot for API responses, increasing `max_sessions_per_subprocess` is a cost-effective way to increase throughput.
- If your workers perform heavy local computations or have memory leaks, prefer increasing `max_subprocesses` for better isolation.

### 4. Logging for production
In a CI or production environment, set `logging.format` to `json`. This makes it easy to ingest logs into tools like ELK, Datadog, or CloudWatch. For local development, `pretty` is much more readable.

### 5. API key safety
Never hardcode API keys in the YAML files. Always use the `api_key_env` (for Foreman) or `env` (for Proxy) to reference environment variables. This keeps your configuration files safe to commit to version control (if they don't contain other secrets).

### 6. MCP selection
Only inject MCPs that are truly necessary for the task. Each injected MCP adds a small amount of startup overhead and increases the surface area for potential name collisions or failures.

---

## Environment variables reference

| Variable | Description |
| :--- | :--- |
| `ANTHROPIC_API_KEY` | Primary key for Anthropic models. |
| `OPENAI_API_KEY` | Primary key for OpenAI models. |
| `ANTHROPIC_BASE_URL` | Used to override the API endpoint (e.g., for local LLM gateways). |
| `FOREMAN_LOG_LEVEL` | Overrides the `logging.level` in `foreman.yaml`. |
| `PROXY_LOG_LEVEL` | Overrides the `logging.level` in `proxy.yaml`. |
| `DEBUG` | Enable low-level debug logging for specific modules (e.g., `DEBUG=foreman:*`). |
