// intent: DEC-661 — agent → engine は HTTP の 4 口だけ。書けるのは自分の lane の state に限る

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import { readBacklog } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function laneExists(iddId: string): boolean {
  return readBacklog().some((rec) => rec.idd_id === iddId);
}

async function appendJsonl(file: string, record: unknown): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await release();
  }
}

export interface AskedQuestion {
  question_id: string;
  question: string;
  context?: string;
  options: { index: number; label: string; description?: string }[];
}

export async function agentAskQuestions(input: {
  iddId: string;
  batchId: string;
  questions: AskedQuestion[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  if (!input.questions.length) return { ok: false, error: "questions must not be empty" };

  await appendJsonl("pending-questions.jsonl", {
    idd_id: input.iddId,
    batch_id: input.batchId,
    asked_at: nowIso(),
    questions: input.questions,
  });
  await appendLifecycle("question_batch_asked", input.iddId, {
    batch_id: input.batchId,
    question_ids: input.questions.map((q) => q.question_id),
  });
  return { ok: true };
}

// intent: DEC-604 — 本文は intent file 側。event には数だけ残す
export async function agentReady(input: {
  iddId: string;
  plannerSessionId?: string;
  decCount: number;
  invCount: number;
  qaCount: number;
  referenceCount: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  await appendLifecycle("s1_ready", input.iddId, {
    planner_session_id: input.plannerSessionId,
    dec_count: input.decCount,
    inv_count: input.invCount,
    qa_count: input.qaCount,
    reference_count: input.referenceCount,
  });
  return { ok: true };
}

// intent: DEC-601 — 中間進捗は event ではなく file の上書きで持つ (ledger を肥大させない)
export async function agentProgress(input: {
  iddId: string;
  currentStep: string;
  qaStatus: { qa_id: string; status: string; verified_at?: string }[];
  recentActivity: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `executor-progress-${input.iddId}.json`), JSON.stringify({
    idd_id: input.iddId,
    updated_at: nowIso(),
    current_step: input.currentStep,
    qa_status: input.qaStatus,
    recent_activity: input.recentActivity.slice(-10),
  }, null, 2), "utf8");
  return { ok: true };
}

export async function agentResult(input: {
  iddId: string;
  outcome: "success" | "partial" | "failed";
  changedFiles: string[];
  commitCount: number;
  qaVerified: string[];
  qaUnverified: string[];
  sideFindings?: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!laneExists(input.iddId)) return { ok: false, error: `unknown lane: ${input.iddId}` };
  await appendLifecycle("s2_result", input.iddId, {
    outcome: input.outcome,
    changed_files: input.changedFiles,
    commit_count: input.commitCount,
    qa_verified: input.qaVerified,
    qa_unverified: input.qaUnverified,
    side_findings: input.sideFindings ?? [],
  });
  return { ok: true };
}
