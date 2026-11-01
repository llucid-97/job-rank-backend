export function isExpiredCodexTestAccount(
  metadata: Record<string, unknown> | null | undefined,
  now = Date.now(),
): boolean {
  if (metadata?.codex_test_account !== true) return false;
  const expiry = Date.parse(String(metadata.codex_test_expires_at ?? ""));
  return !Number.isFinite(expiry) || expiry <= now;
}
