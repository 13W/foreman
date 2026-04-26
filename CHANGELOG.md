# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-26

### Added
- ACP↔A2A protocol bridge (`@foreman-stack/proxy`) — wraps any ACP-compatible
  agent and exposes it as an A2A worker with skill-based discovery.
- Foreman orchestrator (`@foreman-stack/foreman`) — multi-session ACP server
  that decomposes user tasks into plans and dispatches subtasks to A2A workers
  in parallel batches.
- Planner agent (`@foreman-stack/planner`) — specialized worker producing
  structured Plan output from high-level goals.
- Per-task git worktree isolation in proxy.
- Plan execution with parallel within-batch dispatch, sequential between
  batches, and sibling-cancel on failure.
- Permission escalation flow (worker → user) with multi-turn A2A message
  exchange.
- Integration test harness with mock Anthropic server fixture.
- Five end-to-end integration test scenarios: smoke, happy-path,
  user-cancellation, failure-propagation, permission-escalation.
- Reference documentation: getting-started tutorial, configuration reference,
  architecture overview, troubleshooting guide.

### Notes
- Stateful plan-owner sessions (multi-turn planner queries during execution)
  are scaffolded via PlannerSession; full wiring planned for v0.2.
- No-planner fallback (multi-option permission when no planner is available)
  scaffolded; full wiring planned for v0.2.

[Unreleased]: https://github.com/13W/foreman/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/13W/foreman/releases/tag/v0.1.0
