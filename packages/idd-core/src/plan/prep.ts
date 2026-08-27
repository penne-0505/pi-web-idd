// intent: DEC-671 — 下調べに載せる lane の選定は engine、session を起こすのは runtime。並列上限は engine が守る
// intent: DEC-672 — planner への最初の指示も envelope。書式の制約を含めて自己完結させる

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { agentBaseUrl, agentToken } from "../agent/token.ts";
import { getAgentRunner } from "../agent/port.ts";
import { readAreas } from "../config/areas.ts";
import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { areaSegment, slugOf } from "../intent/parse.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { ensureLaneWorktree } from "../worktree/ensure.ts";

export function plannerConcurrency(): number {
  const n = Number(process.env.IDD_PLANNER_CONCURRENCY ?? 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

// intent: DEC-671 — 優先度は未実装なので起票順 (FIFO)。11 段階の ranking は handoff 側で確定してから足す
export function lanesAwaitingPrep(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const started = new Set(readSessions("planner").map((r) => r.idd_id));

  return readBacklog()
    .filter((rec) => {
      if (started.has(rec.idd_id)) return false;
      const laneEvents = byLane.get(rec.idd_id) ?? [];
      const derived = deriveStage(laneEvents);
      return derived.group === "prep" && !derived.decision;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function runningPlanners(): number {
  const started = readSessions("planner");
  const events = readLifecycle();
  return started.filter((rec) => !events.some((e) =>
    e.idd_id === rec.idd_id && (e.event === "s1_ready" || e.event === "s1_defer" || e.event === "lane_close"))).length;
}

async function recordSession(rec: {
  iddId: string;
  sessionId: string;
  worktree: string;
  branch: string;
  model?: string;
}): Promise<void> {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "planner-sessions.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      idd_id: rec.iddId,
      planner_session_id: rec.sessionId,
      started_at: new Date().toISOString(),
      worktree_path: rec.worktree,
      branch: rec.branch,
      model: rec.model,
    })}\n`, "utf8");
  } finally {
    await release();
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plannerBrief(rec: BacklogRecord): string {
  const area = readAreas().areas[rec.area];
  const slug = slugOf(rec);
  const intentDir = `_docs/intent/${areaSegment(rec.area)}/${slug}/`;
  return [
    "<idd-system-message>",
    `  <sent-at>${new Date().toISOString()}</sent-at>`,
    "  <type>s1_prep_start</type>",
    `  <idd-id>${esc(rec.idd_id)}</idd-id>`,
    "  <lane>",
    `    <title>${esc(rec.title)}</title>`,
    `    <area>${esc(rec.area)}</area>`,
    `    <repo>${esc(area?.linked_repo ?? rec.area)}</repo>`,
    `    <source-url>${esc(rec.gh_issue_url ?? rec.linear_issue_url ?? "")}</source-url>`,
    `    <context>${esc(rec.context)}</context>`,
    "  </lane>",
    "  <task>",
    "    この lane の下調べを行う。実装はしない。読むだけで、コードを変更しない。",
    `    成果物は ${intentDir} に 4 つ:`,
    "      decision.md (DEC-n — 一文), invariant.md (INV-n — 一文), qa.md (QA-n — 一文), reference.md",
    "    見出しは `## DEC-1 — <一文>` の形式にすること (UI がこの形式で読む)。",
    "    reference.md は `- `path` — なぜ見たか` の一行形式。",
    "    分からないことがあれば questions で聞く (1 batch 最大 5 問、選択肢は 1-5 個)。",
    "    選択肢の label は 40 文字以内、label 単体で選べる粒度にすること。",
    "    下調べが終わったら ready を呼ぶ。呼ぶまで人間の GO 判定は始まらない。",
    "  </task>",
    "  <callback>",
    `    <base-url>${esc(agentBaseUrl())}</base-url>`,
    `    <token>${esc(agentToken())}</token>`,
    "    <endpoints>",
    `      <questions>POST /api/idd/agent/questions {"idd_id","batch_id","questions":[{"question_id","question","context","options":[{"index","label"}]}]}</questions>`,
    `      <ready>POST /api/idd/agent/ready {"idd_id","planner_session_id","dec_count","inv_count","qa_count","reference_count"}</ready>`,
    "    </endpoints>",
    "    <auth>Authorization: Bearer &lt;token&gt;</auth>",
    "  </callback>",
    "</idd-system-message>",
  ].join("\n");
}

export interface PrepResult {
  started: { iddId: string; sessionId: string; worktree: string }[];
  skipped: { iddId: string; reason: string }[];
  capacity: number;
}

export async function runPrep(): Promise<PrepResult> {
  const runner = getAgentRunner();
  const capacity = Math.max(0, plannerConcurrency() - runningPlanners());
  const result: PrepResult = { started: [], skipped: [], capacity };
  if (!runner?.spawn) {
    for (const rec of lanesAwaitingPrep()) result.skipped.push({ iddId: rec.idd_id, reason: "no runner" });
    return result;
  }

  for (const rec of lanesAwaitingPrep()) {
    if (result.started.length >= capacity) {
      result.skipped.push({ iddId: rec.idd_id, reason: "concurrency cap" });
      continue;
    }
    let worktree;
    try {
      worktree = ensureLaneWorktree(rec.area, rec.idd_id);
    } catch (err) {
      result.skipped.push({ iddId: rec.idd_id, reason: `worktree: ${String(err)}` });
      continue;
    }
    if (!worktree) {
      result.skipped.push({ iddId: rec.idd_id, reason: "area has no local_path" });
      continue;
    }

    try {
      const { sessionId } = await runner.spawn({ role: "planner", cwd: worktree.path });
      await recordSession({
        iddId: rec.idd_id,
        sessionId,
        worktree: worktree.path,
        branch: worktree.branch,
        model: process.env.IDD_PLANNER_MODEL,
      });
      await runner.deliver(sessionId, plannerBrief(rec), { cwd: worktree.path });
      result.started.push({ iddId: rec.idd_id, sessionId, worktree: worktree.path });
    } catch (err) {
      result.skipped.push({ iddId: rec.idd_id, reason: String(err) });
    }
  }
  return result;
}
