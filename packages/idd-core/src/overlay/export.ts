import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { readAreas } from "../config/areas.ts";
import { readBacklog, readSessions } from "../ledger/read.ts";
import { laneBase } from "../plan/review.ts";
import { stateDir } from "../paths.ts";
import { readManifest, splitByManifest } from "./manifest.ts";

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
}

function tryRun(cmd: string, args: string[], cwd: string): string | null {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

export interface ProposeView {
  iddId: string;
  branch: string;
  base: string;
  work: string;
  upstream: string;
  publish: string[];
  held: string[];
  commits: string[];
  issues: string[];
  token: string;
  expiresAt: string;
}

function tokenPath(iddId: string): string {
  return join(stateDir(), "propose", `${iddId}.json`);
}

export function laneLocations(iddId: string): { work: string; upstream: string; branch: string } | null {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  const cfg = readAreas().areas[rec.area];
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop()
    ?? readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  if (!cfg?.local_path || !cfg.upstream_path || !session?.worktree_path) return null;
  return { work: session.worktree_path, upstream: cfg.upstream_path, branch: session.branch };
}

export function propose(iddId: string): ProposeView | { error: string } {
  const loc = laneLocations(iddId);
  if (!loc) return { error: `lane の置き場所が引けません: ${iddId}` };
  if (!existsSync(loc.upstream)) return { error: `upstream clone がありません: ${loc.upstream}` };

  const base = laneBase(loc.work);
  if (!base) return { error: "分岐点が取れません" };

  const changed = (tryRun("git", ["diff", "--name-only", base], loc.work) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const manifest = readManifest(loc.work);
  const { keep, overlay } = splitByManifest(manifest.paths, changed);
  const commits = (tryRun("git", ["log", "--reverse", "--format=%s", `${base}..HEAD`], loc.work) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);

  const issues: string[] = manifest.issues.map((i) => `manifest ${i.line} 行: ${i.path} — ${i.reason}`);
  if (!keep.length) issues.push("出力面に出る変更がありません");
  const dirty = tryRun("git", ["status", "--porcelain"], loc.work);
  if (dirty === null || dirty.trim() !== "") issues.push("work 側に未 commit の変更があります");

  const token = randomBytes(12).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const view: ProposeView = {
    iddId,
    branch: loc.branch,
    base,
    work: loc.work,
    upstream: loc.upstream,
    publish: keep,
    held: overlay,
    commits,
    issues,
    token,
    expiresAt,
  };

  const dir = join(stateDir(), "propose");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(iddId), JSON.stringify({
    idd_id: iddId,
    token,
    expires_at: expiresAt,
    base,
    branch: loc.branch,
    publish: keep,
    held: overlay,
  }, null, 2), "utf8");

  return view;
}

export interface ExportResult {
  ok: boolean;
  branch?: string;
  files?: number;
  error?: string;
}

export function exportLane(iddId: string, token: string, message?: string): ExportResult {
  const path = tokenPath(iddId);
  if (!existsSync(path)) return { ok: false, error: "propose がありません。先に一覧を確認してください" };
  const saved = JSON.parse(readFileSync(path, "utf8")) as {
    token: string; expires_at: string; base: string; branch: string; publish: string[];
  };
  if (saved.token !== token) return { ok: false, error: "承認 token が一致しません" };
  if (new Date(saved.expires_at).getTime() < Date.now()) return { ok: false, error: "承認 token の期限が切れています" };
  if (!saved.publish.length) return { ok: false, error: "出力面に出る変更がありません" };

  const loc = laneLocations(iddId);
  if (!loc) return { ok: false, error: "lane の置き場所が引けません" };

  const patch = tryRun("git", ["diff", "--binary", `${saved.base}...HEAD`, "--", ...saved.publish], loc.work);
  if (patch === null) return { ok: false, error: "patch を作れません" };

  const upstream = loc.upstream;
  if (tryRun("git", ["fetch", "origin"], upstream) === null) return { ok: false, error: "upstream の fetch に失敗" };
  if (tryRun("git", ["checkout", "-B", saved.branch, "origin/main"], upstream) === null) {
    return { ok: false, error: "upstream で branch を作れません" };
  }

  const patchFile = join(stateDir(), "propose", `${iddId}.patch`);
  writeFileSync(patchFile, patch, "utf8");
  if (tryRun("git", ["apply", "--index", patchFile], upstream) === null) {
    return { ok: false, error: "patch の適用に失敗しました" };
  }

  const leaked = (tryRun("git", ["diff", "--cached", "--name-only"], upstream) ?? "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  const manifest = readManifest(loc.work);
  const { overlay } = splitByManifest(manifest.paths, leaked);
  if (overlay.length) {
    tryRun("git", ["reset", "--hard"], upstream);
    return { ok: false, error: `overlay が混入しました: ${overlay.join(", ")}` };
  }

  const subject = message?.trim() || `${saved.publish.length} files from ${iddId}`;
  if (tryRun("git", ["commit", "-m", subject], upstream) === null) {
    return { ok: false, error: "upstream で commit できません" };
  }
  if (tryRun("git", ["push", "-u", "origin", `${saved.branch}:${saved.branch}`], upstream) === null) {
    return { ok: false, error: "upstream からの push に失敗しました" };
  }

  return { ok: true, branch: saved.branch, files: saved.publish.length };
}
