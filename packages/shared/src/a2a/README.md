# A2A Interfaces

This directory is a **contract layer only** — interfaces and types, no runtime dependencies on `@a2a-js/sdk`.

## Why split interfaces from implementations?

`@foreman-stack/shared` must stay lightweight so every package that imports shared types does not transitively pull in an HTTP server or A2A SDK runtime. The two A2A roles (server and client) use different sides of the SDK with almost no shared implementation, so splitting them into their respective packages keeps the dependency graph clean.

## Where implementations live

| Interface | Implementation package |
|-----------|------------------------|
| `A2AServer` | `packages/proxy/src/a2a/server.ts` |
| `A2AClient` | `packages/foreman/src/a2a/client.ts` |

`@a2a-js/sdk` is added to `proxy/package.json` (subtask 3.4) and `foreman/package.json` (subtask 4.3), **not** here.

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Domain types: `TaskHandle`, `StreamEvent`, `PermissionRequest`, `InputDecision`, `AgentCardMetadata` |
| `server.ts` | `interface A2AServer` — implemented in proxy |
| `client.ts` | `interface A2AClient` — implemented in foreman |
| `errors.ts` | Error hierarchy: `A2AError` base + `TaskNotFoundError`, `DispatchFailedError`, `PermissionTimeoutError`, `AgentCardValidationError` |
| `index.ts` | Barrel export |

## SDK-specific notes for implementers

### `A2AClient.respondToInput()`
A2A v0.3 has no dedicated "respond to input-required" RPC. Implementations must call `sendMessage` with the same `contextId` as the original task. The `InputDecision` type abstracts this away from callers.

### `A2AServer.requestInput()`
Implementations should emit an `input-required` status event via the SDK's `TaskContext`. The `PermissionRequest` fields map to the message shown to the human operator.

### Streaming
`A2AClient.streamTask()` returns an `AsyncIterableIterator<StreamEvent>` for use with `for await...of`. Implementations should wrap the SDK's SSE stream. `pollTask()` is the fallback for agents without SSE support.
