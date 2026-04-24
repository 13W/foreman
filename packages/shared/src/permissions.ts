export type PermissionDecision =
  | { kind: 'allow_once' }
  | { kind: 'allow_always' }
  | { kind: 'reject_once' }
  | { kind: 'reject_always' }
  | { kind: 'cancelled' }; // reserved for session/cancel propagation only

// Domain-agnostic name for the three ACP permission categories.
// Defined here (not in acp/types.ts) to break the a2a↔acp circular import.
export type PermissionRequestType = 'fs.read' | 'fs.write' | 'terminal.create';
