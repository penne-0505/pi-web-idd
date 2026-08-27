import { normalize, parse, sep } from "path";

// intent: DEC-130 — native/slash の 2 form を意図的に区別し、比較は samePath 系に集約して separator style と Windows case の隠れバグを避ける

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

// intent: DEC-128 — git の POSIX 形式 path 出力を Node の native と比較可能にする、branch 名など非 path 文字列には渡さない

export function toNativePath(p: string): string {
  if (!p || process.platform !== "win32") return p;
  return normalize(p);
}

export function toSlashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForComparison(p: string): string {
  const normalized = normalize(toNativePath(p));
  const rootLength = parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === sep) end--;
  return normalized.slice(0, end);
}

// intent: DEC-130 — separator style と Windows の case-insensitive を吸収する lexical 比較、symlink 解決は呼び出し側の責務

export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (process.platform === "win32") {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}
