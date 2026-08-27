// intent: DEC-685 — GO の受け皿。契約 (DEC / AC / INV) を渡し、実装させ、結果を ledger に戻す
// intent: DEC-671 — 選定と並列上限は engine、session を起こすのは runtime (S1 と同じ境界)

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { agentBaseUrl, agentToken } from "../agent/token.ts";
import { getAgentRunner } from "../agent/port.ts";
import { readAreas } from "../config/areas.ts";
import { deriveStage } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { areaSegment, parseIntent, slugOf } from "../intent/parse.ts";
import { stateDir } from "../paths.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { ensureLaneWorktree, headCommit } from "../worktree/ensure.ts";

export function executorConcurrency(): number {
  const n = Number(process.env.IDD_EXECUTOR_CONCURRENCY ?? 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function lanesAwaitingExec(): BacklogRecord[] {
  const events = readLifecycle();
  const byLane = new Map<string, typeof events>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const started = new Set(readSessions("executor").map((r) => r.idd_id));

  return readBacklog()
    .filter((rec) => {
      if (started.has(rec.idd_id)) return false;
      const derived = deriveStage(byLane.get(rec.idd_id) ?? []);
      return derived.group === "impl";
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function runningExecutors(): number {
  const events = readLifecycle();
  return readSessions("executor").filter((rec) => !events.some((e) =>
    e.idd_id === rec.idd_id && (e.event === "s2_result" || e.event === "lane_close"))).length;
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
  const path = join(dir, "executor-sessions.jsonl");
  if (!existsSync(path)) writeFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 40 } });
  try {
    appendFileSync(path, `${JSON.stringify({
      idd_id: rec.iddId,
      executor_session_id: rec.sessionId,
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

export function executorBrief(rec: BacklogRecord, worktree: string): string {
  const area = readAreas().areas[rec.area];
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  const intent = parseIntent(rec.area, slug, { root: worktree });
  const list = (rows: { id: string; text: string }[]) =>
    rows.map((r) => `      <item id="${esc(r.id)}">${esc(r.text)}</item>`).join("\n");

  return [
    "<idd-system-message>",
    `  <sent-at>${new Date().toISOString()}</sent-at>`,
    "  <type>s2_start</type>",
    `  <idd-id>${esc(rec.idd_id)}</idd-id>`,
    "  <lane>",
    `    <title>${esc(rec.title)}</title>`,
    `    <repo>${esc(area?.linked_repo ?? rec.area)}</repo>`,
    `    <source-url>${esc(rec.gh_issue_url ?? rec.linear_issue_url ?? "")}</source-url>`,
    "  </lane>",
    "  <contract>",
    `    <intent>_docs/intent/${seg}/${slug}/decision.md</intent>`,
    `    <qa>_docs/qa/${seg}/${slug}/qa.md</qa>`,
    "    <decisions>",
    list(intent.decisions),
    "    </decisions>",
    "    <criteria>",
    list(intent.criteria),
    "    </criteria>",
    intent.invariants.length ? "    <invariants>" : "",
    intent.invariants.length ? list(intent.invariants) : "",
    intent.invariants.length ? "    </invariants>" : "",
    "  </contract>",
    "  <task>",
    "    契約 (DEC) を実装し、条件 (AC) を自分で確かめる。契約に無いことはしない。",
    "    作業はこの worktree の中だけ。他の lane の worktree と main には触れない。",
    "    完了条件: `./scripts/check-docs.sh` と `node_modules/.bin/tsc --noEmit` が通ること。",
    "    変更は commit する (message は `<type>(<scope>): <一文>`、判断の理由は本文へ)。",
    "    契約が誤っている / 足りないと判断したら、実装を進めずに questions で聞く。",
    "  </task>",
    "  <host-rules>",
    "    このホストでは他の lane と IDD の runtime が同時に動いている。",
    "    - 他のプロセスを止めない。`pkill` / `killall` を pattern で使わない (自分を載せている runtime ごと落ちる)。",
    "    - 検証用に server を立てるなら未使用の port を選び、**起動時の PID を控えて、その PID だけ**を止める。",
    "    - 30141 / 30142 の server は IDD の runtime。触らない。",
    "  </task>",
    "  <writing>",
    "    人間向けに書く文章 (commit message、PR 本文、docs) は 1 主張 1 文で書く。",
    "    完全版の作法は `.agents/skills/writing/SKILL.md` を読むこと。",
    "  </writing>",
    "  <callback>",
    `    <base-url>${esc(agentBaseUrl())}</base-url>`,
    `    <token>${esc(agentToken())}</token>`,
    "    <endpoints>",
    `      <progress>POST /api/idd/agent/progress {"idd_id","current_step","qa_status":[{"qa_id","status"}],"recent_activity":[]} — 節目ごとに送る</progress>`,
    `      <result>POST /api/idd/agent/result {"idd_id","outcome":"success|partial|failed","changed_files":[],"commit_count","qa_verified":[],"qa_unverified":[],"side_findings":[]} — 最後に 1 回</result>`,
    `      <questions>POST /api/idd/agent/questions {"idd_id","batch_id","questions":[...]}</questions>`,
    "    </endpoints>",
    "    <auth>Authorization: Bearer &lt;token&gt;</auth>",
    "  </callback>",
    "</idd-system-message>",
  ].filter(Boolean).join("\n");
}

export interface ExecResult {
  started: { iddId: string; sessionId: string; worktree: string }[];
  skipped: { iddId: string; reason: string }[];
  capacity: number;
}

export async function runExec(): Promise<ExecResult> {
  const runner = getAgentRunner();
  const capacity = Math.max(0, executorConcurrency() - runningExecutors());
  const result: ExecResult = { started: [], skipped: [], capacity };
  if (!runner?.spawn) {
    for (const rec of lanesAwaitingExec()) result.skipped.push({ iddId: rec.idd_id, reason: "no runner" });
    return result;
  }

  for (const rec of lanesAwaitingExec()) {
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

    const contract = parseIntent(rec.area, slugOf(rec), { root: worktree.path });
    if (!contract.decisions.length) {
      result.skipped.push({ iddId: rec.idd_id, reason: "contract is empty" });
      continue;
    }

    try {
      const { sessionId } = await runner.spawn({ role: "executor", cwd: worktree.path });
      await recordSession({
        iddId: rec.idd_id,
        sessionId,
        worktree: worktree.path,
        branch: worktree.branch,
        model: process.env.IDD_EXECUTOR_MODEL,
      });
      await appendLifecycle("s2_start", rec.idd_id, {
        executor_session_id: sessionId,
        model: process.env.IDD_EXECUTOR_MODEL,
        started_from_worktree: worktree.path,
        started_from_commit: headCommit(worktree.path),
      });
      await runner.deliver(sessionId, executorBrief(rec, worktree.path), { cwd: worktree.path });
      result.started.push({ iddId: rec.idd_id, sessionId, worktree: worktree.path });
    } catch (err) {
      result.skipped.push({ iddId: rec.idd_id, reason: String(err) });
    }
  }
  return result;
}
