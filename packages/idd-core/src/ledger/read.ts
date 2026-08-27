// intent: DEC-601 — state file 群を読む層。fold と view 整形は呼ぶ側の責務

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { stateDir } from "../paths.ts";
import type {
  BacklogRecord, CronRunRecord, ExecutorProgress, LifecycleRecord,
  PendingAnswer, PendingQuestionBatch, PendingReview, SessionRecord,
} from "../schema/records.ts";

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l) as T]; } catch { return []; }
    });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
export function readBacklog(): BacklogRecord[] {
  return readJsonl<BacklogRecord>(join(stateDir(), "backlog.jsonl"));
}

export function readLifecycle(): LifecycleRecord[] {
  const dir = stateDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("lifecycle-") && f.endsWith(".jsonl"))
    .flatMap((f) => readJsonl<LifecycleRecord>(join(dir, f)))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function readPendingReviews(): PendingReview[] {
  return readJsonl<PendingReview>(join(stateDir(), "pending-reviews.jsonl"));
}

export function readOpenQuestions(): PendingQuestionBatch[] {
  const batches = readJsonl<PendingQuestionBatch>(join(stateDir(), "pending-questions.jsonl"));
  const answered = new Set(
    readJsonl<PendingAnswer>(join(stateDir(), "pending-answers.jsonl"))
      .map((a) => `${a.idd_id}/${a.batch_id}/${a.question_id}`),
  );
  return batches.filter((b) => b.questions.some((q) => !answered.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`)));
}

export function readSessions(kind: "planner" | "executor"): SessionRecord[] {
  return readJsonl<SessionRecord>(join(stateDir(), `${kind}-sessions.jsonl`));
}

export function readProgress(iddId: string): ExecutorProgress | null {
  return readJson<ExecutorProgress>(join(stateDir(), `executor-progress-${iddId}.json`));
}

export function readLatestCronRun(): CronRunRecord | null {
  const dir = stateDir();
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("cron-run-") && f.endsWith(".json"));
  if (!files.length) return null;
  const newest = files
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return readJson<CronRunRecord>(join(dir, newest.f));
}
