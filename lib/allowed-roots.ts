import { toSlashPath } from "./paths";

// intent: DEC-132 — globalThis に置くと Next.js hot-reload をまたいでも追加 root が失われない
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

// intent: DEC-132 — slash に揃えるのは Set key の一貫性のため、containment の正しさは isPathWithinRoots 側で担保

export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}
