import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { dump as yamlDump } from "js-yaml";

import { isClaudeQuotaBlocked, type QuotaFallback } from "./claude-quota.ts";
import { INTENT_PURPOSE } from "../../idd-core/src/plan/prompt-text.ts";
import { acFormMustClause, planReviewSeverityRules } from "../../idd-core/src/plan/review-rules.ts";
import { acStandardSection, solvingStandardNote, standardsPath } from "../../idd-core/src/rules/rules.ts";
import { expandHome, laneStateDir } from "./paths.ts";
import { mergeFindings, type Finding } from "./report.ts";
import { readRoles, resolvePipelineRole, resolveRole, resolveRoleModel, type RolePreset, type RolesFile } from "./roles.ts";
import { checkClaudeConfigDir, closeDeadRun, readLane, rolesForStart, runLane, type LaneReadOptions, type LaneRecord } from "./runner.ts";
import { PLAN_REVIEW_STAGE } from "./inject.ts";
import { withoutManifestRows } from "./path-rules.ts";
import { SHAPE_TASK } from "./review-runs.ts";
import { manifestRowsAt } from "./worktree.ts";

/**
 * The planner's records are the whole instruction the executor will get when the lane has no request. The review
 * asks what breaks when those are followed literally, checked against the current code.
 */
const PLAN_REVIEW_TASK_BASE = [
  "入力の文書（decision.md / qa.md / reference.md）は、別のエージェント（executor）がこの Issue を実装するための指示である。executor はこれらだけを読み、書かれたとおりに実装し、書かれていないことはしない。",
  "この指示をレビューする。観点は「指示に書かれていないために、書かれたとおり実装すると退行・不整合・クラッシュを生む箇所」。文面の良し悪しではなく、現物のコード（この worktree）と指示を突き合わせ、指示が触る箇所の周辺で言及されていない依存・状態・寿命・購読・順序・index の前提を洗い出す。",
  "疑った点はコードで確かめる（該当ファイルを読む、grep する）。各判断（DEC）と受け入れ条件（AC）について「そのとおり実装したら何が起きるか」を追い、問題があれば severity 付きで指摘する。指示が正しく扱っている点は書かない。コードも文書も変更しない。",
].join("\n");

/** the two lenses a plan itself is read with: the request's 6 fields, or the old design form's what-breaks */
export type PlanReviewLens = "request" | "design";

/**
 * A plan written in the request form opens with `## 依頼`; one written before the switch opens with the design
 * form's sections. The plan itself carries the shape, so no marker is added and a lane is read the same way through
 * its life.
 */
export function planReviewLens(planText: string): PlanReviewLens {
  return /^##\s*依頼\s*$/m.test(planText) ? "request" : "design";
}

/** the records lens of a v1 lane: decision.md read by the DEC bar */
const DOCS_RECORDS_LENS = [
  "decision.md は恒久の意図の記録で、作業指示ではない。実装に必要な情報の不足は plan.md への指摘にし、decision.md への追加を求めない。decision.md に見るのは 2 点である。各 DEC が「将来の agent がこれを知らずに変えたら、守りたいものが壊れるか」の基準に合うか。Why が因果になっているか。",
  "出所だけの Why と、What の言い換えだけの Why は must にする。基準に合わない DEC（文面どおりの実装・現状維持の確認・範囲の宣言・コードから読める how・確かめた事実）は should にする。",
];

/** the records lens of a v2 lane with a plan: the plan report's Choice drafts */
const STATE_RECORDS_LENS = [
  "Choice のファイルは plan の報告の草案で、恒久の意図の記録ではない。実装に必要な情報の不足は plan.md への指摘にし、Choice への追加を求めない。各 Choice は `_docs/standards/checks.md` の「Judge が見るもの」の観点で見る。forms.chosen が選んだ形の名詞句か。why が因果か（出所だけ・What の言い換えは must）。rejected が形骸でなく、Purpose を満たさない理由になっているか。anchored が実装方式が変わっても破れない結果か（INV の番号を振っていないか）。Purpose に連なっているか。",
  "触る Place の既存の Choice に付いた処置（existing）も見る。unconfirmed の確認が現物と合うか、捨てる grounds が「現物と合わない」になっているか。root の Choice を lane から直接変えようとしていれば must にする。",
  "Purpose も見る。この lane が出した Purpose の案の want が成果物の性質（prototype と一致する・絵が同じ・無い）なら must にする。草案が連なる既存の active な Purpose の want が成果物の性質なら、planner には差し戻さず GO の人に見えるよう should にする。",
];

/** the same Choice lens with no plan to point a shortage at, for a v2 lane that has no request */
const STATE_RECORDS_LENS_NO_PLAN = [
  "Choice のファイルは plan の報告の草案で、恒久の意図の記録ではない。各 Choice は `_docs/standards/checks.md` の「Judge が見るもの」の観点で見る。forms.chosen が選んだ形の名詞句か。why が因果か（出所だけ・What の言い換えは must）。rejected が形骸でなく、Purpose を満たさない理由になっているか。anchored が実装方式が変わっても破れない結果か（INV の番号を振っていないか）。Purpose に連なっているか。",
  "触る Place の既存の Choice に付いた処置（existing）も見る。unconfirmed の確認が現物と合うか、捨てる grounds が「現物と合わない」になっているか。root の Choice を lane から直接変えようとしていれば must にする。",
  "Purpose も見る。この lane が出した Purpose の案の want が成果物の性質（prototype と一致する・絵が同じ・無い）なら must にする。草案が連なる既存の active な Purpose の want が成果物の性質なら、planner には差し戻さず GO の人に見えるよう should にする。",
];

/** the compatibility the plan review does not call a bridge: the contracts (P5). What counts as one is defined in solving.md, named here by section */
const SOLVING_COMPAT_BOUNDARY = "契約を保つ互換（P5。`config/repos.yaml` の `contracts` に載るもの、および宣言が無くても契約になるもの。`_docs/standards/solving.md` の「契約」）は橋渡しとして扱わない。";

/**
 * The solving standard read against an old-form (docs) lane that has no plan: decision.md and qa.md are what the
 * executor follows. The form takes no new DEC or Choice, so a stopgap is looked for in the follow-up Issue's draft,
 * and a pointer left on a place is no substitute for that Issue (P7・R9). Named by number only.
 */
const SOLVING_CONTRACT_RULE_NO_PLAN_DOCS = "加えて、`_docs/standards/solving.md` を開き、decision.md・qa.md が R1・R3・R9（根拠 P1・P4・P7）に反するなら、実装役が補えない欠けなので must にして計画役へ差し戻す。旧い形を残すなら、Choice や DEC は求めない。R9 の記録を後続の Issue の案（`idd out draft --kind gh-issue`）の本文に持つ記述があるかを見る。場所に付いた指摘を後続の Issue の代わりにするものも同じ。" + SOLVING_COMPAT_BOUNDARY + "指摘の根拠には P 番号を書く。";

/** the purpose of the records leads both forms of the task, but never a blind's brief (DEC-2641) */
export const PLAN_REVIEW_TASK = [INTENT_PURPOSE, PLAN_REVIEW_TASK_BASE, SOLVING_CONTRACT_RULE_NO_PLAN_DOCS].join("\n");

/**
 * The solving standard read against a contract that has no plan: the Choices and qa.md are what the executor follows,
 * so a contract that lets it solve the symptom or leave a bridge is a lack it cannot fill. Named by number only.
 */
const SOLVING_CONTRACT_RULE_NO_PLAN = "加えて、`_docs/standards/solving.md` を開き、契約（Choice・qa.md）が R1・R3・R9（根拠 P1・P4・P7）に反するなら、実装役が補えない欠けなので must にして計画役へ差し戻す。旧い形を残すなら、応急処置の Choice の草案があるかを見る。" + SOLVING_COMPAT_BOUNDARY + "指摘の根拠には P 番号を書く。";

/**
 * The one version of the section the planner and the review share: the package's `work.md`. A lane that changes the
 * norms makes the planner read its worktree's other standards, but this section is read from the package by both, so
 * the planner's rule and the review's rule are one and a branch's edit of it does not split them.
 */
const AC_SECTION_ORIGINAL_NOTE = "この節はパッケージの原物で、計画役の規約の束と同じ版である。この worktree の `_docs/standards/work.md`（branch の版）が違っていても、この節だけは読み替えない。";

/**
 * What the review reads a qa.md's AC by: the acceptance-criteria section of the package's `work.md`, as it stands
 * (the planner's bundle carries the same section, C-285-1), so the two roles read one rule and a fix to it reaches
 * the next lane. The reviewer is told its weight apart from any table, so a lane with no severity table has it too.
 * A state lane (Choices) gets the whole section and the clause that sends the fix to where a defence belongs; an
 * old-form (docs) lane has no Choice to put a defence in, so it gets the three conditions and the root clause only,
 * and its fix stays in decision.md and qa.md.
 */
export function acReviewRule(shape: "docs" | "state"): string {
  const section = acStandardSection(undefined, { placement: shape === "state" });
  const where = `\`_docs/standards/work.md\` の「受け入れ条件（AC）」の節`;
  return [
    `qa.md の AC は、次の ${where}（原物のまま）の ${shape === "state" ? "3 条件と置き場の規則" : "3 条件"}で読む。${AC_SECTION_ORIGINAL_NOTE}`,
    section,
    `次は must にして計画役へ差し戻す: ${acFormMustClause(shape)}`,
  ].join("\n");
}

/**
 * A v2 lane with no request still has records: the plan report's Choice drafts, never decision.md. Its own task
 * names only what it has, so no lane without a work instruction is told to read one it does not write.
 */
function planReviewTaskV2NoPlan(): string {
  return [INTENT_PURPOSE, [
    "入力の Choice のファイル・qa.md・reference.md は、別のエージェント（executor）がこの Issue を実装するための契約である。executor はこれらだけを読み、書かれたとおりに実装し、書かれていないことはしない。",
    "この契約をレビューする。観点は「書かれていないために、書かれたとおり実装すると退行・不整合・クラッシュを生む箇所」。文面の良し悪しではなく、現物のコード（この worktree）と契約を突き合わせ、契約が触る箇所の周辺で言及されていない依存・状態・寿命・購読・順序・index の前提を洗い出す。",
    ...STATE_RECORDS_LENS_NO_PLAN,
    SOLVING_CONTRACT_RULE_NO_PLAN,
    acReviewRule("state"),
    "疑った点はコードで確かめる（該当ファイルを読む、grep する）。契約が正しく扱っている点は書かない。コードも文書も変更しない。",
  ].join("\n")].join("\n");
}

/**
 * The same standard read against a plan in the old design form. The principles and R1・R3 apply whatever the form of the
 * records; only where the stopgap's three facts are written differs: an old-form lane has no Choice to ask for (and
 * decision.md takes no new DEC), so they go in the follow-up Issue's draft; a state-form lane writes a Choice draft.
 */
const SOLVING_DESIGN_RULE_COMMON = "加えて、`_docs/standards/solving.md` を開き、R1・R3（根拠 P1・P4）に反する指示は、実装役が補えない欠けなので must にして計画役へ差し戻す。" + SOLVING_COMPAT_BOUNDARY;

/** an old-form (docs) lane takes no new DEC or Choice: the stopgap's three facts ride in the follow-up Issue's draft */
const SOLVING_DESIGN_RULE_DOCS = SOLVING_DESIGN_RULE_COMMON + "旧い形を残す指示は、Choice や DEC は求めず、R9 の記録を後続の Issue の案（`idd out draft --kind gh-issue`）の本文に持つ指示があるかを見る。場所に付いた指摘を後続の Issue の代わりにする指示は差し戻す（P7・R9）。指摘の根拠には P 番号を書く。";

/** a state-form lane records the stopgap as a Choice draft, whatever the form of the plan */
const SOLVING_DESIGN_RULE_STATE = SOLVING_DESIGN_RULE_COMMON + "旧い形を残す指示は、R9 の記録を持つ応急処置の Choice の草案（revisit が後続の Issue を指す）があるかを見る（P7・R9）。指摘の根拠には P 番号を書く。";

/** the old lens for a plan written in the design form: what breaks when it is followed literally */
function designLens(reads: string, shape: "docs" | "state"): string[] {
  return [
    `入力の plan.md は、別のエージェント（executor）がこの Issue を実装するための作業指示である。executor は ${reads} を読み、書かれたとおりに実装し、書かれていないことはしない。`,
    "作業指示をレビューする。観点は「指示に書かれていないために、書かれたとおり実装すると退行・不整合・クラッシュを生む箇所」。文面の良し悪しではなく、現物のコード（この worktree）と指示を突き合わせ、指示が触る箇所の周辺で言及されていない依存・状態・寿命・購読・順序・index の前提を洗い出す。",
    shape === "state" ? SOLVING_DESIGN_RULE_STATE : SOLVING_DESIGN_RULE_DOCS,
  ];
}

/** the context document is among the inputs, so it is named among what the executor reads */
function contextRead(hasContext: boolean): string {
  return hasContext ? "・lane の重要なコンテクストの文書（context.md）" : "";
}

/**
 * The section points at the lane's context document (C-196-2), and that is a bar only for a lane that has one. A plan
 * written before the document existed carries its facts in the section itself, and its worktree's brief.md still asks
 * for them there, so the review must not send it back for a shape that did not exist when it was written (C-124-4).
 */
const CONTEXT_SECTION_RULE = "plan.md の「重要なコンテクスト」欄は、lane のコンテクストの文書（`_docs/context/<Area>/<slug>/context.md`。inputs にあれば context.md）の所在だけを持つ。その欄を判定するときは、plan.md と並べてこの文書を読み、事実が文書にだけあり、欄が所在を指しているかを見る。";

/** the same paragraph for a lane with no context document: said out loud, so the review does not fall back to the old bar */
const NO_CONTEXT_SECTION_RULE = "この lane には lane のコンテクストの文書が無い（inputs に context.md が無い）。したがって plan.md の「重要なコンテクスト」欄が事実を持っていても、この査読では誤りとしない。欄が文書の所在だけを指す形は、文書を持つ lane の基準である。";

/**
 * The solving standard's reading of a plan: the principle is named by its number and its body is the standard's own
 * (`_docs/standards/solving.md`), never copied here. A plan that solves the symptom around its cause, or keeps an old
 * form with no record, is a lack the executor cannot fill, so it goes back to the planner.
 */
const SOLVING_PLAN_RULE_STATE = "加えて、`_docs/standards/solving.md` を開き、R1・R3・R9（根拠 P1・P4・P7）に反する依頼は、実装役が補えない欠けなので must にして計画役へ差し戻す。旧い形を残す依頼は、応急処置の Choice の草案があるかを見る。原因が Issue の範囲を越えるのに止まらず実装に進む依頼も同じ（R1）。" + SOLVING_COMPAT_BOUNDARY + "指摘の根拠には P 番号を書く。";

/** the same reading for an old-form plan: the records there are decision.md, which takes no new DEC, so the stopgap's three facts are written in the follow-up Issue's draft */
const SOLVING_PLAN_RULE_DOCS = "加えて、`_docs/standards/solving.md` を開き、R1・R3・R9（根拠 P1・P4・P7）に反する依頼は、実装役が補えない欠けなので must にして計画役へ差し戻す。旧い形を残す依頼は、Choice や DEC は求めない。R9 の記録を後続の Issue の案（`idd out draft --kind gh-issue`）の本文に持つ記述があるかを見る。場所に付いた指摘を後続の Issue の代わりにする依頼も同じ。原因が Issue の範囲を越えるのに止まらず実装に進む依頼も同じ（R1）。" + SOLVING_COMPAT_BOUNDARY + "指摘の根拠には P 番号を書く。";

/** the request lens: the plan is a request, and the review reads its six fields, never the design */
function requestLens(reads: string, hasContext: boolean, shape: "docs" | "state"): string[] {
  return [
    `入力の plan.md は、依頼の 6 欄で書かれた、実装役が人に聞き返さずに着手できる依頼である。6 欄と入場条件の正は \`_docs/standards/brief.md\` にある。実装役は ${reads} を読む。`,
    hasContext ? CONTEXT_SECTION_RULE : NO_CONTEXT_SECTION_RULE,
    "見るのは設計の正しさではなく、依頼として成立しているかである。6 観点は「原物の所在と読み方があり、要約で代えていないか」「意図に出典があるか、計画役の補いが推測と明示されているか」「完了の形に全体 1 文と実装役以外の判定者があり、全体 1 文が成果物の性質でなく、床は状態の記述か」「守ることに why があり、取り返しがつかないものに絞られているか」「戻す条件に入力・手段の不足があるか」「how（順序・手順・関数の分割・テストの構成）が混ざっていないか」である。",
    shape === "state" ? SOLVING_PLAN_RULE_STATE : SOLVING_PLAN_RULE_DOCS,
    planReviewSeverityRules(shape),
    acReviewRule(shape),
  ];
}

/** the closing the request lens shares with every other task: check the doubt in code, change nothing */
const PLAN_REVIEW_CLOSING = "疑った点はコードで確かめる（該当ファイルを読む、grep する）。依頼が正しく扱っている点は書かない。コードも文書も変更しない。";

/**
 * The task and focus of a plan review. A request-form plan is read as a request, a design-form plan by the old
 * what-breaks lens (C-124-4), and a lane with no plan by its records alone (DEC-2647). Whatever the lens or the
 * records' shape, the qa.md's AC is read by the one acceptance-criteria section (`acReviewRule(shape)`), so the bar on an AC
 * does not split by the plan's form. `hasContext` is the lane having
 * a context document among its inputs; it defaults to false, which reads the plan as one written without it.
 */
export function planReviewTask(hasPlan: boolean, shape: "docs" | "state" = "docs", lens: PlanReviewLens = "request", hasContext = false): string {
  if (!hasPlan) return shape === "state" ? planReviewTaskV2NoPlan() : [PLAN_REVIEW_TASK, acReviewRule("docs")].join("\n");
  const reads = (shape === "state" ? "plan.md・Choice のファイル・qa.md" : "plan.md・decision.md・qa.md") + contextRead(hasContext);
  if (lens === "design") return [INTENT_PURPOSE, ...designLens(reads, shape), ...(shape === "state" ? STATE_RECORDS_LENS : DOCS_RECORDS_LENS), acReviewRule(shape), PLAN_REVIEW_CLOSING].join("\n");
  return [INTENT_PURPOSE, ...requestLens(reads, hasContext, shape), ...(shape === "state" ? STATE_RECORDS_LENS : DOCS_RECORDS_LENS), PLAN_REVIEW_CLOSING].join("\n");
}

const PLAN_REVIEW_FOCUS_COMMON = [
  "指示が変えるものに依存している既存コードで、指示が触れていないものは何か",
  "指示どおりに実装したとき、状態・リスナー・購読・寿命・順序がずれる箇所はあるか",
];

const PLAN_REVIEW_FOCUS_BASE = [
  ...PLAN_REVIEW_FOCUS_COMMON,
  "受け入れ条件とそのテストは、上で見つけた問題を検出できるか",
];

/**
 * The question a v2 review asks where a harm was found: where its defence belongs, by `work.md`'s acceptance-criteria
 * section, so a finding does not ask only for one more sentence in an AC (C-285-4). It replaces the base question
 * on the paths that read a request or a contract with no plan; the design lens and the old-form lane keep theirs.
 */
export const PLAN_REVIEW_FOCUS_AC_PLACEMENT = "上で見つけた害の防ぎは、`_docs/standards/work.md` の AC の節に照らして、AC の状態・Choice の anchored・free（実装役の裁量）のどこに置くのが正しいか。AC の文を増やすことだけを直しにしていないか。qa.md の AC は状態の文か";

/** the no-plan contract's own question: the Choices stand where a plan's intent would */
const SOLVING_FOCUS_NO_PLAN = "契約が症状だけを消す・迂回や橋渡しで満たす・旧い形を消さない・応急処置の Choice の草案が無いものではないか（`_docs/standards/solving.md` の P1・P4・P7）";

/** the same question for an old-form lane with no plan: a stopgap is written in the follow-up Issue's draft, not in a Choice or a DEC */
const SOLVING_FOCUS_NO_PLAN_DOCS = "decision.md・qa.md が症状だけを消す・迂回や橋渡しで満たす・旧い形を消さない・応急処置を後続の Issue の案に起こさず場所の指摘に残すものではないか（`_docs/standards/solving.md` の P1・P4・P7）";

export const PLAN_REVIEW_FOCUS = [...PLAN_REVIEW_FOCUS_BASE, SOLVING_FOCUS_NO_PLAN_DOCS];

/** the request lens's own questions: the 6 observations, then the records' */
const PLAN_REVIEW_FOCUS_REQUEST = [
  "原物の所在と読み方があり、要約で代えていないか",
  "意図の各文に出典があるか。計画役の補いが推測と明示されているか",
  "完了の形に全体 1 文と実装役以外の判定者があり、全体 1 文が成果物の性質でなく、床は状態の記述か",
  "守ることに why があり、取り返しがつかないものに絞られているか",
  "戻す条件に入力・手段の不足があるか",
  "how（順序・手順・関数の分割・テストの構成）が混ざっていないか",
  "意図が症状と原因を分けて持ち、迂回や橋渡しで課題を満たしていないか。旧い形を残すなら応急処置の Choice の草案があるか（`_docs/standards/solving.md` の P1・P4・P7）",
];

/** the same question for an old-form plan, which has no Choice draft to look for */
const SOLVING_FOCUS_DOCS = "意図が症状と原因を分けて持ち、迂回や橋渡しで課題を満たしていないか。旧い形を残すなら後続の Issue の案の本文に応急処置と書かれているか（`_docs/standards/solving.md` の P1・P4・P7）";

/** the design lens's own question: what a stopgap is recorded in follows the lane's shape */
const SOLVING_FOCUS_DESIGN_STATE = "症状だけを消す・迂回や橋渡しで満たす・旧い形を消さない・応急処置の Choice の草案が無い指示ではないか（`_docs/standards/solving.md` の P1・P4・P7）";
const SOLVING_FOCUS_DESIGN_DOCS = "症状だけを消す・迂回や橋渡しで満たす・旧い形を消さない・応急処置を後続の Issue の案に起こさず場所の指摘に残す指示ではないか（`_docs/standards/solving.md` の P1・P4・P7）";

/** the review's questions, and the records' line when a plan is there: the lane's shape decides the records' line */
export function planReviewFocus(hasPlan: boolean, shape: "docs" | "state" = "docs", lens: PlanReviewLens = "request"): string[] {
  if (!hasPlan) return shape === "state" ? [...PLAN_REVIEW_FOCUS_COMMON, PLAN_REVIEW_FOCUS_AC_PLACEMENT, SOLVING_FOCUS_NO_PLAN] : PLAN_REVIEW_FOCUS;
  const records = shape === "state" ? "草案の各 Choice は `_docs/standards/checks.md` の「Judge が見るもの」の観点に合い、why は因果か。触る Place の処置は現物と合うか" : "decision.md の各 DEC は基準に合い、Why は因果か";
  if (lens === "design") return [...PLAN_REVIEW_FOCUS_BASE, shape === "state" ? SOLVING_FOCUS_DESIGN_STATE : SOLVING_FOCUS_DESIGN_DOCS, records];
  // only a lane with Choices is asked where a defence belongs: an old-form lane has no Choice for it, so its question stays
  return shape === "state" ? [...PLAN_REVIEW_FOCUS_REQUEST, PLAN_REVIEW_FOCUS_AC_PLACEMENT, records] : [...PLAN_REVIEW_FOCUS_REQUEST.slice(0, -1), SOLVING_FOCUS_DOCS, records];
}

export interface PlanReviewOptions {
  iddId: string;
  worktree: string;
  /** repo-relative paths of the planner's documents */
  inputs: string[];
  role: string;
  /** the model definition's name this run uses; absent when the role's own model is used */
  model?: string;
  /** the thinking this role and model pair runs with */
  thinking?: string;
  rules?: string[];
  attempt?: number;
  /** the role the slot asked for, when `role` is its fallback: it names the run's directory */
  slotRole?: string;
  /** `role` is the fallback of a Claude Code role the caller found refused for the windows */
  quotaFallback?: QuotaFallback;
  /** an Issue lane's points where the harness's rules the planner followed come before the repo's, told as knowledge */
  norms?: string[];
  /** the IDD norms the lane ran under, told as knowledge (not an override of the repo's norms) */
  iddNorms?: string[];
  /** the lane's record shape: a v2 lane's records are the plan report's Choice drafts (DEC-119-6) */
  recordsShape?: "docs" | "state";
  /** this run is the shape judge (C-252-1): it reads the same inputs with the judge's task, and writes its own report */
  shape?: boolean;
}

/**
 * One directory per run: the attempt, and the run's own identifier (the role the slot asked for and the model
 * definition it runs with). Two runs of one role with two models write their spec and their report side by side,
 * so one does not overwrite the other's findings.
 */
export function planReviewDir(iddId: string, attempt: number, run: string): string {
  const dir = join(laneStateDir(), "..", "pipeline", "plan-review", `${iddId}-${attempt}-${run}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** the run's identifier: the role (the slot's role when a fallback ran in its place) and the model definition */
export function planReviewRunId(role: string, model?: string): string {
  return model ? `${role}-${model}` : role;
}

export function writePlanReviewSpec(opts: PlanReviewOptions): { specPath: string; report: string } {
  const worktree = resolve(expandHome(opts.worktree));
  if (!existsSync(worktree)) throw new Error(`worktree がありません: ${worktree}`);
  const inputs = opts.inputs.map((p) => resolve(worktree, p)).filter((p) => existsSync(p));
  if (!inputs.length) throw new Error(`査読する文書がありません: ${opts.inputs.join(", ")}`);
  const out = planReviewDir(opts.iddId, opts.attempt ?? 1, planReviewRunId(opts.slotRole ?? opts.role, opts.model));
  // the review's shape follows the lane, not the repo's setting: a plan among the inputs means it has a work instruction (DEC-2643)
  const hasPlan = inputs.some((p) => /[\\/]plan\.md$/.test(p));
  // a plan carries its own form: one written before the switch stays on the old lens, one in the request form on the new
  const planFile = hasPlan ? inputs.find((p) => /[\\/]plan\.md$/.test(p)) : undefined;
  const lens = planFile && existsSync(planFile) ? planReviewLens(readFileSync(planFile, "utf8")) : "request";
  // a context document among the inputs is what makes the section's "place only" bar apply to this lane
  const hasContext = inputs.some((p) => /[\\/]context\.md$/.test(p));
  // the fixed list leaves out what the worktree's overlay.manifest names (the harness's own file, not the repo's convention); a list the caller names is theirs
  const present = (files: string[]) => files.filter((r) => existsSync(join(worktree, r)));
  const rules = opts.rules ? present(opts.rules) : withoutManifestRows(worktree, present(["AGENTS.md", "AGENTS.override.md"]), manifestRowsAt(worktree, ["HEAD"]));
  // a tree without solving.md (an adopted repo keeps no norms) is told where the original is, and the original is an input the role may open
  const solvingNote = solvingStandardNote(worktree);
  const solvingOriginal = join(standardsPath(), "solving.md");
  const spec = {
    role: opts.role,
    // the stage's declared pair: the model definition the run calls and the thinking of that pair
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    title: `${opts.shape ? "shape" : "plan review"} ${opts.iddId}`,
    // the stage is `plan_review` only for the injection: a plan review's `stage` is absent on purpose (the loop's
    // report reading keys off it), so the injection names its own, and the lane it belongs to (DEC-107-3). The shape
    // judge is given none: it reads the plan, the contract and the rounds as handed, with no Choice brought in beside them.
    ...(opts.shape ? {} : { inject_stage: PLAN_REVIEW_STAGE, inject_lane: opts.iddId }),
    lane: opts.iddId,
    worktree,
    inputs: !opts.shape && solvingNote && existsSync(solvingOriginal) ?[...inputs, solvingOriginal] : inputs,
    rules,
    ...(opts.norms?.length ? { norms: opts.norms } : {}),
    ...(opts.iddNorms?.length ? { idd_norms: opts.iddNorms } : {}),
    task: opts.shape ? SHAPE_TASK : [planReviewTask(hasPlan, opts.recordsShape ?? "docs", lens, hasContext), ...(solvingNote ? [solvingNote] : [])].join("\n"),
    focus: opts.shape ? [] : planReviewFocus(hasPlan, opts.recordsShape ?? "docs", lens),
    report: join(out, opts.shape ? "shape" : "plan-review"),
  };
  const specPath = join(out, opts.shape ? "shape.yaml" : "plan-review.yaml");
  writeFileSync(specPath, yamlDump(spec, { lineWidth: -1 }));
  return { specPath, report: spec.report };
}

/** model is the one the lane runs: the fallback's when the role was refused for Claude's windows */
export async function startPlanReview(opts: PlanReviewOptions): Promise<{ laneId: string; report: string; role: string; model: string; fallback?: QuotaFallback }> {
  const { specPath, report } = writePlanReviewSpec(opts);
  const lane = await runLane(specPath, { wait: false, ...(opts.quotaFallback ? { quotaFallback: opts.quotaFallback } : {}) });
  return { laneId: lane.id, report, role: lane.role, model: lane.model, ...(lane.quota_fallback ? { fallback: lane.quota_fallback } : {}) };
}

export interface PlanReviewRunStart {
  runId: string;
  role: string;
  model: string;
  /** this run is the shape judge: the review's closing counts it apart from the reviewers (C-252-5) */
  shape?: true;
}

/**
 * One run per role of pipeline.plan_review (`roles: [a, b]`, or the one `role:`). A role that cannot start is
 * returned as failed while the others run; only when none started does this throw.
 *
 * A Claude Code role nobody logged in to fails on its own (no fallback stands in for a lapsed login). Over the
 * windows, a Claude Code role with a fallback runs as its fallback and is listed in `fallbacks`; one without
 * holds the whole review before any run starts. A fallback that is already one of the review's runs is folded
 * into that run (listed with `folded`), so the same model never reviews twice and its findings are not
 * counted as two reviewers agreeing. It folds only into a run that started: when that run failed to start,
 * the fallback starts on its own.
 */
export async function startPlanReviews(
  opts: Omit<PlanReviewOptions, "role" | "slotRole" | "quotaFallback" | "shape"> & { /** how many of the slot's roles to run, counted from the top (the lane's depth); all when left out */ roles?: number; /** the depth asks for the shape judge beside the reviewers (the depth table's `shape` column) */ withShape?: boolean },
  start: (o: PlanReviewOptions) => Promise<{ laneId: string; role?: string; model?: string; fallback?: QuotaFallback }> = startPlanReview,
): Promise<{ runs: PlanReviewRunStart[]; failed: { role: string; model: string; error: string; shape?: true }[]; fallbacks?: QuotaFallback[] }> {
  const { roles: roleCount, withShape, ...base } = opts;
  const file = readRoles();
  // the shape judge's slot is read before any run starts: a settings file without it stops the review here, naming what is missing
  const shapeRole = withShape ? shapeJudgeRole(file) : undefined;
  const { slot } = resolvePipelineRole("plan_review", file);
  const all = slot.runs.map((run) => (run.model ? resolveRoleModel(run.role, run.model, file, run.thinking) : resolveRole(run.role, file)));
  // the depth's count takes the slot's roles from the top; a list shorter than the count runs as it is
  const roles = typeof roleCount === "number" ? all.slice(0, Math.max(0, roleCount)) : all;
  const failed: { role: string; model: string; error: string; shape?: true }[] = [];
  let startable = roles;
  if (roles.some((r) => r.harness === "claude")) {
    try {
      checkClaudeConfigDir(file.defaults.claudeConfigDir);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const r of roles) if (r.harness === "claude") failed.push({ role: r.name, model: r.model, error });
      startable = roles.filter((r) => r.harness !== "claude");
    }
  }
  // the windows are checked for every role before any run starts: a role without a fallback holds the review
  const picked = startable.length ? rolesForStart(startable, file) : [];
  const runs: PlanReviewRunStart[] = [];
  const fallbacks: QuotaFallback[] = [];
  // a fallback folds only into a run of its role that has started, never into one that failed to start
  const started = new Set<string>();
  // the run's key: the role and the model it runs with, so the same pair never runs twice
  const runKey = (role: string, model: string) => `${role}\u0000${model}`;
  let quota: unknown;
  const startOne = async (i: number) => {
    const { role, fallback } = picked[i];
    const asked = startable[i];
    // the model definition this run calls (a pi role's own: the stage's, or the 替わり that stands in for it)
    // and the thinking of that pair. A Claude Code role has no model definition: its alias is its own.
    const model = role.harness === "pi" ? role.modelName : undefined;
    const key = runKey(role.name, role.model);
    if (fallback && started.has(key)) {
      fallbacks.push({ ...fallback, folded: true });
      return;
    }
    try {
      const lane = await start({ ...base, role: role.name, model, thinking: role.thinking, ...(fallback ? { slotRole: asked.name, quotaFallback: fallback } : {}) });
      // the lane's own record says what ran: it may have been refused for the windows after the check above
      runs.push({ runId: lane.laneId, role: lane.role ?? role.name, model: lane.model ?? role.model });
      started.add(key);
      if (lane.role) started.add(runKey(lane.role, lane.model ?? role.model));
      const ran = lane.fallback ?? fallback;
      if (ran) fallbacks.push(ran);
    } catch (err) {
      if (isClaudeQuotaBlocked(err)) quota ??= err;
      // the model that would have run is the resolved one (the pair's call target), not the role's own default
      failed.push({ role: asked.name, model: role.model, error: err instanceof Error ? err.message : String(err) });
    }
  };
  // a fallback waits for the slot's own run of the same role and model further on, so what folds does not depend on the order
  const deferred: number[] = [];
  for (const [i, { role, fallback }] of picked.entries()) {
    if (fallback && picked.slice(i + 1).some((p) => !p.fallback && runKey(p.role.name, p.role.model) === runKey(role.name, role.model))) deferred.push(i);
    else await startOne(i);
  }
  for (const i of deferred) await startOne(i);
  if (shapeRole) {
    // the judge is an extra run of its own slot, never one of the plan_review roles: the depth's count of reviewers is not changed
    try {
      const lane = await start({ ...base, role: shapeRole.name, model: shapeRole.harness === "pi" ? shapeRole.modelName : undefined, thinking: shapeRole.thinking, shape: true });
      runs.push({ runId: lane.laneId, role: lane.role ?? shapeRole.name, model: lane.model ?? shapeRole.model, shape: true });
    } catch (err) {
      if (isClaudeQuotaBlocked(err)) quota ??= err;
      failed.push({ role: shapeRole.name, model: shapeRole.model, error: err instanceof Error ? err.message : String(err), shape: true });
    }
  }
  if (!runs.length) {
    // nothing started and the windows were the reason: the stage waits instead of failing
    if (quota) throw quota;
    throw new Error(failed.map((f) => `${f.role}: ${f.error}`).join(" / "));
  }
  return { runs, failed, ...(fallbacks.length ? { fallbacks } : {}) };
}

/**
 * The role of the shape judge's slot. A file with no `pipeline.shape_judge`, or a role there that does not write the
 * shape report, stops the review before any run starts and says what is missing (the plan review of a deep lane
 * runs the judge, so the declaration is required the way `pipeline.spec_check` is).
 */
export function shapeJudgeRole(file: RolesFile): RolePreset {
  if (!file.pipeline["shape_judge"]) {
    throw new Error('config/roles.yaml の pipeline に "shape_judge" がありません。深さ deep の計画の査読は形の判断を走らせるので、宣言が要る（pipeline.spec_check と同じく、深さのある review の前提）');
  }
  const { role } = resolvePipelineRole("shape_judge", file);
  if (role.report !== "shape") throw new Error(`pipeline.shape_judge の role ${role.name} は report: ${role.report}。この段は shape が必要`);
  return role;
}

/** a plan review's finding as the engine keeps it: no line, and the role that raised it as its source */
export interface PlanReviewFindingLike {
  severity: Finding["severity"];
  path: string;
  claim: string;
  evidence: string;
  source?: string;
}

/** the parallel plan reviews are folded the way `idd report merge` folds blind reviews */
export function mergePlanReviewFindings(lists: PlanReviewFindingLike[][]): PlanReviewFindingLike[] {
  const folded = mergeFindings(lists.map((l) => l.map((f) => ({ ...f, line: null, is_guess: false }))));
  return folded.findings.map((f) => ({ severity: f.severity, path: f.path, claim: f.claim, evidence: f.evidence, ...(f.source ? { source: f.source } : {}) }));
}

export type PlanReviewState =
  | { state: "running" }
  | { state: "failed"; error: string }
  | { state: "done"; findings: Finding[]; reportMd: string; fallbacks?: QuotaFallback[] };

export function planReviewState(laneId: string, opts: LaneReadOptions = {}): PlanReviewState {
  let rec: LaneRecord;
  try {
    rec = closeDeadRun(readLane(laneId), opts);
  } catch (err) {
    return { state: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (rec.status === "running") return { state: "running" };
  const json = `${rec.report}.json`;
  if (rec.status !== "done" || !existsSync(json)) return { state: "failed", error: rec.error ?? `lane ${rec.status}` };
  let raw: { findings?: Record<string, unknown>[] };
  try {
    raw = JSON.parse(readFileSync(json, "utf8"));
  } catch (err) {
    return { state: "failed", error: `査読の報告を読めません: ${err instanceof Error ? err.message : String(err)}` };
  }
  // an unknown severity must not let a finding slip past the GO gate, so it counts as a should
  const sev = (v: unknown): Finding["severity"] => (v === "must" || v === "should" || v === "nit" ? v : "should");
  const findings: Finding[] = (raw.findings ?? [])
    .filter((f) => f && typeof f.claim === "string")
    .map((f) => ({
      severity: sev(f.severity),
      path: String(f.path ?? ""),
      line: typeof f.line === "number" ? f.line : null,
      claim: String(f.claim),
      evidence: String(f.evidence ?? ""),
      is_guess: Boolean(f.is_guess),
    }));
  return { state: "done", findings, reportMd: `${rec.report}.md`, ...(rec.fallbacks?.length ? { fallbacks: rec.fallbacks } : {}) };
}
