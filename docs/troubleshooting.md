# Troubleshooting guide

This document provides solutions and diagnostics for common issues encountered when setting up or running the Foreman Stack.

---

## Worker unreachable during discovery

**Symptoms**:
- Foreman startup logs show one or more workers as `unreachable`.
- Example log: `worker unreachable: http://127.0.0.1:7001`.
- The Foreman is unable to delegate tasks to that specific worker, even if it appears in the worker catalog.

**Cause**:
- **Proxy not running**: The most common cause. The A2A server hosted by the Proxy is not active.
- **Port mismatch**: The port in `proxy.yaml` (`bind`) does not match the port in `foreman.yaml` (`workers[].url`).
- **Loopback binding**: The Proxy is bound to `localhost` but Foreman is trying to reach `127.0.0.1` (or vice versa), and the OS does not resolve them identically.
- **Network firewall**: A local firewall or security software is blocking the port.

**Fix**:
1. Check that the Proxy process is active and hasn't crashed.
2. Verify the configuration:
   - In `proxy.yaml`: `proxy.bind` should be `127.0.0.1:7001`.
   - In `foreman.yaml`: `workers.url` should be `http://127.0.0.1:7001`.
3. Try to manually fetch the Agent Card: `curl -v http://127.0.0.1:7001/.well-known/agent-card.json`.

**Where to look**:
- Foreman logs for "Worker discovery complete" summary.
- Proxy logs for bind errors (e.g., `EADDRINUSE`).

---

## Foreman exits immediately on startup

**Symptoms**:
- Running `foreman` results in an immediate return to the command prompt.
- No logs are produced, or only a short error message is visible.

**Cause**:
- **Config validation failure**: One or more fields in `foreman.yaml` are missing or have invalid types.
- **Environment missing**: A required environment variable (like `ANTHROPIC_API_KEY`) is not set.
- **Invalid YAML**: Syntax error in the configuration file (e.g., tab characters instead of spaces).

**Fix**:
1. Check the console output for a Zod validation error. It will specify exactly which field is problematic.
2. Run `export ANTHROPIC_API_KEY=...` (or use a `.env` file if supported by your launcher).
3. Validate your YAML file with an online validator or `yamllint`.

**Where to look**:
- Stderr output of the Foreman command.

---

## Worker subprocess crashes

**Symptoms**:
- Task fails with error: `subprocess_crash`.
- Proxy logs show the wrapped agent (e.g., Claude Code) exited with a non-zero code.

**Cause**:
- **Command not found**: The `command` in `wrapped_agent` is not in the system's PATH.
- **Agent crash**: The agent itself crashed due to internal errors (OOM, unhandled exception).
- **Missing agent config**: The agent requires its own setup (e.g., `claude login`) that hasn't been performed for the user running the proxy.

**Fix**:
1. Test the command manually: run `claude --acp` in your terminal to see if it starts.
2. Use absolute paths in `wrapped_agent.command` (e.g., `/usr/local/bin/claude`).
3. Check the agent's own logs or console output captured by the Proxy.

**Where to look**:
- Proxy logs, looking for the `subprocess stdout/stderr` channel output.

---

## Permission request timeout

**Symptoms**:
- Task fails with error: `permission_timeout`.
- You see a message in Foreman updates about a pending permission, but then it fails.

**Cause**:
- **Human delay**: You didn't respond to the prompt in your editor within the `permission_timeout_sec` window.
- **Unreachable client**: The ACP client (editor) disconnected or stopped polling for updates.

**Fix**:
1. Ensure your editor/client is active and you are monitoring the "Foreman Updates" channel.
2. Increase the timeout in `proxy.yaml`:
   ```yaml
   permissions:
     permission_timeout_sec: 600 # increase to 10 minutes
   ```

**Where to look**:
- Foreman updates in your editor.
- Proxy logs for `escalation sent` messages.

---

## MCP name collision

**Symptoms**:
- Task fails with error: `mcp_name_collision`.

**Cause**:
- You have a **personal** MCP in your `proxy.yaml` with the same name as an **injected** MCP from the `foreman.yaml`.
- The system cannot determine which tool to prioritize, so it aborts the task for safety.

**Fix**:
1. Rename the MCP in either `proxy.yaml` or `foreman.yaml`.
2. Use prefixes to distinguish them, e.g., `local-github` and `global-github`.

**Where to look**:
- The error message in the task result or Foreman summary.

---

## Base branch not found

**Symptoms**:
- Task fails immediately with `base_branch_not_found`.

**Cause**:
- The Git branch specified as the base for the worktree doesn't exist on your local machine.
- The Proxy does not automatically `git fetch` from remotes.

**Fix**:
1. Run `git fetch --all` in your project directory.
2. Verify that `git branch -a` shows the branch you've configured.
3. Check `worktrees.default_base_branch` in `proxy.yaml`.

**Where to look**:
- Proxy logs or the error returned by the failed task.

---

## Task hung without progress

**Symptoms**:
- A task stays in `working` state for a long time (e.g., > 10 minutes) without any new messages.

**Cause**:
- **Agent loop**: The worker agent is stuck in an internal reasoning loop.
- **Terminal block**: The worker is running a terminal command that is waiting for user input (which it won't get).
- **Event loss**: A network hiccup caused a loss of streaming events.

**Fix**:
1. Enable `debug` logging in `proxy.yaml` to see if the subprocess is still producing any output.
2. If the agent is stuck, use the `session/cancel` feature in your editor.
3. Check the `task_hard_timeout_sec` in `proxy.yaml` to ensure it will eventually be killed.

**Where to look**:
- Proxy logs with `level: debug`.
- System monitor to see if the `claude` or `node` process is consuming high CPU.

---

## Planner validation failed

**Symptoms**:
- Foreman logs: `plan validation failed`.
- No tasks are dispatched.

**Cause**:
- The Planner produced a malformed JSON object that doesn't match the required Schema.
- Hallucination: the Planner referenced a worker name that doesn't exist in the catalog.

**Fix**:
1. Retry the request. Often a second attempt with a fresh context resolves hallucinations.
2. Check the "Available workers" list in your Foreman logs to ensure all your proxies are correctly discovered.

**Where to look**:
- Foreman logs for the raw Planner response.

## Missing transcript

**Symptoms**:
- `session_transcript_ref` points to a non-existent file.

**Cause**:
- The Proxy crashed before it could flush the transcript to disk.
- The `worktrees.base_dir` is on a volume with no space or incorrect permissions.

**Fix**:
1. Ensure the directory specified in `worktrees.base_dir` is writable by the user running the proxy.
2. Check for disk space issues.

**Where to look**:
- Proxy startup logs for filesystem check errors.

---

## Quick diagnostics

When something isn't working, run these commands to gather information:

### 1. Check if the Proxy is listening
```bash
# Replace 7001 with your configured port
netstat -an | grep 7001
# Or using lsof
lsof -i :7001
```

### 2. Manually test a Proxy's Agent Card
```bash
curl -s http://127.0.0.1:7001/.well-known/agent-card.json | jq .
```

### 3. Check for active Git worktrees
```bash
git worktree list
```

### 4. Search for error messages in logs
```bash
# For JSON logs, use jq to find errors
tail -f foreman.log | jq 'select(.level >= 40)'
```

### 5. Verify agent capability
```bash
# Run your wrapped agent directly to see if it supports ACP/stdio
claude --acp
```

### 6. Clean up stalled worktrees
If you have many stale worktrees from failed tasks:
```bash
git worktree prune
# Then delete the directories if they still exist
rm -rf /tmp/foreman-worktrees/*
```
