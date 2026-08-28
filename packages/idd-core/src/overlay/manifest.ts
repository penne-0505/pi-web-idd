
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE = "overlay.manifest";

export interface ManifestIssue {
  line: number;
  path: string;
  reason: string;
}

export interface Manifest {
  path: string;
  paths: string[];
  issues: ManifestIssue[];
}

function normalize(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("./")) value = value.slice(2);
  const isDir = value.endsWith("/");
  while (value.endsWith("/")) value = value.slice(0, -1);
  return isDir ? `${value}/` : value;
}

export function readManifest(repoRoot: string): Manifest {
  const path = join(repoRoot, MANIFEST_FILE);
  if (!existsSync(path)) return { path, paths: [], issues: [] };

  const paths: string[] = [];
  const issues: ManifestIssue[] = [];
  const lines = readFileSync(path, "utf8").split("\n");

  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const entry = normalize(trimmed);

    if (entry.startsWith("/") || entry.includes("..")) {
      issues.push({ line, path: entry, reason: "repo 相対のパスだけを書く" });
      return;
    }
    if (paths.includes(entry)) {
      issues.push({ line, path: entry, reason: "重複" });
      return;
    }
    const covering = paths.find((p) => p.endsWith("/") && entry.startsWith(p));
    if (covering) {
      issues.push({ line, path: entry, reason: `${covering} に含まれる` });
      return;
    }
    paths.push(entry);
  });

  return { path, paths, issues };
}

export function isOverlayPath(paths: string[], file: string): boolean {
  const target = normalize(file);
  return paths.some((p) => (p.endsWith("/") ? target.startsWith(p) : target === p));
}

export function splitByManifest(paths: string[], files: string[]): { keep: string[]; overlay: string[] } {
  const keep: string[] = [];
  const overlay: string[] = [];
  for (const file of files) (isOverlayPath(paths, file) ? overlay : keep).push(file);
  return { keep, overlay };
}
