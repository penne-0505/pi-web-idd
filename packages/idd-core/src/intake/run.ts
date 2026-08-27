// intent: DEC-655 — S0 は「拾って backlog に入れる」までで、判断はしない
// intent: DEC-656 — 重複判定は URL 一致 (機械) だけを engine に持ち、意味判定は差し替え可能な口にする

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { githubAreas } from "../config/areas.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { readBacklog } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { listIssues, type GithubIssue } from "./github.ts";

export interface IntakeResult {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  added: string[];
  duplicates: { iddId: string; url: string }[];
  failures: { area: string; reason: string }[];
}

// intent: DEC-656 — 意味判定は差し替え可能な口として持ち、実装されるまで働かせない
export interface DuplicateDetector {
  (incoming: GithubIssue, backlog: BacklogRecord[]): Promise<{ existing: BacklogRecord; similarity: number } | null>;
}

function nowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function nextIddId(backlog: BacklogRecord[]): number {
  const max = backlog.reduce((acc, rec) => {
    const m = rec.idd_id.match(/^IDD-(\d+)$/);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return max + 1;
}

async function appendBacklog(rec: BacklogRecord): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "backlog.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
  } finally {
    await release();
  }
}

async function openPendingReview(rec: {
  reviewId: string;
  incoming: { title: string; url: string };
  existing: BacklogRecord;
  similarity: number;
  detectionMethod: "url" | "semantic";
}): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "pending-reviews.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      review_id: rec.reviewId,
      opened_at: nowIso(),
      incoming: rec.incoming,
      existing_idd_id: rec.existing.idd_id,
      existing_title: rec.existing.title,
      similarity: rec.similarity,
      detection_method: rec.detectionMethod,
    })}\n`, "utf8");
  } finally {
    await release();
  }
  await appendLifecycle("pending_review_open", rec.existing.idd_id, {
    review_id: rec.reviewId,
    detection_method: rec.detectionMethod,
  });
}

function urlDuplicate(issue: GithubIssue, backlog: BacklogRecord[]): BacklogRecord | undefined {
  return backlog.find((rec) => rec.gh_issue_url === issue.url || rec.linear_issue_url === issue.url);
}

export async function runIntake(opts: { detector?: DuplicateDetector } = {}): Promise<IntakeResult> {
  const startedAt = nowIso();
  const result: IntakeResult = {
    startedAt, finishedAt: startedAt, scanned: 0, added: [], duplicates: [], failures: [],
  };

  const areas = githubAreas();
  const backlog = readBacklog();
  let seq = nextIddId(backlog);

  for (const area of areas) {
    let issues: GithubIssue[];
    try {
      issues = listIssues(area.repo, area.labels);
    } catch (err) {
      result.failures.push({ area: area.area, reason: (err as Error).message });
      continue;
    }
    result.scanned += issues.length;

    for (const issue of issues) {
      const already = urlDuplicate(issue, backlog);
      if (already) {
        result.duplicates.push({ iddId: already.idd_id, url: issue.url });
        continue;
      }

      const similar = opts.detector ? await opts.detector(issue, backlog) : null;
      if (similar) {
        const reviewId = `REV-${String(seq).padStart(3, "0")}`;
        await openPendingReview({
          reviewId,
          incoming: { title: issue.title, url: issue.url },
          existing: similar.existing,
          similarity: similar.similarity,
          detectionMethod: "semantic",
        });
        result.duplicates.push({ iddId: similar.existing.idd_id, url: issue.url });
        continue;
      }

      const iddId = `IDD-${String(seq).padStart(3, "0")}`;
      seq += 1;
      const rec: BacklogRecord = {
        idd_id: iddId,
        parent_id: null,
        created_at: nowIso(),
        linear_issue_url: null,
        gh_issue_url: issue.url,
        pull_req_url: null,
        source_type: "github",
        context: issue.body.slice(0, 2000),
        title: issue.title,
        area: area.area,
      };
      await appendBacklog(rec);
      backlog.push(rec);
      await appendLifecycle("lane_open", iddId, {
        source_type: "github",
        area: area.area,
        gh_issue_url: issue.url,
      });
      result.added.push(iddId);
    }
  }

  result.finishedAt = nowIso();
  await writeCronRun(result);
  return result;
}

// intent: DEC-655 — 取り込みの結果は 1 実行 1 file。UI の banner はこれを読む
async function writeCronRun(result: IntakeResult): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = result.startedAt.replace(/[:+]/g, "-");
  writeFileSync(join(dir, `cron-run-${stamp}.json`), JSON.stringify({
    cron_run_id: result.startedAt,
    started_at: result.startedAt,
    completed_at: result.finishedAt,
    intake_count: result.added.length,
    duplicate_count: result.duplicates.length,
    new_lane_count: result.added.length,
    failures: result.failures.map((f) => ({ idd_id: f.area, reason: f.reason })),
  }, null, 2), "utf8");
}
