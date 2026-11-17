
import { execFileSync } from "node:child_process";
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
  if (!existsSync(path)) return { path, paths: [], issues: [{ line: 0, path: MANIFEST_FILE, reason: "manifest がありません" }] };
  return parseManifest(path, readFileSync(path, "utf8"));
}

/** the manifest's text as read from a file or from a commit (`path` only names it) */
export function parseManifest(path: string, text: string): Manifest {
  const paths: string[] = [];
  const issues: ManifestIssue[] = [];
  const lines = text.split("\n");

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

  if (!paths.includes(MANIFEST_FILE)) issues.push({ line: 0, path: MANIFEST_FILE, reason: "manifest 自身の除外が必要です" });
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

export interface OverlayReference { file: string; line: number; ref: string }

/** files that list paths on purpose rather than link to them */
const PATH_LISTS = new Set([".gitignore", ".gitattributes", ".dockerignore", ".ignore"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Public files (outside the overlay) in a tree that name an overlay path. Once the overlay is held
 * back, such a link or command points at nothing on the public side.
 */
export function overlayReferences(repo: string, treeish: string, paths: string[]): OverlayReference[] {
  const refs = paths.filter((p) => p !== MANIFEST_FILE);
  if (!refs.length) return [];
  const alternation = refs.map(escape).join("|");
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-I", "-E", `(^|[^[:alnum:]_.-])(${alternation})`, treeish, "--", "."], { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // git grep exits 1 when nothing matches
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const match = new RegExp(`(?:^|[^A-Za-z0-9_.-])(${alternation})`);
  const found: OverlayReference[] = [];
  for (const row of out.split("\n")) {
    if (!row) continue;
    const rest = row.slice(treeish.length + 1);
    const m = /^(.*?):(\d+):(.*)$/.exec(rest);
    if (!m) continue;
    const [, file, line, text] = m;
    if (isOverlayPath(paths, file) || PATH_LISTS.has(file.split("/").pop() ?? "")) continue;
    const ref = match.exec(text)?.[1];
    if (ref) found.push({ file, line: Number(line), ref });
  }
  return found;
}

export function describeReferences(refs: OverlayReference[], limit = 10): string {
  const shown = refs.slice(0, limit).map((r) => `${r.file}:${r.line} (${r.ref})`).join(", ");
  return refs.length > limit ? `${shown} ほか ${refs.length - limit} 件` : shown;
}
