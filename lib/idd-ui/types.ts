// intent: DEC-601 — UI が消費するのは ledger の生 record ではなく server 側で fold した view model

export type Stage = "intake" | "prep" | "impl" | "review" | "ship";

export const STAGE_ORDER: Stage[] = ["intake", "prep", "impl", "review", "ship"];

export type LaneGroup = "judge" | "prep" | "impl" | "waiting" | "closed";

export type DecisionKind = "duplicate" | "question" | "go" | "review" | "ship";

export interface SourceRef {
  kind: "linear" | "github" | "pr" | "lane" | "file";
  label: string;
  url?: string;
}

export interface LaneRow {
  iddId: string;
  title: string;
  group: LaneGroup;
  decision?: DecisionKind;
  stageDone: number;
  stageCurrent: number | null;
  elapsed: string;
  source?: SourceRef;
  blockedBy?: string;
  priorityTop?: boolean;
  faded?: boolean;
  // intent: DEC-683 — 進行中の見た目のまま止まっている lane を、動いている lane と区別する
  activity?: "live" | "stalled" | "unstarted";
}

export interface LaneSection {
  group: LaneGroup;
  label: string;
  count: number;
  cap?: number;
  collapsed?: boolean;
}

export interface CronRun {
  startedAt: string;
  finishedAt: string;
  failures: { iddId: string; reason: string }[];
  breakdown?: { intake: number; duplicates: number; newLanes: number };
}

// intent: DEC-665 — total は delivered_at null 全件、failed はそのうち error 付き (配送失敗) の分
export interface UndeliveredCount {
  total: number;
  failed: number;
}
export interface QuestionOption {
  index: number;
  label: string;
}

export interface StateFact {
  label: string;
  value: string;
  ref?: SourceRef;
}

interface InboxBase {
  iddId: string;
  laneTitle?: string;
  source?: SourceRef;
  handoffNote?: string;
}

export interface DuplicateItem extends InboxBase {
  kind: "duplicate";
  reviewId: string;
  incoming: { title: string; ref: SourceRef };
  existing: { title: string; ref: SourceRef; stage?: { done: number; current: number | null } };
  similarity: number;
  reason: string;
  shared?: string[];
}

export interface QuestionEntry {
  questionId: string;
  question: string;
  facts: StateFact[];
  options: QuestionOption[];
}

export interface QuestionItem extends InboxBase {
  kind: "question";
  batchId: string;
  // intent: DEC-677 — batch は 1 card。未回答の問いを順に出し、揃ったときだけ planner が再開する
  open: QuestionEntry[];
  askedTotal: number;
  answeredCount: number;
  primaryRef?: SourceRef;
}

export interface GoItem extends InboxBase {
  kind: "go";
  title: string;
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  priorityTop?: boolean;
  // intent: DEC-674 — 契約が空のとき、どこが空かを示せるように出所を持たせる
  intentPath?: string;
}

export type CriterionState = "done" | "doing" | "todo";

export interface DiffLine {
  marker: "+" | "-" | null;
  code: string;
  lineNo?: string;
}

export interface ReviewItem extends InboxBase {
  kind: "review";
  target: { title: string; ref: SourceRef };
  conflictWith?: { title: string; ref: SourceRef };
  // intent: DEC-703 — 差分は 1 ファイルずつ出す。行き来できるよう一覧も渡す
  diffFiles?: string[];
  diff?: {
    file: string;
    fileIndex: number;
    fileTotal: number;
    before: DiffLine[];
    after: DiffLine[];
  };
  criteria: { id: string; text: string; state: CriterionState }[];
}

export interface ShipItem extends InboxBase {
  kind: "ship";
  title: string;
  branch: { from: string; to: string; repo: string };
  pr: {
    title: string;
    body: { text: string; flagged?: { original: string } }[];
    commits: string[];
  };
  checks: { label: string; ok: boolean }[];
}

export type InboxItem = DuplicateItem | QuestionItem | GoItem | ReviewItem | ShipItem;

export interface TimelineEntry {
  time: string;
  title: string;
  detail?: string;
  kind: "agent" | "user" | "warn" | "mark";
  folded?: number;
  items?: TimelineEntry[];
}

export interface LaneDetailView {
  iddId: string;
  title: string;
  group: LaneGroup;
  phaseLabel: string;
  source?: SourceRef;
  branch: string;
  area: string;
  since: string;
  undelivered: UndeliveredCount;
  priorityTop?: boolean;
  contract: {
    decisions: { id: string; text: string }[];
    criteria: { id: string; text: string; state: CriterionState }[];
    invariants?: { id: string; text: string }[];
  };
  work?: {
    files: { path: string; delta: string }[];
    stream: { time: string; kind: string; body: string; live?: boolean }[];
  };
  references?: { path: string; why: string }[];
  timeline: TimelineEntry[];
  agents: { role: string; sessionId: string; state: string }[];
  pending?: DecisionKind;
}
