// intent: DEC-697 — merge は外部で起きる。engine は観測して記録するだけで、merge 自体は行わない
// intent: DEC-698 — 閉じた lane の worktree は撤去する。ただし未 commit の変更が残っていれば残す

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { readAreas } from "../config/areas.ts";
import { readBacklog, readLifecycle, readProgress, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import type { BacklogRecord } from "../schema/records.ts";

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

export function lanesAwaitingMerge(): { rec: BacklogRecord; prNumber: number; prUrl: string }[] {
  const events = readLifecycle();
  const out: { rec: BacklogRecord; prNumber: number; prUrl: string }[] = [];
  for (const rec of readBacklog()) {
    const laneEvents = events.filter((e) => e.idd_id === rec.idd_id);
    const created = laneEvents.filter((e) => e.event === "s4_pr_created").pop();
    if (!created || laneEvents.some((e) => e.event === "s4_merged")) continue;
    const prNumber = Number(created.attrs?.pr_number);
    const prUrl = String(created.attrs?.pr_url ?? "");
    if (!Number.isFinite(prNumber)) continue;
    out.push({ rec, prNumber, prUrl });
  }
  return out;
}

export interface CloseResult {
  iddId: string;
  outcome: "merged" | "open" | "unknown";
  prUrl?: string;
  worktreeRemoved?: boolean;
  worktreeKept?: string;
}

function durationHours(iddId: string): number | undefined {
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  const open = events.find((e) => e.event === "lane_open")?.at;
  if (!open) return undefined;
  const hours = (Date.now() - new Date(open).getTime()) / 3_600_000;
  return Math.round(hours * 10) / 10;
}

export function removeLaneWorktree(iddId: string): { removed: boolean; kept?: string } {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  const session = readSessions("executor").filter((r) => r.idd_id === iddId).pop()
    ?? readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  const repo = rec ? readAreas().areas[rec.area]?.local_path : undefined;
  const path = session?.worktree_path;
  if (!repo || !path || !existsSync(path)) return { removed: false };

  const dirty = tryRun("git", ["status", "--porcelain"], path);
  if (dirty === null || dirty.trim() !== "") return { removed: false, kept: path };

  const done = tryRun("git", ["worktree", "remove", path], repo);
  return done === null ? { removed: false, kept: path } : { removed: true };
}

export async function runClose(): Promise<CloseResult[]> {
  const results: CloseResult[] = [];

  for (const { rec, prNumber, prUrl } of lanesAwaitingMerge()) {
    const area = readAreas().areas[rec.area];
    const repo = area?.linked_repo;
    if (!repo) {
      results.push({ iddId: rec.idd_id, outcome: "unknown" });
      continue;
    }

    const json = tryRun("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergedAt,mergedBy"]);
    if (!json) {
      results.push({ iddId: rec.idd_id, outcome: "unknown", prUrl });
      continue;
    }
    const pr = JSON.parse(json) as { state: string; mergedAt?: string; mergedBy?: { login?: string } };
    if (pr.state !== "MERGED") {
      results.push({ iddId: rec.idd_id, outcome: "open", prUrl });
      continue;
    }

    await appendLifecycle("s4_merged", rec.idd_id, {
      merged_at: pr.mergedAt,
      merged_by: pr.mergedBy?.login,
    });
    const progress = readProgress(rec.idd_id);
    await appendLifecycle("lane_close", rec.idd_id, {
      outcome: "merged",
      merged_pr_url: prUrl,
      total_duration_hours: durationHours(rec.idd_id),
      final_qa_verified: (progress?.qa_status ?? []).filter((q) => q.status === "verified").map((q) => q.qa_id),
    });

    const wt = removeLaneWorktree(rec.idd_id);
    results.push({
      iddId: rec.idd_id,
      outcome: "merged",
      prUrl,
      worktreeRemoved: wt.removed,
      worktreeKept: wt.kept,
    });
  }
  return results;
}
