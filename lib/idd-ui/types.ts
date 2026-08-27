// intent: 拡張 IDD の UI が消費する view model。ledger の生 record ではなく、
// server 側で fold / parse した結果をそのまま描ける形にする。
// 対応表は _meta/extended-idd-design/ui-findings.md と Figma 04 を参照。

/** pipeline 上の位置。stage bar の 5 目盛りと 1:1。 */
export type Stage = "intake" | "prep" | "impl" | "review" | "ship";

export const STAGE_ORDER: Stage[] = ["intake", "prep", "impl", "review", "ship"];

/** sidebar の section。UI の並び順そのもの。 */
export type LaneGroup = "judge" | "prep" | "impl" | "waiting" | "closed";

/** 判断の種類。card の phase chip とアイコンを決める。 */
export type DecisionKind = "duplicate" | "question" | "go" | "review" | "ship";

export interface SourceRef {
  kind: "linear" | "github" | "pr" | "lane" | "file";
  /** 表示に使う短い名前 (`APP-1712` / `medo#88` / `PR #465`)。 */
  label: string;
  url?: string;
}

/** sidebar の 1 行。 */
export interface LaneRow {
  iddId: string;
  title: string;
  group: LaneGroup;
  /** 判断待ちのときだけ。行頭のアイコンを決める。 */
  decision?: DecisionKind;
  /** 通過した stage 数 (0-5)。 */
  stageDone: number;
  /** 現在地。止まっている lane では破線で描く。 */
  stageCurrent: number | null;
  /** `3h` `12m` `昨日` など、整形済みの文字列。 */
  elapsed: string;
  source?: SourceRef;
  /** depends_on で待っている相手。空き待ちのときは undefined。 */
  blockedBy?: string;
  priorityTop?: boolean;
  faded?: boolean;
}

/** section 見出し。上限がある section だけ cap を持つ。 */
export interface LaneSection {
  group: LaneGroup;
  label: string;
  count: number;
  cap?: number;
  collapsed?: boolean;
}

/** 朝の取り込みの結果。平常は 1 行、失敗があるときだけ内訳を出す。 */
export interface CronRun {
  startedAt: string;
  finishedAt: string;
  failures: { iddId: string; reason: string }[];
  /** 内訳 (畳んだ状態では出さない)。 */
  breakdown?: { intake: number; duplicates: number; newLanes: number };
}

export interface QuestionOption {
  index: number;
  label: string;
}

/** 現状 (context)。自由文のままか事実の列かは open-questions #18 で未決。 */
export interface StateFact {
  label: string;
  value: string;
  ref?: SourceRef;
}

interface InboxBase {
  iddId: string;
  laneTitle?: string;
  source?: SourceRef;
  /** agent の申し送り (`integrator が判断を委ねた` 等)。 */
  handoffNote?: string;
}

export interface DuplicateItem extends InboxBase {
  kind: "duplicate";
  reviewId: string;
  incoming: { title: string; ref: SourceRef };
  /** すでに動いている側。stage を持つこと自体が「実在している」ことの印になる。 */
  existing: { title: string; ref: SourceRef; stage?: { done: number; current: number | null } };
  /** 0-1。meter の長さ。 */
  similarity: number;
  /** なぜ近いと判断したか。読ませずに済むよう、UI では ⓘ に退避する。 */
  reason: string;
  /** 両者に共通して現れた具体物 (ファイル / 記号)。重なりを「見る」ための材料。 */
  shared?: string[];
}

export interface QuestionItem extends InboxBase {
  kind: "question";
  batchId: string;
  askedIndex: number;
  askedTotal: number;
  question: string;
  facts: StateFact[];
  primaryRef?: SourceRef;
  options: QuestionOption[];
}

export interface GoItem extends InboxBase {
  kind: "go";
  title: string;
  decisions: { id: string; text: string }[];
  criteria: { id: string; text: string }[];
  priorityTop?: boolean;
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
  /** 衝突があるときだけ既定で開く。 */
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

/** lane タブの中身。 */
export interface LaneDetailView {
  iddId: string;
  title: string;
  group: LaneGroup;
  phaseLabel: string;
  source?: SourceRef;
  branch: string;
  area: string;
  since: string;
  priorityTop?: boolean;
  contract: {
    decisions: { id: string; text: string }[];
    criteria: { id: string; text: string; state: CriterionState }[];
    invariants?: { id: string; text: string }[];
  };
  /** 実装中のとき。 */
  work?: {
    files: { path: string; delta: string }[];
    stream: { time: string; kind: string; body: string; live?: boolean }[];
  };
  /** GO 待ちのとき。 */
  references?: { path: string; why: string }[];
  timeline: { time: string; title: string; detail: string; kind: "agent" | "user" | "warn" }[];
  agents: { role: string; sessionId: string; state: string }[];
  /** 末尾に出す判断。無ければ lane 操作のみ。 */
  pending?: DecisionKind;
}
