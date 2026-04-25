# @foreman-stack/planner

The planner package implements the decomposition strategy for the Foreman system. It takes high-level user goals and breaks them down into structured plans consisting of sequential batches of parallel subtasks.

## Features

- **Anthropic Strategy**: Uses Claude 3.5 Sonnet to perform task decomposition and handle escalations.
- **Structured Output**: Enforces valid JSON plans using Anthropic tool use.
- **Validation Retries**: Automatically retries decomposition if the model produces an invalid plan, feeding the validation error back to the model.
- **Escalation Handling**: Maintains session history to answer follow-up questions from worker agents during plan execution.

## Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Configure the planner:
   Create `~/.foreman/planner.yaml` (or specify a custom path with `--config`):
   ```yaml
   planner:
     name: "foreman-planner"
   llm:
     model: "claude-3-5-sonnet-20240620"
     api_key_env: "ANTHROPIC_API_KEY"
     max_validation_retries: 2
   ```

3. Set your API key:
   ```bash
   export ANTHROPIC_API_KEY=your_key_here
   ```

4. Build the package:
   ```bash
   pnpm build
   ```

5. Run the planner:
   ```bash
   node dist/cli.js
   ```

## Integration with Foreman

The planner is typically wrapped by `foreman-proxy` to be exposed as a worker agent with the `task_decomposition` skill. See `examples/planner-proxy.yaml` for a proxy configuration example.
