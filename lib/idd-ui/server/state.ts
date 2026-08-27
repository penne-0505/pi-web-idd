// intent: DEC-601 — engine が読んだ state を UI の view model へ畳む層 (import の向きは UI → engine)
// intent: DEC-650 — ledger の読み書き・stage 判定・intent parse は @idd/core が持つ

import {
  areaSegment, changedFiles, deriveStage, laneActivity, elapsedLabel, parseIntent, readBacklog, readLatestCronRun,
  readAnswers, readLifecycle, readOpenQuestions, readPendingReviews, readProgress, readSessions, slugOf,
} from "@idd/core";
import type { BacklogRecord, LaneGroup, LifecycleRecord } from "@idd/core";
import { stateDir } from "@idd/core";
import { existsSync } from "node:fs";
import type {
  CriterionState, InboxItem, LaneDetailView, LaneRow, LaneSection, SourceRef, StateFact,
} from "../types";
import { buildTimeline } from "./events-display";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

// intent: DEC-683 — 生きている session は runtime しか知らない。engine には集合として渡す
function liveSessions(): Set<string> {
  try {
    return new Set(getRunningRpcSessionIds());
  } catch {
    return new Set();
  }
}

// intent: DEC-681 — lane の成果物は worktree にあるので、その root を intent の探索に渡す
function laneRoot(iddId: string): string | undefined {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  if (executor?.worktree_path) return executor.worktree_path;
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  return planner?.worktree_path;
}

function sourceOf(rec: BacklogRecord): SourceRef | undefined {
  if (rec.linear_issue_url) {
    const id = rec.linear_issue_url.split("/").filter(Boolean).pop() ?? "linear";
    return { kind: "linear", label: id.toUpperCase(), url: rec.linear_issue_url };
  }
  if (rec.gh_issue_url) {
    const m = rec.gh_issue_url.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/);
    return { kind: "github", label: m ? `${m[1]}#${m[2]}` : "github", url: rec.gh_issue_url };
  }
  return undefined;
}


export interface IddState {
  source: "state" | "empty";
  stateDir: string;
  cron: { startedAt: string; finishedAt: string; failures: { iddId: string; reason: string }[] } | null;
  sections: LaneSection[];
  lanes: LaneRow[];
  items: InboxItem[];
}

export function buildState(): IddState {
  const dir = stateDir();
  const backlog = readBacklog();
  if (!existsSync(dir) || backlog.length === 0) {
    return { source: "empty", stateDir: dir, cron: null, sections: [], lanes: [], items: [] };
  }

  const events = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }

  const live = liveSessions();
  const lanes: LaneRow[] = backlog.map((rec) => {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    const lastAt = evs[evs.length - 1]?.at ?? rec.created_at;
    return {
      iddId: rec.idd_id,
      title: rec.title,
      group: d.group,
      decision: d.decision,
      stageDone: d.stageDone,
      stageCurrent: d.stageCurrent,
      elapsed: elapsedLabel(lastAt),
      source: sourceOf(rec),
      blockedBy: d.blockedBy,
      faded: d.group === "closed",
      activity: laneActivity(rec.idd_id, d.group, live),
    };
  });

  // intent: DEC-651 — 重複確認は lane 化の前なので lane 一覧には出さず Inbox にだけ出す
  const answeredReviews = new Set(
    events.filter((e) => e.event === "pending_review_resolved").map((e) => String(e.attrs?.review_id ?? "")),
  );
  const reviews = readPendingReviews().filter((r) => !answeredReviews.has(r.review_id));

  const items: InboxItem[] = [];

  for (const r of reviews) {
    items.push({
      kind: "duplicate",
      iddId: r.review_id,
      reviewId: r.review_id,
      incoming: {
        title: r.candidate.title,
        ref: r.candidate.linear_issue_url
          ? { kind: "linear", label: (r.candidate.linear_issue_url.split("/").pop() ?? "").toUpperCase(), url: r.candidate.linear_issue_url }
          : { kind: "github", label: "github", url: r.candidate.gh_issue_url },
      },
      existing: {
        title: backlog.find((b) => b.idd_id === r.suspected_duplicate_of[0])?.title ?? r.suspected_duplicate_of[0],
        ref: { kind: "lane", label: r.suspected_duplicate_of[0] },
      },
      similarity: r.detection_method === "url" ? 1 : 0.85,
      reason: r.detection_reason,
    });
  }

  const answeredIds = new Set(readAnswers().map((a) => `${a.idd_id}/${a.batch_id}/${a.question_id}`));
  for (const b of readOpenQuestions()) {
    const rec = backlog.find((x) => x.idd_id === b.idd_id);
    const open = b.questions
      .filter((q) => !answeredIds.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`))
      .map((q) => ({
        questionId: q.question_id,
        question: q.question,
        facts: q.context ? [{ label: "context", value: q.context }] : [],
        options: q.options.map((o) => ({ index: o.index, label: o.label })),
      }));
    if (!open.length) continue;
    items.push({
      kind: "question",
      iddId: b.idd_id,
      laneTitle: rec?.title,
      source: rec ? sourceOf(rec) : undefined,
      batchId: b.batch_id,
      open,
      askedTotal: b.questions.length,
      answeredCount: b.questions.length - open.length,
    });
  }



  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    if (d.decision === "go") {
      const intent = parseIntent(rec.area, slugOf(rec), { root: laneRoot(rec.idd_id) });
      items.push({
        kind: "go",
        iddId: rec.idd_id,
        title: rec.title,
        source: sourceOf(rec),
        decisions: intent.decisions,
        criteria: intent.criteria,
        intentPath: intent.decisions.length || intent.criteria.length
          ? undefined
          : `_docs/intent/${areaSegment(rec.area)}/${slugOf(rec)}/`,
      });
    }
    if (d.decision === "review") {
      const intent = parseIntent(rec.area, slugOf(rec), { root: laneRoot(rec.idd_id) });
      const progress = readProgress(rec.idd_id);
      items.push({
        kind: "review",
        iddId: rec.idd_id,
        target: { title: rec.title, ref: sourceOf(rec) ?? { kind: "lane", label: rec.idd_id } },
        criteria: intent.criteria.map((c) => ({
          ...c,
          state: (progress?.qa_status.find((q) => q.qa_id === c.id)?.status === "verified" ? "done" : "todo") as CriterionState,
        })),
      });
    }
  }

  const count = (g: LaneGroup) => lanes.filter((l) => l.group === g).length;
  const sections: LaneSection[] = [
    { group: "judge", label: "判断待ち", count: count("judge") },
    { group: "prep", label: "下調べ中", count: count("prep"), cap: Number(process.env.IDD_PLANNER_CONCURRENCY ?? 5) },
    { group: "impl", label: "実装中", count: count("impl"), cap: Number(process.env.IDD_EXECUTOR_CONCURRENCY ?? 3) },
    { group: "waiting", label: "待機中", count: count("waiting") },
    { group: "closed", label: "終端 (直近)", count: count("closed"), collapsed: true },
  ];

  const run = readLatestCronRun();
  return {
    source: "state",
    stateDir: dir,
    cron: run
      ? {
        startedAt: run.started_at.slice(11, 16),
        finishedAt: run.completed_at.slice(11, 16),
        failures: (run.failure_details ?? []).map((f) => ({ iddId: String(f.idd_id ?? ""), reason: String(f.reason ?? "") })),
      }
      : null,
    sections,
    lanes,
    items,
  };
}

export function buildLaneDetail(iddId: string): LaneDetailView | null {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return null;
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const d = deriveStage(evs);
  const intent = parseIntent(rec.area, slugOf(rec), { root: laneRoot(rec.idd_id) });
  const progress = readProgress(iddId);

  const criteria = intent.criteria.map((c) => {
    const st = progress?.qa_status.find((q) => q.qa_id === c.id)?.status;
    const state: CriterionState = st === "verified" ? "done" : st === "in_progress" ? "doing" : "todo";
    return { ...c, state };
  });

  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  const startedFrom = evs.find((e) => e.event === "s2_start")?.attrs?.started_from_commit;
  const worktree = executor?.worktree_path ?? planner?.worktree_path;

  const agents: LaneDetailView["agents"] = [];
  if (planner?.planner_session_id) {
    agents.push({
      role: "下調べ",
      sessionId: planner.planner_session_id,
      state: d.group === "prep" ? "稼働中" : "終了",
    });
  }
  if (executor?.executor_session_id) {
    agents.push({
      role: "実装",
      sessionId: executor.executor_session_id,
      state: d.group === "impl" ? "稼働中" : "終了",
    });
  }

  return {
    iddId,
    title: rec.title,
    group: d.group,
    phaseLabel: d.group === "impl" ? "実装中" : d.decision === "go" ? "GO 待ち" : d.group === "waiting" ? "待機中" : "下調べ中",
    source: sourceOf(rec),
    branch: executor?.branch ?? planner?.branch ?? `idd/${iddId}`,
    area: rec.area,
    since: elapsedLabel(evs[evs.length - 1]?.at ?? rec.created_at) + " 前",
    contract: {
      decisions: intent.decisions,
      criteria,
      invariants: d.decision === "go" ? intent.invariants : undefined,
    },
    work: progress
      ? {
        files: worktree ? changedFiles(worktree, typeof startedFrom === "string" ? startedFrom : undefined) : [],
        stream: progress.recent_activity.map((a) => ({ time: progress.updated_at.slice(11, 16), kind: "…", body: a })),
      }
      : undefined,
    references: d.decision === "go" ? intent.references : undefined,
    timeline: buildTimeline(evs),
    agents,
    pending: d.decision,
  };
}
