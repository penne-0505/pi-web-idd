// intent: handoff の state file (backlog / lifecycle / pending-* / executor-progress / cron-run) を
// 読んで UI の view model に畳む。DEC / QA は event ではなく intent の file から parse する
// (open-questions #16 の B 案: event には数だけ、中身は file 側)。
//
// state file が無い環境では source: "empty" を返す。UI 側は mock に落として動き続ける。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  CriterionState, InboxItem, LaneDetailView, LaneGroup, LaneRow, LaneSection, SourceRef, StateFact,
} from "../types";

/* ── 置き場所 ─────────────────────────────────────────────── */

export function stateDir(): string {
  return process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state");
}

export function intentRoot(): string {
  return process.env.IDD_INTENT_DIR?.trim() || join(process.cwd(), "_docs", "intent");
}

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

/* ── 生 record ────────────────────────────────────────────── */

interface BacklogRecord {
  idd_id: string;
  parent_id: string | null;
  created_at: string;
  linear_issue_url: string | null;
  gh_issue_url: string | null;
  pull_req_url: string | null;
  source_type: "linear" | "github";
  context: string;
  title: string;
  area: string;
  priority_snapshot?: Record<string, unknown>;
}

interface LifecycleRecord {
  event: string;
  idd_id: string;
  at: string;
  attrs?: Record<string, unknown>;
}

interface PendingReview {
  review_id: string;
  detected_at: string;
  candidate: { source_type: string; linear_issue_url?: string; gh_issue_url?: string; title: string; context: string; area: string };
  suspected_duplicate_of: string[];
  detection_method: "url" | "semantic";
  detection_reason: string;
}

interface PendingQuestionBatch {
  idd_id: string;
  batch_id: string;
  asked_at: string;
  questions: { question_id: string; question: string; context: string; options: { index: number; label: string; description?: string }[] }[];
}

interface PendingAnswer {
  idd_id: string;
  batch_id: string;
  question_id: string;
}

interface ExecutorProgress {
  idd_id: string;
  updated_at: string;
  current_step: string;
  qa_status: { qa_id: string; status: string }[];
  recent_activity: string[];
}

interface CronRunRecord {
  cron_run_id: string;
  started_at: string;
  completed_at: string;
  intake_count: number;
  duplicates_detected: number;
  backlog_added_ids: string[];
  s1_failed_ids: string[];
  failure_details: { idd_id?: string; reason?: string }[];
}

/* ── 読み取り ─────────────────────────────────────────────── */

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
  // 全問揃った batch は resume 済みなので出さない
  return batches.filter((b) => b.questions.some((q) => !answered.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`)));
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

/* ── 派生 ─────────────────────────────────────────────────── */

/** events.md の対応表。最新 event から現在の状態を決める。 */
export function deriveStage(events: LifecycleRecord[]): {
  group: LaneGroup;
  stageDone: number;
  stageCurrent: number | null;
  blockedBy?: string;
  decision?: LaneRow["decision"];
} {
  const names = events.map((e) => e.event);
  const last = names[names.length - 1] ?? "";
  const has = (n: string) => names.includes(n);
  const lastOf = (n: string) => [...events].reverse().find((e) => e.event === n);

  if (has("lane_close")) return { group: "closed", stageDone: 5, stageCurrent: null };
  if (has("s1_defer") || has("s3_defer")) return { group: "closed", stageDone: 2, stageCurrent: null };
  if (has("s4_merged")) return { group: "closed", stageDone: 5, stageCurrent: null };
  if (last === "blocked_by_dependency") {
    const dep = lastOf("blocked_by_dependency")?.attrs?.depends_on;
    return { group: "waiting", stageDone: 2, stageCurrent: 2, blockedBy: Array.isArray(dep) ? String(dep[0]) : undefined };
  }
  if (has("s4_submit_started")) {
    if (has("s4_verify_user_judgment_requested") && !has("s4_verify_clean")) {
      return { group: "judge", stageDone: 4, stageCurrent: 4, decision: "ship" };
    }
    return { group: "impl", stageDone: 4, stageCurrent: 4 };
  }
  if (has("s3_ready")) {
    if (!has("s3_ok")) return { group: "judge", stageDone: 3, stageCurrent: 3, decision: "review" };
    return { group: "impl", stageDone: 4, stageCurrent: 4 };
  }
  if (has("s2_start")) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  if (has("s1_go")) return { group: "impl", stageDone: 2, stageCurrent: 2 };
  if (has("s1_ready")) return { group: "judge", stageDone: 2, stageCurrent: null, decision: "go" };
  if (has("question_batch_asked")) return { group: "judge", stageDone: 1, stageCurrent: 1, decision: "question" };
  if (has("lane_open")) return { group: "prep", stageDone: 1, stageCurrent: 1 };
  return { group: "prep", stageDone: 0, stageCurrent: 0 };
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

/** `3h` `12m` `昨日` に整形する。 */
export function elapsedLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "昨日" : `${d}d`;
}

/* ── intent の parse ──────────────────────────────────────── */

const HEADING = /^#{2,3}\s*((?:DEC|QA|INV)-[\w.]+)\s*[—–:-]?\s*(.+?)\s*$/;

/** `## DEC-1 — <一文>` のような見出しを拾う。書式が崩れていたら空で返す。 */
export function parseIntent(area: string, slug: string): {
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  invariants: { id: string; text: string }[];
  references: { path: string; why: string }[];
} {
  const dir = join(intentRoot(), area, slug);
  const pick = (file: string) => {
    const p = join(dir, file);
    if (!existsSync(p)) return [] as { id: string; text: string }[];
    return readFileSync(p, "utf8").split("\n").flatMap((line) => {
      const m = line.match(HEADING);
      return m ? [{ id: m[1], text: m[2] }] : [];
    });
  };
  const refs = (() => {
    const p = join(dir, "reference.md");
    if (!existsSync(p)) return [] as { path: string; why: string }[];
    return readFileSync(p, "utf8").split("\n").flatMap((line) => {
      const m = line.match(/^-\s*`([^`]+)`\s*[—–:-]?\s*(.*)$/);
      return m ? [{ path: m[1], why: m[2] }] : [];
    });
  })();
  return { decisions: pick("decision.md"), criteria: pick("qa.md"), invariants: pick("invariant.md"), references: refs };
}

function slugOf(rec: BacklogRecord): string {
  return basename(rec.title).toLowerCase().replace(/\s+/g, "-").slice(0, 40);
}

/* ── 組み立て ─────────────────────────────────────────────── */

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
    };
  });

  // 重複確認は backlog に入る前なので lane にはならない。Inbox にだけ出す
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

  for (const b of readOpenQuestions()) {
    const rec = backlog.find((x) => x.idd_id === b.idd_id);
    const q = b.questions[0];
    if (!q) continue;
    const facts: StateFact[] = q.context
      ? [{ label: "context", value: q.context.slice(0, 120) }]
      : [];
    items.push({
      kind: "question",
      iddId: b.idd_id,
      laneTitle: rec?.title,
      source: rec ? sourceOf(rec) : undefined,
      batchId: b.batch_id,
      askedIndex: 1,
      askedTotal: b.questions.length,
      question: q.question,
      facts,
      options: q.options.map((o) => ({ index: o.index, label: o.label })),
    });
  }

  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    if (d.decision === "go") {
      const intent = parseIntent(rec.area, slugOf(rec));
      items.push({
        kind: "go",
        iddId: rec.idd_id,
        title: rec.title,
        source: sourceOf(rec),
        decisions: intent.decisions,
        criteria: intent.criteria,
      });
    }
    if (d.decision === "review") {
      const intent = parseIntent(rec.area, slugOf(rec));
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
  const intent = parseIntent(rec.area, slugOf(rec));
  const progress = readProgress(iddId);

  const criteria = intent.criteria.map((c) => {
    const st = progress?.qa_status.find((q) => q.qa_id === c.id)?.status;
    const state: CriterionState = st === "verified" ? "done" : st === "in_progress" ? "doing" : "todo";
    return { ...c, state };
  });

  return {
    iddId,
    title: rec.title,
    group: d.group,
    phaseLabel: d.group === "impl" ? "実装中" : d.decision === "go" ? "GO 待ち" : d.group === "waiting" ? "待機中" : "下調べ中",
    source: sourceOf(rec),
    branch: `idd/${iddId}`,
    area: rec.area,
    since: elapsedLabel(evs[evs.length - 1]?.at ?? rec.created_at) + " 前",
    contract: {
      decisions: intent.decisions,
      criteria,
      invariants: d.decision === "go" ? intent.invariants : undefined,
    },
    work: progress
      ? {
        files: [],
        stream: progress.recent_activity.map((a) => ({ time: progress.updated_at.slice(11, 16), kind: "…", body: a })),
      }
      : undefined,
    references: d.decision === "go" ? intent.references : undefined,
    timeline: evs.slice(-8).map((e) => ({
      time: e.at.slice(11, 16),
      title: e.event,
      detail: JSON.stringify(e.attrs ?? {}).slice(0, 60),
      kind: e.event === "s1_go" || e.event === "s3_ok" || e.event === "question_batch_answered" ? "user" as const
        : e.event.includes("fail") || e.event.includes("fallback") || e.event.includes("blocked") ? "warn" as const
          : "agent" as const,
    })),
    agents: [],
    pending: d.decision,
  };
}
