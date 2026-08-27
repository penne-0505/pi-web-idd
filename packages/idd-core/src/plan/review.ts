// intent: DEC-688 — S3 の機械部分は「upstream と衝突するか」だけを見る。解消の判断は人間か Integrator の側
// intent: DEC-689 — 差分確認に出す diff は実物から作る。要約や再構成をしない

import { execFileSync } from "node:child_process";

import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { readAreas } from "../config/areas.ts";
import type { BacklogRecord } from "../schema/records.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
}

export function lanesAwaitingCheck(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  return readBacklog().filter((rec) => {
    const laneEvents = byLane.get(rec.idd_id) ?? [];
    const names = laneEvents.map((e) => e.event);
    return names.includes("s2_result") && !names.includes("s3_ready");
  });
}

export interface CheckResult {
  iddId: string;
  outcome: "clean" | "conflict" | "skipped";
  conflictFiles: string[];
  reason?: string;
}

// intent: DEC-688 — merge-tree は index も working tree も触らずに衝突の有無だけを答える
function conflictsAgainst(repo: string, base: string, branch: string): string[] | null {
  try {
    git(repo, ["merge-tree", "--write-tree", "--name-only", base, branch]);
    return [];
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? "");
    const files = out.split("\n").map((l) => l.trim()).filter((l) => l && !/^[0-9a-f]{40}$/.test(l));
    return files.length ? files : null;
  }
}

export async function runCheck(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const areas = readAreas().areas;

  for (const rec of lanesAwaitingCheck()) {
    const session = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop();
    const repo = areas[rec.area]?.local_path;
    if (!session || !repo) {
      results.push({ iddId: rec.idd_id, outcome: "skipped", conflictFiles: [], reason: "no session or local_path" });
      continue;
    }

    await appendLifecycle("s3_ready", rec.idd_id, {});
    await appendLifecycle("s3_check_in_progress", rec.idd_id, { check_type: "merge_tree_only" });

    const conflicts = conflictsAgainst(repo, "main", session.branch);
    if (conflicts === null) {
      results.push({ iddId: rec.idd_id, outcome: "skipped", conflictFiles: [], reason: "merge-tree に失敗" });
      continue;
    }
    if (conflicts.length) {
      await appendLifecycle("s3_check_conflict", rec.idd_id, {
        conflict_files: conflicts,
        conflict_type: "vs_upstream",
      });
      results.push({ iddId: rec.idd_id, outcome: "conflict", conflictFiles: conflicts });
    } else {
      await appendLifecycle("s3_check_clean", rec.idd_id, {});
      results.push({ iddId: rec.idd_id, outcome: "clean", conflictFiles: [] });
    }
  }
  return results;
}

// intent: DEC-689 — 差分の基準は「いまの main との分岐点」。起点 commit を固定で使うと rebase 後に他人の変更まで差分に混ざる
export function laneBase(worktree: string, fallback?: string): string | null {
  for (const ref of ["main", "origin/main", "master"]) {
    try {
      const base = git(worktree, ["merge-base", "HEAD", ref]).trim();
      if (base) return base;
    } catch {
      continue;
    }
  }
  return fallback ?? null;
}

export interface LaneDiff {
  file: string;
  fileIndex: number;
  fileTotal: number;
  before: { lineNo?: string; marker?: string; code: string }[];
  after: { lineNo?: string; marker?: string; code: string }[];
}

// intent: DEC-689 — 差分は git から取り、最初の 1 ファイルを 2 pane 分の行に畳む
export function laneDiff(worktree: string, base: string, maxLines = 14): LaneDiff | null {
  let files: string[];
  try {
    files = git(worktree, ["diff", "--name-only", base]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  if (!files.length) return null;

  const file = files[0];
  let patch: string;
  try {
    patch = git(worktree, ["diff", "--unified=3", base, "--", file]);
  } catch {
    return null;
  }

  const before: LaneDiff["before"] = [];
  const after: LaneDiff["after"] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("+")) {
      after.push({ lineNo: String(newNo++), marker: "+", code: line.slice(1) });
    } else if (line.startsWith("-")) {
      before.push({ lineNo: String(oldNo++), marker: "-", code: line.slice(1) });
    } else if (line.startsWith(" ")) {
      before.push({ lineNo: String(oldNo++), code: line.slice(1) });
      after.push({ lineNo: String(newNo++), code: line.slice(1) });
    }
    if (before.length >= maxLines && after.length >= maxLines) break;
  }

  return {
    file,
    fileIndex: 1,
    fileTotal: files.length,
    before: before.slice(0, maxLines),
    after: after.slice(0, maxLines),
  };
}
