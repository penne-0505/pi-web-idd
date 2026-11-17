import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../paths.ts";
import type { ReviewEvent, ReviewLaneRecord } from "./state.ts";

export function reviewsDir(): string {
  const dir = join(stateDir(), "reviews");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** where the records are, without making it: a read (the metrics' share of the period) leaves the state as it was */
function reviewsDirIfAny(): string | null {
  const dir = join(stateDir(), "reviews");
  return existsSync(dir) ? dir : null;
}

function nameOf(id: string): string {
  if (!/^REV-[0-9A-Za-z-]+$/.test(id)) throw new Error(`review lane の ID の形ではありません: ${id}`);
  return `${id}.json`;
}

function save(rec: ReviewLaneRecord): ReviewLaneRecord {
  const p = join(reviewsDir(), nameOf(rec.id));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, p);
  return rec;
}

export function readReviewLane(id: string): ReviewLaneRecord | null {
  const dir = reviewsDirIfAny();
  const p = dir ? join(dir, nameOf(id)) : null;
  return p && existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ReviewLaneRecord) : null;
}

export function listReviewLanes(): ReviewLaneRecord[] {
  const dir = reviewsDirIfAny();
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try { return [JSON.parse(readFileSync(join(dir, f), "utf8")) as ReviewLaneRecord]; } catch { return []; }
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function appendReviewEvent(id: string, event: string, attrs: Record<string, unknown> = {}): ReviewLaneRecord {
  const rec = readReviewLane(id);
  if (!rec) throw new Error(`review lane がありません: ${id}`);
  const e: ReviewEvent = { event, at: new Date().toISOString(), attrs };
  rec.history.push(e);
  return save(rec);
}

/** open a review lane for a PR; an open lane for the same PR is returned instead of a second one */
export function openReviewLane(opts: { repo: string; pr: number; title?: string; url?: string }): ReviewLaneRecord {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo) || !Number.isInteger(opts.pr) || opts.pr < 1) throw new Error("repo は owner/name、pr は番号");
  const existing = listReviewLanes().find((r) => r.repo === opts.repo && r.pr === opts.pr && r.history.at(-1)?.event !== "r_closed");
  if (existing) return existing;
  const now = new Date().toISOString();
  const rec: ReviewLaneRecord = {
    id: `REV-${now.replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomBytes(2).toString("hex")}`,
    repo: opts.repo,
    pr: opts.pr,
    title: opts.title ?? `${opts.repo}#${opts.pr}`,
    url: opts.url ?? `https://github.com/${opts.repo}/pull/${opts.pr}`,
    created_at: now,
    history: [{ event: "r_opened", at: now, attrs: {} }],
  };
  return save(rec);
}
