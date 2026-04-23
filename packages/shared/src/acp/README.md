# ACP Interfaces

This directory is a **contract layer only** — interfaces, domain types, and re-exported SDK types. No runtime dependency on `@agentclientprotocol/sdk` in shared itself (peer dep only).

## Why split interfaces from implementations?

`@foreman-stack/shared` must stay lightweight. The two ACP roles use different SDK connection classes with no shared implementation, so implementations live in their respective consumer packages.

## Where implementations live

| Interface | Implementation package |
|-----------|------------------------|
| `ACPAgentServer` | `packages/foreman/src/acp/server.ts` |
| `ACPClientManager` | `packages/proxy/src/acp/client.ts` |

`@agentclientprotocol/sdk` is added to `foreman/package.json` (subtask 4.x) and `proxy/package.json` (subtask 3.x), **not** to shared's `dependencies`. It appears only in `peerDependencies` here.

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Domain types (`SubprocessHandle`, `SessionHandle`, `ACPPermissionRequest`, `PromptResult`, `ACPTransport`) + named re-exports of SDK types (`ContentBlock`, `StopReason`, `ToolCallUpdate`, `PermissionOption`) |
| `server.ts` | `interface ACPAgentServer` — implemented in foreman (stdio ACP agent toward editor) |
| `client.ts` | `interface ACPClientManager` — implemented in proxy (ACP client toward wrapped agent subprocess) |
| `errors.ts` | Error hierarchy: `ACPError` base + `SubprocessCrashedError`, `ProtocolViolationError`, `SessionNotFoundError` |
| `index.ts` | Barrel export |

## SDK re-exports

Only stable, protocol-level types are re-exported. Implementer-facing classes (`AgentSideConnection`, `ClientSideConnection`) are not re-exported — they belong in the implementing package.

```typescript
export type { ContentBlock, StopReason, ToolCallUpdate, PermissionOption } from '@agentclientprotocol/sdk';
```

## Notes for implementers

### `ACPClientManager.sendPrompt()`

Returns a `PromptResult` with two fields rather than a single `AsyncIterableIterator` so callers can `await stopReason` independently of consuming `updates`. Implementations should drive the SDK's streaming response into both.

### `ACPClientManager` permission handlers

`onFsRead`, `onFsWrite`, `onTerminalCreate` take precedence over the catch-all `onPermissionRequest`. Proxy registers the specific handlers to apply its layered policy (proxy-spec §6.5) before escalating to A2A.

### `ACPAgentServer.listen()`

Defaults to `'stdio'` transport — the ACP standard for agents started as editor subprocesses. Implementations wrap `AgentSideConnection` from the SDK.
