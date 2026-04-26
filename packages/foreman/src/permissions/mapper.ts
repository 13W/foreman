import type { PermissionOption } from '@agentclientprotocol/sdk';
import type { PermissionDecision } from '@foreman-stack/shared';

export function mapPermissionOptionToDecision(option: PermissionOption): PermissionDecision {
  switch (option.kind) {
    case 'allow_once':
      return { kind: 'allow_once' };
    case 'allow_always':
      return { kind: 'allow_always' };
    case 'reject_once':
      return { kind: 'reject_once' };
    case 'reject_always':
      return { kind: 'reject_always' };
    default:
      return { kind: 'reject_once' };
  }
}
