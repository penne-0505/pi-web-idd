import type { ReviewStage } from "../agent/port.ts";

/** who in the lane is told a norm: the planner's brief, the executor's brief, or both (each carries its `harness` text word for word) */
export type NormAudience = "planner" | "executor" | "both";

/** the record shapes a norm may apply to; `state` is the v2 shape */
export type NormShape = "docs" | "state";

/**
 * A point where, inside an Issue lane, the harness's rule comes before the target repo's own norms. The `repo` texts of
 * `lane-ids` and `lane-record-ids` describe the old (docs) shape's norms; a v2 lane is told neither. The lane's
 * planner or executor is told `harness`; the reviewers are told both, so they do not ask the lane to follow `repo`.
 */
export interface HarnessNorm {
  id: string;
  /** what the target repo's norms ask, without a closing 。 (it is quoted inside a reviewer's line) */
  repo: string;
  /** what the harness does instead, as the planner or executor is told it */
  harness: string;
  /** what a v2 lane is told instead, when it differs from `harness` */
  harnessV2?: string;
  toldTo: NormAudience;
  /** who a v2 lane tells it to; `none` means the norm is not told to a v2 lane at all */
  toldToV2?: NormAudience | "none";
}

export const HARNESS_NORMS: readonly HarnessNorm[] = [
  {
    id: "lane-ids",
    repo: "DEC / INV の ID は、既存の ID の最大値 + 1 で採番する（旧い形の規約の DEC。今の規約は `records.md` の「ID」）",
    harness: "DEC と INV の ID は `DEC-<lane の番号>-<連番>`・`INV-<lane の番号>-<連番>` で書く。連番はこの lane の中で 1 から数える。既存の番号だけの形の ID は書き換えない。",
    toldTo: "planner",
    toldToV2: "none",
  },
  {
    id: "lane-record-ids",
    repo: "TODO の ID は `Next ID No` から採番し、共有の qa の Round は既存の最大値 + 1 で数える（TODO.md の Create Task from Inbox と、旧い形の規約の QA round）",
    harness: "この lane で足す DEC・INV は `DEC-<lane の番号>-<連番>`・`INV-<lane の番号>-<連番>`、qa の Round は `Round <lane の番号>-<連番>`、TODO の task は `<Area>-<種別>-<lane の番号>-<連番>` で書く。連番はこの lane が書いたものだけを数える（Round はその qa の中、TODO は TODO.md の中）。`Next ID No` は読まず、書き換えない。すでに番号だけの形で書いた ID は書き換えない。",
    toldTo: "executor",
    toldToV2: "none",
  },
  {
    id: "todo-source",
    repo: "TODO の項目の Plan / Intent / QA の欄は、作った文書の path で埋め、path の Area は項目の Area と一致させる（TODO.md の Schema と Canonical Document Paths）",
    harness: "lane の記録の置き場はハーネスが決めるので、起票元の TODO の項目の Area と違ってよい。起票元の項目の ID・Area と Plan / Intent / QA の欄は書き換えず、lane の記録に向ける作業を計画にも書かない。起票元の項目は、実装役の brief の `<source-todo>` が名指す。その項目の Steps が済み、Acceptance Criteria を全部満たし、Intent Delta のある QA round を書き、verdict が PASS のときは、実装役がその項目を TODO から消す。作業指示の archive はハーネスが後で行うので待たない。一部だけ満たしたときは項目を残し、済んだ Steps に印を付ける。消した後の巡で条件が崩れたら項目を戻す。brief が項目を名指さない lane では項目を消さない。",
    harnessV2: "lane の記録の置き場はハーネスが決めるので、起票元の TODO の項目の Area と違ってよい。起票元の項目の ID・Area と Plan / Intent / QA の欄は書き換えず、lane の記録に向ける作業を計画にも書かない。起票元の項目は、実装役の brief の `<source-todo>` が名指す。その項目の Steps が済み、Acceptance Criteria を全部満たし、巡の宣言（Choice の記録か Waive）があり、記録の検査と configured-checks が通り、AC を evidence つきで確認済みと報告したときは、実装役がその項目を TODO から消す。作業指示の archive はハーネスが後で行うので待たない。一部だけ満たしたときは項目を残し、済んだ Steps に印を付ける。消した後の巡で条件が崩れたら項目を戻す。brief が項目を指さない lane では項目を消さない。",
    toldTo: "both",
  },
];

/** the norms one of the lane's own agents is told, as its brief carries them (a `both` norm reaches either role) */
export function normsFor(who: "planner" | "executor", shape: NormShape = "docs"): string[] {
  return HARNESS_NORMS.flatMap((n) => {
    const audience = shape === "state" ? n.toldToV2 ?? n.toldTo : n.toldTo;
    if (audience === "none" || (audience !== who && audience !== "both")) return [];
    const text = shape === "state" ? n.harnessV2 ?? n.harness : n.harness;
    return [text];
  });
}

/** the text one norm's planner or executor is told, for the place in a brief that concerns it */
export function normText(id: string, shape: NormShape = "docs"): string {
  const norm = HARNESS_NORMS.find((n) => n.id === id);
  if (!norm) throw new Error(`harness norm ${id} is not listed`);
  return shape === "state" ? norm.harnessV2 ?? norm.harness : norm.harness;
}

/**
 * One line for a reviewer of a lane: the harness's own arrangement (the lane's identifiers) folded into a single
 * line, so the reviewer does not raise the unusual numbers as the repo's norms being broken.
 */
export const REVIEW_LANE_LINE = "この差分は propter の lane で作られた。lane が立てる DEC・INV・TODO・Round の ID は、lane の番号と lane の中の連番で作る（例: `DEC-088-1`）。";

/** the same line for a v2 lane: the Choices are ids the harness assigns */
export const REVIEW_LANE_LINE_V2 = "この差分は propter の lane で作られた。lane が立てる Choice の ID（`C-<lane の番号>-<連番>`）と TODO の task の ID は、lane の番号と lane の中の連番で作る。";

/** the reviewer's line for the lane's record shape */
export function reviewLaneLine(shape: NormShape): string {
  return shape === "state" ? REVIEW_LANE_LINE_V2 : REVIEW_LANE_LINE;
}

/** the stages of the lane's own review loop that read or judge its diff and records */
export const NORM_STAGES: ReadonlySet<ReviewStage> = new Set<ReviewStage>(["blind", "final", "triage", "confirm"]);
