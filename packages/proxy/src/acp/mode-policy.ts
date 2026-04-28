// packages/proxy/src/acp/mode-policy.ts

export function isBlockedModeId(modeId: string, blockedPatterns: string[] = ['plan']): boolean {
  const lower = modeId.toLowerCase();
  return blockedPatterns.some((p) => lower.includes(p.toLowerCase()));
}

export function pickFallbackMode(
  availableModes: { id: string; name: string }[],
  blockedPatterns: string[] = ['plan'],
): string | null {
  const candidate = availableModes.find((m) => !isBlockedModeId(m.id, blockedPatterns));
  return candidate?.id ?? null;
}
