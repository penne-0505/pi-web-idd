import path from "node:path";

// intent: DEC-250 — 内部識別 key は Windows で case-fold し、platform 注入で非 Windows CI でも同等挙動を検証可能に
export function projectIdentityKey(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!projectRoot) return projectRoot;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(projectRoot);
  const rootLength = pathApi.parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === pathApi.sep) end--;
  const withoutTrailingSeparators = normalized.slice(0, end);
  return platform === "win32"
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}
