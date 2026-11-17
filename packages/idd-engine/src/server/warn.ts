/**
 * Deduplicated warnings for the engine's server modules. The conversation list is polled, so a broken file
 * would repeat the same reason on every call; a scope remembers its last signature and only a changed state
 * warns again. A healthy read clears the scope, so the reason is logged once per run of bad luck.
 */
const lastSignature = new Map<string, string>();

export function warnOnce(scope: string, signature: string, message: string): void {
  if (lastSignature.get(scope) === signature) return;
  lastSignature.set(scope, signature);
  console.warn(message);
}

export function clearWarn(scope: string): void {
  lastSignature.delete(scope);
}
