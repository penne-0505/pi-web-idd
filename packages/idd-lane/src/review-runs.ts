import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { dump as yamlDump } from "js-yaml";

import type { QuotaFallback } from "./claude-quota.ts";
import { expandHome, laneStateDir, reposPath } from "./paths.ts";
import { isOverlayPath } from "../../idd-core/src/overlay/manifest.ts";
import { solvingStandardNote, standardsPath } from "../../idd-core/src/rules/rules.ts";
import { diffPaths, laneRules, type RuleSelection } from "./path-rules.ts";
import { recommendedAction, type Finding } from "./report.ts";
import { incrementContext, renderIncrementContext } from "./increment.ts";
import { readLaneRepos, repoForPath, type LaneRepo } from "./repos.ts";
import { DEFAULT_MAX_ROUTES, DEFAULT_MIN_LINES, diffLineCount, MAP_TASK, mapFocus, parseRoutes, planRoutedBlind, routesInDiff, type RiskRoute } from "./risk-map.ts";
import { readRoles, resolvePipelineRole, resolveRole, resolveRoleModel, type PipelineSlot, type RolesFile, type StageRun } from "./roles.ts";
import type { BriefCheck } from "../../idd-core/src/plan/prompt-text.ts";
import { closeDeadRun, readLane, rolesForStart, runLane, stopLane, type LaneReadOptions, type LaneRecord, type RunOptions } from "./runner.ts";
import { stageGetsInjection } from "./inject.ts";
import { INTENT_PURPOSE } from "../../idd-core/src/plan/prompt-text.ts";
import { ACTION_AND_FREQUENCY, NO_STATUS_REPORT, NO_STATUS_REPORT_NEW_FINDINGS, REVIEW_WRITING_RULES } from "./stage-basis.ts";
import { ACTION_RULES, FEEDBACK_ACTION_RULES, JUDGE_SEVERITY_RULES, REVIEW_ACTION_RULES, SEVERITY_RULES, SEVERITY_RULES_WINDOW, VERDICT_RULES, VERDICT_RULES_FEEDBACK } from "../../idd-core/src/plan/review-rules.ts";
import { FIX_BASIS } from "../../idd-core/src/agent/port.ts";
import { addRecordlessCopy, addWorktree, manifestRowsAt, recordlessRows, removeWorktree, type RecordlessCopy } from "./worktree.ts";

export type ReviewStage = "blind" | "final" | "spec" | "triage" | "feedback" | "confirm" | "feedback_confirm" | "feedback_leftovers" | "device" | "map" | "fix_plan" | "shape";

/** which pipeline slot runs each stage (roles.yaml pipeline.<slot>) */
export const STAGE_SLOT: Record<ReviewStage, string> = {
  blind: "review_blind",
  final: "review_blind",
  spec: "spec_check",
  triage: "triage",
  feedback: "triage",
  feedback_leftovers: "triage",
  confirm: "confirm",
  feedback_confirm: "confirm",
  device: "device_check",
  map: "risk_map",
  fix_plan: "fix_plan",
  shape: "shape_judge",
};


/**
 * The stages whose copy has the records taken out (C-223-1): the readers that must not know the implementer's frame.
 * The spec check, the confirm and the device check read a copy with the records, since their inputs are the records.
 */
const RECORDLESS = new Set<ReviewStage>(["blind", "final"]);

/** the stages that judge findings: they read the lane's worktree and write the triage format */
const JUDGING = new Set<ReviewStage>(["triage", "feedback", "feedback_leftovers"]);
/** the stages that only read: they run in the lane's worktree instead of a copy of their own */
const READ_ONLY = new Set<ReviewStage>([...JUDGING, "map", "fix_plan", "shape"]);

/**
 * The stages whose briefs list the repo's checks by name: the stages that read the diff and may have to run a
 * long check themselves. A triage or a map decides from the code it reads, so it gets no list.
 */
const CHECKS_STAGES = new Set<ReviewStage>(["blind", "final", "spec", "confirm", "feedback_confirm"]);

/** how every confirm checks, whatever it is handed */
const CONFIRM_CHECK = [
  "境目の一覧（boundaries-<巡>.md、あれば）の ref も、penne が決めた境目にコードと記録（decision.md など）が揃ったかを判定し、ref をそのまま使って items に入れる。items に無い境目の ref は揃っていないものとして扱われる。",
  "作者の主張や修正の説明は鵜呑みにせず、コードとコマンドで確かめる。数えられるものは数え直す。",
  "修正で新しく入った問題があれば new_findings に書く。確かめるために入れた変更は必ず戻す。",
].join("\n");

/**
 * The line the two stages that read the whole diff are given: each finding says how to fix it. The reviewer is the
 * one who read the diff, so its how-to-fix is written in the same session; the implementer is the one who reads it,
 * after the judgement has decided which findings are fixed at all (C-197-1, C-197-3).
 */
const HOW_RULE = [
  "各指摘に how（どう直すか）を付ける。how は、この指摘を直す実装役が読んで動けるだけの文で、触る場所、変える振る舞い、壊してはいけない不変を、今の差分と規約だけで分かる範囲で書く。",
  "手段が決められないときは、何を満たせば直ったことになるかを書く。nit でも省かない。",
].join("\n");

/**
 * The shape judge's task, the one definition both of its stages read (C-252-1): the plan stage hands it the plan and the
 * Choices and reads its findings, the stopped round hands it also the lane's per-round lines (rounds.md) and reads
 * its recommendation. What changes between the stages is the input and where the answer goes, never this text.
 */
export const SHAPE_TASK = [
  "lane の計画（inputs の plan.md と契約の Choice のファイル）が、実装を巡ごとに収束させる「形」をしているかを判断する。形とは、同じ事実を決める場所の数と、変更が計画の触る範囲に収まるかである。文面の良し悪しと依頼として成立しているかは見ない（計画の査読の仕事）。",
  "形の誤りの典型は 3 つ。1. 同じ事実（指し先・状態・設定の値）を 2 か所以上が決めていて、片方を直すともう片方と食い違う。2. 1 つの変更が計画の触る範囲の外の file にまで及ぶ。3. 巡ごとに同じ類の穴が別の経路に出続ける（根は 1 つで、穴だけが毎巡違う場所に出る）。疑った点は現物のコード（この worktree）で確かめる。",
  "inputs に rounds.md（巡ごとの行。台帳から機械で作った値）が無いときは計画の段である。形の誤りを findings に書く。このまま実装すると巡が収束しない誤りだけ must、直したほうがよい程度は should。誤りが無ければ findings は空にする。recommendation は null にする。",
  "rounds.md があるときは、巡が止まった段（または収束しない症状が出た巡）である。findings は空にし、recommendation を書く。choice は continue（このまま直し続ける）・accept（受け入れて後に回す）・replan（計画から考え直す）の 1 つ。reasons の各行は rounds.md にある値のどれかを ref に名指す: round は巡の番号、accepted は受理した must / should の数がある巡の番号、file は指摘が名指した file、outside は計画の範囲の外に出た file、changed は報告した変更 file の数がある巡の番号。rounds.md に無い巡・file を ref に書かない。根拠の文は書かない（ref の指す台帳の値から作られる）。choice が replan のときは shape に必ず、同じ事実の持ち主をどこ 1 つにするかなど、計画の組み直し方を書く。",
  "推奨は人の答えを置き換えない。コードも文書も変更しない。",
].join("\n");

/** the line handed to both lanes' judgements: the repo's own examples of harm are read against the table, never added to */
const HARM_EXAMPLES_RULE = "入力にこの repo の害の例（harm-examples-*.md）があれば、何が害でどの等級かの判断に使う。engine の表の一般の定義に当てて重さを決め、例を自分で足さない。";

/**
 * The line between a bridge and a compatibility that keeps a contract. The contract list is the repo's own
 * (`config/repos.yaml` `contracts`), so a branch is judged against that list, never by its looking like a compatibility.
 */
const SOLVING_CONTRACT_BOUNDARY = "契約を保つための互換の分岐は橋渡しではなく、P5 の側にある。指摘にも must にもしない。契約は、`config/repos.yaml` の `contracts` に載るもの、および宣言が無くても契約になるもの（`_docs/standards/solving.md` の「契約」）である。分岐がどの契約を保つかを、その一覧の項目で確かめる。台帳の古い記録を読む分岐が代表例である。どの契約も保たない互換の分岐は、旧新の併存として橋渡しに数える。";

/**
 * The solving standard as the diff's readers hold it. The principle's body is `_docs/standards/solving.md`, opened
 * from the tree the reader has, and is named here by number only. A reader without the records cannot see whether an
 * old form was recorded as a stopgap, so it points at the bridge by number and leaves the record to a later stage.
 */
const SOLVING_DIFF_RULE = [
  "規約の `_docs/standards/solving.md` を開いて読み、差分が課題を原因ではなく迂回や橋渡しで満たしていないかを、P1・P4 を根拠に見る。",
  "見つけたら、根拠の P 番号（P1・P4・P7）を claim に書いて指摘にする。記録の有無は別の段が決めるので、気づいた迂回・橋渡しは指摘にする。" + SOLVING_CONTRACT_BOUNDARY,
].join("\n");

/** the spec check's fourth look: it reads the Choices, so it can tell a recorded stopgap from an unrecorded one */
const SOLVING_SPEC_RULE = "4. 旧い形を残した差分（`_docs/standards/solving.md` の橋渡し・応急処置）が、応急処置の Choice を持つか。Choice は R9 の記録を持ち、revisit が後続の Issue を指す。持たないものは P 番号（P1・P4・P7）を根拠に指摘にする。" + SOLVING_CONTRACT_BOUNDARY;

/** the same look for a lane in the old record form: it has no Choice to look for, so a stopgap is a note on its place */
const SOLVING_SPEC_RULE_DOCS = "4. 旧い形を残した差分（`_docs/standards/solving.md` の橋渡し・応急処置）が、後続の Issue の案（`idd out draft --kind gh-issue` で起こしたもの。lane の報告の side_findings が指す）の本文に R9 の記録を持つか。場所に付いた指摘は後続の Issue の代わりにならない。無いものは P 番号（P1・P4・P7）を根拠に指摘にする。" + SOLVING_CONTRACT_BOUNDARY;

/**
 * The scope look's exception: a lane that owns its scope solves by the cause (P1), and the cause can lie outside the
 * plan's list of places to touch. The check reads the code, not the implementer's report, so it decides by the code.
 */
const SOLVING_SCOPE_RULE = "ただし、課題の原因に届くために必要な計画の範囲外の変更（所有の範囲の中で、原因の側を直すもの）は、範囲を越えたとしない。必要かどうかはコードで確かめる。原因と関係の無い作り直しや広がりだけは、`_docs/standards/solving.md` の P2・R11 を根拠に指摘にする。";

/**
 * What the judgement may take as a follow-up Issue draft: only one that is in the list the harness hands it. The list
 * is written even when there is no draft, so "none" is told apart from "no list". A pointer in a record or a report to a
 * draft the list does not show is not the draft.
 */
const SOLVING_TRIAGE_DRAFT_LIST = "一覧が「なし」のとき、一覧に案が無いとき、一覧が入力に無いときは、記録や報告が後続の Issue を指していても案の実在を確かめられないので、reject にしない。";

/** the judgement's rule: it reads the contract, so it decides whether an old form is a recorded stopgap */
const SOLVING_TRIAGE_RULE = "差分が迂回・橋渡し・旧い形の残りを足しているという指摘（`_docs/standards/solving.md` の P1・P4・P7）は、契約（Choice）に応急処置として記録されているかで決める。reject にできるのは、R9 の記録を持つ Choice の範囲に収まり、かつその revisit が指す後続の Issue の案が、入力の後続案の一覧（followup-issues-*.md。この lane が起こした案を、投稿前のものも含めて並べたもの）に実在するものだけで、理由にその Choice の id と案の id を引く。R9 の記録は Choice が持つので、案の本文に同じ記録を重ねては求めない。" + SOLVING_TRIAGE_DRAFT_LIST + "revisit が後続の Issue を指さない Choice は記録の不備として扱い、reject にしない。記録の無いもの、記録の不備のもの、案が確かめられないもの、記録が範囲を越えるもの、応急処置を原因による解決と呼んでいるものは、頻度に関わらず must にする。" + SOLVING_CONTRACT_BOUNDARY;

/** the same rule for a lane in the old record form: the stopgap is a note on its place that points at the follow-up Issue */
const SOLVING_TRIAGE_RULE_DOCS = "差分が迂回・橋渡し・旧い形の残りを足しているという指摘（`_docs/standards/solving.md` の P1・P4・P7）は、後続の Issue の案（`idd out draft --kind gh-issue`）に応急処置として書かれているかで決める。案は入力の後続案の一覧（followup-issues-*.md。この lane が起こした案を、投稿前のものも含めて並べたもの）で確かめる。reject にできるのは、一覧に、R9 の記録を本文に持つ案が実在し、その範囲に収まるものだけで、理由にその案の id を引く。" + SOLVING_TRIAGE_DRAFT_LIST + "後続の Issue の案が無いもの（場所に付いた指摘や lane の報告の記述だけのものを含む）は記録の不備として扱い、reject にしない。案が無いもの、記録の不備のもの、案が確かめられないもの、案の範囲を越えるもの、応急処置を原因による解決と呼んでいるものは、頻度に関わらず must にする。" + SOLVING_CONTRACT_BOUNDARY;

export const STAGE_TASK: Record<ReviewStage, string> = {
  // a cheap read-only pass before the blind round of a large diff: where to look, not what is wrong
  map: MAP_TASK,
  blind: [
    "この差分をレビューする。与えられるのは差分と規約と、利用者の方針（brief に節があるときだけ）で、実装者の意図や前回までのレビューは渡さない。方針は利用者自身の恒久の好みで、実装者の枠組みではない。",
    "疑った点は読むだけで終えず、コマンドで確かめる（旧実装へ戻す、変異を入れる、テストを走らせる）。確かめるために入れた変更は必ず戻す。",
    "実行したコマンドと終了コードを runs に書く。",
    SOLVING_DIFF_RULE,
    REVIEW_WRITING_RULES,
    SEVERITY_RULES,
    ACTION_AND_FREQUENCY,
    HOW_RULE,
  ].join("\n"),
  final: [
    "修正を重ねた後の差分全体を、初めて見るつもりでレビューする。与えられるのは差分と規約と、利用者の方針（brief に節があるときだけ）。",
    "修正同士の干渉と、修正で新しく入った退行を特に見る。疑った点はコマンドで確かめ、入れた変更は必ず戻す。",
    SOLVING_DIFF_RULE,
    REVIEW_WRITING_RULES,
    NO_STATUS_REPORT,
    SEVERITY_RULES,
    ACTION_AND_FREQUENCY,
    HOW_RULE,
  ].join("\n"),
  // the spec check reads the records the blind is kept from: the plan, the criteria, the Choices and the Purposes
  // decide what it looks for (C-223-2). It is never told what an earlier round found or fixed
  spec: INTENT_PURPOSE + "\n" + [
    "この差分が、計画（plan.md）・受け入れ条件（qa.md）・この lane の Choice と Purpose に照らして満たしていない所と壊している所を、自分から探す。差分の中で目立つ所からではなく、計画と受け入れ条件と Choice の側から、差分に現れているかを確かめる。",
    "入力は、plan.md、qa.md、lane の Choice（chosen・why・anchored）、lane の Purpose、repo の概要。差分は lane の変更の全体で、前の巡の指摘と前の巡の修正の一覧は渡されない。この巡の差分だけから判断する。",
    "人が決めた線引き（human-lines-*.md、あれば）にある、人が見送る・後に回すと決めた指摘と境目は、計画と同じくこの lane の仕様として読み、同じ性質の指摘を出さない。",
    "人が決めた線引きにある、判定が人に尋ね人が答えた問いの答えも、計画と同じくこの lane の仕様として読み、答えと逆を求める指摘を出さない。答えは、その問いに答えた部分だけを読み、問いの外の部分は答えとして読まない。答えを、それ以外の指摘を出す根拠にも出さない根拠にもしない。",
    "見るのは 4 つ。1. 受け入れ条件（AC）ごとに、主な経路で満たしているか。コードとコマンドで確かめ、実装者の報告や記録の言い分を根拠にしない。2. 差分が lane の Choice の anchored と why に反していないか、既存の active な Choice の why と逆向きの実装になっていないか。3. 計画の「守ること」と「触る範囲」を越えていないか。" + SOLVING_SCOPE_RULE + SOLVING_SPEC_RULE,
    "重さの基準は判定と同じ。既存の active な Choice の why と逆向きの実装と、主な経路の AC 未達は、頻度に関わらず must にする。まれな分岐の AC 未達は should。unconfirmed の Choice との食い違いは should 止まりで、must の根拠にしない。",
    "疑った点はコマンドで確かめる（旧実装へ戻す、変異を入れる、テストを走らせる）。確かめるために入れた変更は必ず戻す。実行したコマンドと終了コードを runs に書く。",
    "コードの出来や書き方の好みは見ない。それは差分だけを読む別の読み手の仕事。満たしていない所と壊している所だけを指摘にし、満たしている AC は指摘にしない（見なかった範囲に書く）。",
    REVIEW_WRITING_RULES,
    SEVERITY_RULES,
    ACTION_AND_FREQUENCY,
    HOW_RULE,
  ].join("\n"),
  // the Issue lane's judgement reads the records, so the purpose is part of the stage's own task:
  // `stageTask` hands back this same text whatever the loop's policy, which is what the policy tests pin
  triage: INTENT_PURPOSE + "\n" + [
    "入力は、この差分に対する複数のレビューの指摘（JSON）と、実装の指示（decision.md / qa.md）。他人の PR では、実装の指示の代わりに PR の本文・コメント・既存のレビューが渡る。既に誰かが指摘済みのものは reject にして、理由に「既出」と書く。",
    "同じ内容の指摘は 1 件にまとめ、ref を F-1 から振る。各指摘を現物のコードで確かめ、verdict と severity を決める。",
    VERDICT_RULES,
    "入力の指摘には、指摘者の付けた重さ・推奨の対応・頻度が付いていない。severity は、現物で確かめた影響を、害と頻度の表に当てて決める。",
    "各判定に from（元の指摘が載った入力の report.json の親ディレクトリ名。まとめた指摘は全部）を書く。",
    JUDGE_SEVERITY_RULES,
    SEVERITY_RULES_WINDOW,
    "入力の triage-history に「penne の訂正」があれば、それは人が指摘ごとに決めた重さと対応で、以後の巡でも変えない。訂正済みの指摘と同じ性質の指摘（場所や語が違っても、claim が同じ問題を言っているもの）は受理せず、rejected に入れて reason に訂正の ref を引く。同じ性質かは claim を読んで決め、同じ箇所でも逆向きの要求なら同じ性質ではない。往復と訂正が食い違うときは訂正に従う。受理に残す指摘が訂正済みと同じ性質のときだけ、correction_ref に訂正の ref を書く。",
    "入力の triage-history に「penne が答えた判定の問い」があれば、それは前の判定が escalate で人に尋ね、人が答えた仕様の判断である。答えた問いと同じことを尋ねる問いを再び escalate にせず、答えをこの lane の仕様として受理か棄却かを決める。答えは、その問いに答えた部分だけを読み、問いの外の部分は答えとして読まない。答えを、それ以外の指摘を受理する根拠にも棄却する根拠にもしない。",
    "前の巡の修正が解けたかは確かめない。直っていないものは、この巡の差分から見つかったときだけ指摘になる。",
    HARM_EXAMPLES_RULE,
    SOLVING_TRIAGE_RULE,
    "入力に AC の状態（ac-states-*.md）があれば、主な経路で受け入れ条件を満たしているかを確かめ、満たさない指摘は頻度に関わらず must にする。",
    "accept の must / should には impact（誰に・どの操作や状況で・何が起きるか）を具体的に書く。書けないものは nit にする。ただし上の窓は、想定の操作と状態で impact を書き、再現していないことを理由に nit にしない。",
    "推奨の対応は、現物で確かめた重さと頻度から決め、受理した各指摘の action（fix = この変更で直す / followup = follow-up / skip = 見送り）に書く。",
    ACTION_RULES,
    "fix は must / should にだけ、「何を満たすべきか」を目的で書く（手段は指定しない）。",
    "コードも文書も変更しない。",
  ].join("\n"),
  feedback: [
    "入力は、この差分で出した Pull Request に届いたレビュアーの指摘と CI の失敗（feedback.md、各項目に C-<連番> の ref がある）と、実装の指示（decision.md / qa.md）。",
    "decisions は入力の項目ごとに 1 件、ref は入力の C-<連番> をそのまま使う。1 項目に複数の要望があれば 1 件の claim にまとめる。要望のない項目（要約・挨拶・承認だけのもの）は reject にして no_request を true にする（返信を作らない）。",
    "各項目を現物のコードで確かめ、verdict を決める。",
    VERDICT_RULES_FEEDBACK,
    "CI の失敗は、ログからこの差分が原因かを確かめる。原因なら accept（severity は must）、差分と無関係な失敗なら reject にして理由にログの根拠を書く。",
    SEVERITY_RULES,
    SEVERITY_RULES_WINDOW,
    FEEDBACK_ACTION_RULES,
    "コードも文書も変更しない。",
  ].join("\n"),
  // after a confirm of PR feedback left something open: what is left of a reviewer's request is fixed whatever its severity
  feedback_leftovers: [
    "入力は、PR に届いた指摘への修正を確かめた確認の報告（JSON）と、確認が報告しなかった指摘の一覧（confirm-<巡>-missing.md、あれば）、それまでの判定の報告、実装の指示（decision.md / qa.md）。",
    "確認で未解消とされた項目、missing の一覧の項目、確認の new_findings を、同じ内容は 1 件にまとめ、ref は、レビュアーの指摘に由来するものは元の C-<連番> を保ち、確認で新しく見つかった問題は N-<連番> を振る。1 件ずつ判定する。missing の一覧の項目は、確認が報告せず、解消を確かめていないもの。現物のコードで確かめて決める。",
    VERDICT_RULES_FEEDBACK,
    SEVERITY_RULES,
    SEVERITY_RULES_WINDOW,
    FEEDBACK_ACTION_RULES,
    "コードも文書も変更しない。",
  ].join("\n"),
  confirm: [
    "入力は、確かめる指摘の一覧（confirm-<巡>.md）と、その判定の報告。一覧が渡されないとき（他人の PR の査読 lane）は、判定の報告にある受理の ref を一覧とする。",
    "最新の差分で、一覧の ref だけを、ref ごとに解消したか判定する。一覧にない指摘は items に入れない。",
    "items に無い ref は解消していないものとして扱われる。",
    NO_STATUS_REPORT_NEW_FINDINGS,
    SEVERITY_RULES,
    ACTION_AND_FREQUENCY,
    CONFIRM_CHECK,
  ].join("\n"),
  // after a fix of feedback on the lane's own PR: the confirm checks the refs the judgement sent to the fix
  feedback_confirm: [
    "入力は、確かめる指摘の一覧（confirm-<巡>.md）と、それを受理した判定の報告（PR に届いた指摘の判定と、その後の判定）。",
    "inputs の list にある ref をすべて、最新の差分で解消したか判定して items に書く。list は判定が fix にした指摘の一覧。severity によらず確かめ、ref をそのまま使って 1 件ずつ入れる。list にない指摘は items に入れない。",
    "items に無い ref は解消していないものとして扱われ、レビュアーへの返信で「直した」と書かれない。",
    NO_STATUS_REPORT_NEW_FINDINGS,
    SEVERITY_RULES,
    CONFIRM_CHECK,
  ].join("\n"),
  device: [
    "入力の全体 1 文（qa.md の全体の行）と、compare/ の絵の組（実装の絵と prototype の絵）を read で 1 枚ずつ開いて見比べる。",
    "絵は必ず開いて実際に見る。開けない・見えない絵があれば、その事実を must として報告する。見ていないものを「見た」と書かない。",
    "違いは findings に severity（must / should / nit）と、どの画面のどこがどう違うかの文で書く。違いが無ければ findings を空にし、見た絵を report.md に並べる。",
    "コードも文書も変更しない。読んで見比べるだけ。",
  ].join("\n"),
  // the one-off run the delivery slips in before a fix reaches a new executor session: it reads and writes a plan, never the code
  shape: SHAPE_TASK,
  fix_plan: [
    "届ける修正の指示（inputs の指示のファイル）と、lane の差分・契約（decision.md / qa.md）・lane の重要なコンテクストの文書（context.md、あれば）・前の巡の修正の一覧（あれば）を読み、実装役が何をどう直すかを md 1 ファイルに整理する。",
    "コンテクストの文書（context.md）があれば、直し方や守る不変がそこに書かれた事実と食い違わないかを確かめる。この文書は読むだけで、追記しない。",
    "書くもの: 1. 直し方（1 段落。設計の判断をここで決める） 2. 触るファイルと関数 3. 守る不変（lane の INV と、前の巡の直しのうち今回の直しが崩しうるもの） 4. 直さない指摘とその理由（あれば）。およそ 60 行まで。",
    "人が書いた文（instruction・user-note）は言い換えず、前提として扱う。",
    "コードも文書も変更しない。読んで整理するだけ。",
  ].join("\n"),
};

/** the line handed to a judgement whose inputs list the follow-ups already written into the TODO */
const EXISTING_FOLLOWUPS_RULE = "inputs に、この lane が既に TODO に書いた follow-up の一覧（path と claim）があれば、そこにある指摘と同じ内容は既出として扱い、follow-up にしない。";

/** the final review of only the fixes since the last review round (`review_final.scope: increment`) */
const FINAL_INCREMENT_TASK = [
  "前回のレビューの後に入った修正だけを、初めて見るつもりでレビューする。与えられるのは差分と規約と、利用者の方針（brief に節があるときだけ）。",
  "差分と、差分が触る関数・型の呼び手まで読む（呼び手は grep で探す）。修正で新しく入った退行と、修正が呼び手の前提を崩していないかを特に見る。疑った点はコマンドで確かめ、入れた変更は必ず戻す。",
  SOLVING_DIFF_RULE,
  REVIEW_WRITING_RULES,
  NO_STATUS_REPORT,
  SEVERITY_RULES,
  ACTION_AND_FREQUENCY,
  HOW_RULE,
].join("\n");

/** the conflict round's solving look, kept apart so a review lane (someone else's PR) can have it taken out of the task */
const SOLVING_CONFLICT_RULE = "解消の hunk に、迂回や橋渡しが入っていないかも、規約の `_docs/standards/solving.md` を開いて見る。見つけたら根拠の P 番号（P1・P4・P7）を claim に書く。範囲は解消の hunk に限る。" + SOLVING_CONTRACT_BOUNDARY;

/** the first round after a mainline merge that resolved a conflict (`review_loop.after_merge: conflict`) */
const CONFLICT_TASK = [
  "本流を lane に merge したときに衝突を解いた箇所だけをレビューする。与えられるのは merge の解消（`git show --cc`）と規約だけ。",
  "両方の親と違う hunk が解消の結果。どちらかの側の変更を落としていないか、両方の意図が合わさって壊れていないか（引数・import・識別子の欠け、重複、つながった行）を見る。解消した関数の呼び手と、本流側でその関数に入った変更も読む。",
  "疑った点はコマンドで確かめ、入れた変更は必ず戻す。",
  SOLVING_CONFLICT_RULE,
  REVIEW_WRITING_RULES,
  SEVERITY_RULES,
  ACTION_AND_FREQUENCY,
  HOW_RULE,
].join("\n");


/**
 * The review lane's judgement: the same shape as the Issue lane's, but it also decides what reaches the author
 * (report) and what is asked of this PR (action). Only the musts and the chosen shoulds go into the review body.
 */
const REVIEW_LANE_TRIAGE_TASK = [
  "入力は、この PR に対する複数のレビューの指摘（JSON）と、PR の本文・コメント・既存のレビュー（pr-context）。複数の指摘を 1 件ずつ現物のコードで確かめ、正しいか・作者に伝える価値があるか・この PR で直してもらうか別の Issue にするかを決める。",
  "同じ内容の指摘は 1 件にまとめ、ref を F-1 から振る。",
  "PR の本文・コメント・既存のレビュー（pr-context）で既に誰かが指摘済みのものは reject にして、理由に「既出」と書く。",
  "入力の指摘には、指摘者の付けた重さ・推奨の対応・頻度が付いていない。severity は、現物で確かめた影響を、害と頻度の表に当てて決める。",
  "各判定に from（元の指摘が載った入力の report.json の親ディレクトリ名。まとめた指摘は全部）を書く。",
  VERDICT_RULES,
  "accept の must / should には impact（誰に・どの操作や状況で・何が起きるか）を具体的に書く。書けないものは nit にする。",
  "fix は作者への提案として「何を満たすべきか」を目的で書く（手段は指定しない）。",
  JUDGE_SEVERITY_RULES,
  SEVERITY_RULES_WINDOW,
  "他人の PR には受け入れ条件・qa.md・Choice が渡らないので、表の中でそれらに当たる行は使わない。",
  HARM_EXAMPLES_RULE,
  REVIEW_ACTION_RULES,
  "コードも文書も変更しない。",
].join("\n");

/**
 * The fixed task of a stage, with what the round is shown (the fixes since the last review, a merge's resolution),
 * the loop's policies the engine said it runs under (a pass that closes on musts alone, the follow-ups already
 * written), and which lane the stage runs in (a review lane judges for the author).
 * Without them every stage gets its usual task, as someone else's PR (a review lane) always does.
 */
export function stageTask(stage: ReviewStage, opts: { scope?: "increment" | "conflict"; laneKind?: "issue" | "review"; existingFollowups?: boolean; hasPlan?: boolean; recordsShape?: "docs" | "state" } = {}): string {
  const base = opts.scope === "conflict" && (stage === "blind" || stage === "final") ? CONFLICT_TASK
    : opts.scope === "increment" && stage === "final" ? FINAL_INCREMENT_TASK
      : stage === "triage" && opts.laneKind === "review" ? REVIEW_LANE_TRIAGE_TASK
        : STAGE_TASK[stage];
  // the Issue lane's judgement is one of the stages that reads the records, so it carries the purpose (DEC-2641)
  // The task lives in STAGE_TASK.triage already, so the same policy answer comes back with and without options.
  const v2 = opts.recordsShape === "state";
  const choice = v2 ? "Choice のファイル / qa.md" : "decision.md / qa.md";
  let task = base;
  if (v2) {
    // a v2 lane reads the drawn Choices and the qa, not decision.md: the same replacement for every stage that names it
    task = task
      .replaceAll("実装の指示（decision.md / qa.md）", `実装の指示（${choice}）`)
      .replaceAll("契約（decision.md / qa.md）", `契約（${choice}）`)
      .replaceAll("記録（decision.md など）", "記録（Choice のファイルなど）")
      .replaceAll("lane の INV", "lane の Choice の anchored");
  }
  if (stage === "spec" && opts.recordsShape === "docs") {
    // a v1 lane has decision.md where a v2 lane has Choices and Purposes: the check is told the file it is given
    task = task
      .replace("この lane の Choice と Purpose に照らして", "この lane の decision.md に照らして")
      .replace("lane の Choice（chosen・why・anchored）、lane の Purpose、repo の概要", "decision.md（この lane の決定と制約。Choice と Purpose のファイルは渡されない）、repo の概要")
      .replace("差分が lane の Choice の anchored と why に反していないか", "差分が decision.md の決定と制約に反していないか")
      .replace("計画と受け入れ条件と Choice の側から", "計画と受け入れ条件と decision.md の側から");
  }
  if (opts.laneKind === "review" && (stage === "blind" || stage === "final")) {
    // someone else's PR is not held to this harness's standard, and its tree may not have solving.md at all (DEC-792)
    task = task.replace(`${SOLVING_DIFF_RULE}\n`, "").replace(`${SOLVING_CONFLICT_RULE}\n`, "");
  }
  if (opts.recordsShape === "docs") {
    // an old-form lane has no Choice: the stopgap look and the judgement read the follow-up Issue's draft the lane raised
    task = task.replace(SOLVING_SPEC_RULE, SOLVING_SPEC_RULE_DOCS).replace(SOLVING_TRIAGE_RULE, SOLVING_TRIAGE_RULE_DOCS);
  }
  if (stage === "triage" && opts.laneKind !== "review" && opts.hasPlan) {
    task = task.replace(`実装の指示（${choice}）`, `実装の指示（plan.md があればそれと、${choice}）`);
  }
  return opts.existingFollowups ? `${task}\n${EXISTING_FOLLOWUPS_RULE}` : task;
}

interface RunMeta {
  lane_id: string;
  stage: ReviewStage;
  role: string;
  copy?: string;
  /** the lane worktree the copy was cut from; removal runs from there */
  source?: string;
  repo?: string;
  cleaned?: boolean;
  /** the stage's Claude Code role was refused for the windows and `role` ran in its place */
  quota_fallback?: QuotaFallback;
}

function runsDir(): string {
  const dir = join(laneStateDir(), "..", "pipeline", "review-runs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function saveMeta(meta: RunMeta): void {
  writeFileSync(join(runsDir(), `${meta.lane_id}.json`), `${JSON.stringify(meta, null, 2)}\n`);
}

function readMeta(laneId: string): RunMeta | null {
  const p = join(runsDir(), `${laneId}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as RunMeta) : null;
}

/**
 * The repo a copy is cut from: the lane's own worktree (so unpublished commits exist), with the
 * repo's setup and copied files when config/repos.yaml knows it. No fetch — the head is local.
 */
function copySource(worktree: string, base = "HEAD"): LaneRepo {
  return copyRepoOf(repoForPath(worktree, readLaneRepos()), worktree, base, join(laneStateDir(), "..", "pipeline", "review-wt"));
}

function copyRepoOf(known: LaneRepo | null, worktree: string, base: string, reviewRoot: string): LaneRepo {
  return {
    name: known?.name ?? "lane",
    clone: worktree,
    // the lane's own start commit always exists in its worktree; the repo's default base may not
    base,
    remote: "",
    reviewRoot,
    copy: known?.copy ?? [],
    setup: known?.setup ?? [],
    checks: known?.checks ?? [],
    work: known?.work ?? worktree,
    lanesRoot: known?.lanesRoot ?? worktree,
  };
}

const REVIEW_RULE_FILES = ["AGENTS.md", "AGENTS.override.md"];

/**
 * The rule files a stage reads first: the repo's own entry files, then the `.claude/rules` that apply
 * to the diff, both as the base has them (`laneRules`, which never throws). No stage is handed a rule the
 * overlay manifest names, and its text is not written under `out`: the manifest marks what the harness
 * manages, so the repo's own conventions are what is left to read. For a stage kept from the records
 * (blind, final) the copy has the record taken out too, so a path outside it would also be the way back in.
 * `rows` are the manifest rows the copy is cut by; without them they are read from head and base.
 */
export function stageRules(worktree: string, base: string, head: string, out: string, rows?: string[]): RuleSelection {
  const omit = rows ?? manifestRowsAt(worktree, [head, base]);
  return laneRules({ repo: worktree, base, head, out, files: REVIEW_RULE_FILES, omit });
}

/** Where the diff a stage's run shows starts: the spec check reads the lane's whole change (`laneBase`), every other stage the round's (`base`). */
function diffStart(stage: ReviewStage, opts: { base: string; laneBase?: string }): string {
  return stage === "spec" ? opts.laneBase ?? opts.base : opts.base;
}

export interface StartReviewOptions {
  iddId: string;
  stage: ReviewStage;
  round: number;
  worktree: string;
  base: string;
  head: string;
  inputs: string[];
  /** blind / final: the routes a map found, each of which gets a blind of its own next to a whole-diff one */
  routes?: RiskRoute[];
  /** an Issue lane's points where the harness's rules come before the repo's, handed to every run as knowledge */
  norms?: string[];
  /** the IDD norms the lane ran under, handed to every run as knowledge (not an override of the repo's norms) */
  iddNorms?: string[];
  /** blind / final: which of review_blind's extra role lists this round adds to its roles */
  extras?: ("first_round" | "high_risk")[];
  /** blind / final: how many roles to run, counted from the top (the lane's depth); all when left out */
  roleCount?: number;
  /** final: run only the slot's high-risk extra role (a deep lane's last review) */
  onlyHighRisk?: boolean;
  /** blind / final: `increment` reads only the fixes since the last review, `conflict` only the hunks `merge` resolved */
  scope?: "increment" | "conflict";
  /** the merge commit whose resolution a conflict round reads, or a mainline merge among an increment's fixes */
  merge?: string;
  /** increment: where the lane's whole change starts, so its file names go with the brief */
  laneBase?: string;
  /** triage of a pass that closes on musts alone: shoulds are left for a follow-up by default */
  shouldDefault?: "fix" | "followup";
  /** triage of a conflict scope round: the inputs list the follow-ups already written, so they are not reported again */
  existingFollowups?: boolean;
  /** a Claude Code role that must not be swapped for its fallback (a High lane's final): it waits for the windows */
  noFallbackRoles?: string[];
  /** blind / final: the repo's overview (the top-level Purpose's statement), handed to the reviewer */
  overview?: string;
  /** which lane the stage runs in: a review lane's triage and an Issue lane's share the stage name */
  laneKind?: "issue" | "review";
  /**
   * blind / final: the spec check this round starts beside its blinds, on the same head: how many of the spec_check
   * slot's runs (the depth table's count) and the records they read. Without it the round starts no spec check.
   */
  spec?: { count: number; inputs: string[] };
  /** the lane has a work instruction (`plan.md`): the Issue lane's judgement names it among the instructions (DEC-2643) */
  hasPlan?: boolean;
  /** the lane's record shape: a v2 lane's judgement reads Choices, not decision.md (DEC-119-6) */
  recordsShape?: "docs" | "state";
}

/** one run of a stage: which role, what it looks at first, and the files its diff is scoped to */
export interface RunPlan {
  /** empty for a stage's usual runs; r<n> / rest in a routed round */
  label: string;
  role: string;
  /** the model definition the run uses; absent when the stage names none (the role's own model is used) */
  model?: string;
  /** the thinking this pair runs with */
  thinking?: string;
  focus: string[];
  paths?: string[];
  /** a routed round's whole-diff blind: the round is judged when this run finished (C-152-7) */
  wholeDiff?: boolean;
  /** the stage this run is when it differs from the round's: the spec check runs beside a blind */
  stage?: ReviewStage;
}

/** the label the spec check's runs carry in the round's record: the fold tells them from the blinds by it */
export const SPEC_LABEL = "spec";

/** the runs of a round's spec check: the slot's first `count` runs, each read over the whole lane diff */
export function specRunPlans(slot: PipelineSlot, count: number): RunPlan[] {
  return slot.runs.slice(0, Math.max(0, count)).map((run) => ({ label: SPEC_LABEL, stage: "spec" as const, role: run.role, ...(run.model ? { model: run.model } : {}), ...(run.thinking ? { thinking: run.thinking } : {}), focus: [] }));
}

/** the roles a blind round runs: the slot's roles (a conflict scope round the first one only), then the extras the round adds, each once */
export function blindRoles(slot: PipelineSlot, extras: StartReviewOptions["extras"] = [], opts: { conflict?: boolean } = {}): string[] {
  const out = opts.conflict ? slot.roles.slice(0, 1) : [...slot.roles];
  for (const x of extras) for (const r of (x === "first_round" ? slot.firstRoundExtra : slot.highRiskExtra) ?? []) if (!out.includes(r)) out.push(r);
  return out;
}

/**
 * The runs a blind round makes: the slot's runs (a conflict scope round the first one only), then the extras the
 * round adds. An extra is a role of its own, so it runs with its own model; a run of the same role and model is
 * not made twice.
 */
export function blindRuns(slot: PipelineSlot, extras: StartReviewOptions["extras"] = [], opts: { conflict?: boolean } = {}): StageRun[] {
  const out = opts.conflict ? slot.runs.slice(0, 1) : [...slot.runs];
  for (const x of extras) {
    const extra = x === "first_round" ? slot.extraRuns.first_round : slot.extraRuns.high_risk;
    for (const run of extra) if (!out.some((r) => r.role === run.role && r.model === run.model)) out.push(run);
  }
  return out;
}

/**
 * The copies the blind rounds may hold at once: as many lanes as review_blind's concurrency, each cutting every run a
 * round may cut (the slot's roles with the models it names, and the extras). The count is the runs, not the roles: a
 * role that runs with two models cuts two copies.
 */
export function blindCopyCap(roles: RolesFile): number {
  const slot = roles.pipeline.review_blind;
  return slot ? slot.concurrency * blindRuns(slot, ["first_round", "high_risk"]).length : 1;
}

/**
 * The most routes a routed round gives blinds of their own: pipeline.risk_map.max_routes, and never more than the
 * copies the blind cap leaves next to the whole-diff blind, so one routed round cuts no more copies than the cap allows.
 */
export function maxRoutesOf(roles: RolesFile): number {
  return Math.max(1, Math.min(roles.pipeline.risk_map?.maxRoutes ?? DEFAULT_MAX_ROUTES, blindCopyCap(roles) - 1));
}

/**
 * The runs a stage starts. A blind or final blind runs every role of its slot, and the extras the round adds, over
 * the whole diff; with the routes of a map it runs the routed round instead. Every other stage is one run of the slot's role.
 */
export function stageRunPlans(stage: ReviewStage, slot: PipelineSlot, opts: { routes?: RiskRoute[]; maxRoutes: number; leftovers?: string[]; extras?: StartReviewOptions["extras"]; conflict?: boolean; roleCount?: number; onlyHighRisk?: boolean }): RunPlan[] {
  if (stage === "blind" || stage === "final") {
    const all = blindRuns(slot, opts.extras, { ...(opts.conflict ? { conflict: true } : {}) });
    // the lane's depth takes the runs from the top; a list shorter than the count runs as it is. A depth-bearing
    // lane's last review runs the high-risk role alone (its whole point is the senior reader on the final tree).
    const high = slot.extraRuns.high_risk;
    const runs = stage === "final" && opts.onlyHighRisk
      ? (high.length ? high : all.slice(0, 1))
      : typeof opts.roleCount === "number" ? all.slice(0, Math.max(0, opts.roleCount)) : all;
    const routed = planRoutedBlind(opts.routes ?? [], runs, { cap: opts.maxRoutes, leftovers: opts.leftovers ?? [] });
    return routed.length ? routed : runs.map((run) => ({ label: "", role: run.role, ...(run.model ? { model: run.model } : {}), ...(run.thinking ? { thinking: run.thinking } : {}), focus: [] }));
  }
  if (stage === "map") return [{ label: "", role: slot.role, focus: mapFocus(opts.maxRoutes) }];
  const one = slot.runs[0];
  return [{ label: "", role: slot.role, ...(one?.model ? { model: one.model } : {}), ...(one?.thinking ? { thinking: one.thinking } : {}), focus: [] }];
}

/** the report format each stage's role has to write, since the loop reads its findings, decisions or places */
function reportWanted(stage: ReviewStage): string {
  if (JUDGING.has(stage)) return "triage";
  if (stage === "confirm" || stage === "feedback_confirm") return "confirm";
  if (stage === "map") return "map";
  if (stage === "fix_plan") return "fix_plan";
  if (stage === "shape") return "shape";
  return "review";
}

/** the lane spec of one run, as the pipeline and the CLI both write it */
function reviewSpec(o: { stage: ReviewStage; plan: RunPlan; title: string; worktree: string; base: string; head: string; inputs: string[]; rules: RuleSelection; report: string; setup?: string[]; norms?: string[]; iddNorms?: string[]; task?: string; merge?: string; increment?: boolean; laneKind?: "issue" | "review"; laneBase?: string; overview?: string; checks?: BriefCheck[]; injectLane?: string; lane?: string }): Record<string, unknown> {
  return {
    role: o.plan.role,
    ...(o.plan.model ? { model: o.plan.model } : {}),
    ...(o.plan.thinking ? { thinking: o.plan.thinking } : {}),
    title: o.title,
    stage: o.stage,
    ...(o.laneKind ? { lane_kind: o.laneKind } : {}),
    // the Issue lane this run's injection names when it looks Choices up; written only for the stages that get one
    ...(o.injectLane ? { inject_lane: o.injectLane } : {}),
    // the lane the run belongs to, for the instruction ledger: every stage run has one, whether or not it gets an injection
    ...(o.lane ? { lane: o.lane } : {}),
    worktree: o.worktree,
    diff: { base: o.base, head: o.head, ...(o.plan.paths?.length ? { paths: o.plan.paths } : {}), ...(o.merge ? { merge: o.merge } : {}), ...(o.increment ? { increment: true } : {}), ...(o.laneBase ? { laneBase: o.laneBase } : {}) },
    inputs: o.inputs,
    ...(o.overview ? { overview: o.overview } : {}),
    rules: o.rules.rules,
    ...(o.rules.warnings.length ? { rule_warnings: o.rules.warnings } : {}),
    ...(o.norms?.length ? { norms: o.norms } : {}),
    ...(o.iddNorms?.length ? { idd_norms: o.iddNorms } : {}),
    ...(o.checks?.length ? { checks: o.checks.map((c) => ({ name: c.name, ...(c.timeoutMinutes !== undefined ? { timeout_minutes: c.timeoutMinutes } : {}) })) } : {}),
    task: o.task ?? STAGE_TASK[o.stage],
    ...(o.plan.focus.length ? { focus: o.plan.focus } : {}),
    report: o.report,
    ...(o.setup?.length ? { setup: o.setup } : {}),
  };
}

/** the routes whose file list the diff touches (checked before a blind gets them) */
function changedRoutes(routes: RiskRoute[], worktree: string, base: string, head: string): RiskRoute[] {
  return routesInDiff(routes, new Set(diffPaths(worktree, base, head).paths));
}

// the spec check's label tells the fold its runs from the blinds, and the stage already names them in the directory
const runName = (plan: RunPlan) => `${plan.label && plan.stage !== "spec" ? `${plan.label}-` : ""}${plan.role}${plan.model ? `-${plan.model}` : ""}`;

/**
 * A directory of its own for every run. The round, stage and role alone do not tell runs apart: the round's
 * triage and the triage of its confirm's leftovers share them, as do a map run again after a send-back and a
 * stage started again after a failure. A shared directory would overwrite the report the record points at,
 * and a run that wrote nothing would be taken as done with the older report.
 */
function runDir(iddId: string, name: string): string {
  const parent = join(laneStateDir(), "..", "pipeline", "review", iddId);
  mkdirSync(parent, { recursive: true });
  for (;;) {
    const dir = join(parent, `${name}-${randomBytes(3).toString("hex")}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** why a diff gets no map (no pipeline.risk_map, below its min_lines, unreadable), or null when it does */
export function riskMapSkipReason(opts: { worktree: string; base: string; head: string }, roles = readRoles()): string | null {
  const slot = roles.pipeline.risk_map;
  if (!slot) return "pipeline.risk_map が未宣言";
  const copies = blindCopyCap(roles);
  if (copies < 2) return `blind の並列の上限（concurrency × roles = ${copies} 本）が 2 本未満で、経路ごとの blind を並べられない`;
  const min = slot.minLines ?? DEFAULT_MIN_LINES;
  const lines = diffLineCount(resolve(opts.worktree), opts.base, opts.head);
  if (lines === null) return "差分の行数を数えられない";
  if (lines < min) return `差分 ${lines} 行（閾値 ${min} 行未満）`;
  return null;
}

/**
 * The routes in the diff and the diff's files, with the overlay manifest's rows taken out of both. A route that passed
 * only through records is gone, and the ids of the rest are numbered again. Without rows nothing is taken out.
 */
export function withoutRecords(routes: RiskRoute[], changed: string[], rows: string[]): { routes: RiskRoute[]; changed: string[] } {
  const files = rows.length ? changed.filter((f) => !isOverlayPath(rows, f)) : changed;
  const kept = rows.length ? routes.map((r) => ({ ...r, paths: r.paths.filter((p) => !isOverlayPath(rows, p)) })).filter((r) => r.paths.length) : routes;
  return { routes: routesInDiff(kept, new Set(files)), changed: files };
}

/** what starting a stage's runs touches outside this module; tests hand in their own */
export interface ReviewRunDeps {
  addWorktree: typeof addWorktree;
  addRecordlessCopy: typeof addRecordlessCopy;
  removeWorktree: typeof removeWorktree;
  runLane: (specPath: string, opts: RunOptions) => Promise<Pick<LaneRecord, "id" | "role" | "quota_fallback">>;
  stopLane: (id: string) => unknown;
}

const REAL_DEPS: ReviewRunDeps = { addWorktree, addRecordlessCopy, removeWorktree, runLane, stopLane };

/**
 * Start a stage's runs. A map of a diff below pipeline.risk_map.min_lines starts nothing and says why in
 * `skipped`: the blind round then runs as it always did. Over Claude's windows, a Claude Code role with a
 * fallback runs as its fallback (listed in `fallbacks`); one without holds the stage, starting nothing.
 */
export async function startReviewRuns(opts: StartReviewOptions, deps: Partial<ReviewRunDeps> = {}): Promise<{ runIds: string[]; skipped?: string; wholeDiff?: string[]; fallbacks?: QuotaFallback[]; runRoles?: string[]; runLabels?: string[]; routeCount?: number; routesOverCap?: boolean }> {
  const roles = readRoles();
  const { slot } = resolvePipelineRole(STAGE_SLOT[opts.stage], roles);
  // the loop reads findings (and skipped) from these stages, so their role must write the review format
  const want = reportWanted(opts.stage);
  const blindish = opts.stage === "blind" || opts.stage === "final";
  // a conflict round without its merge would have nothing to show: it reads the whole diff instead
  const scope = opts.scope === "conflict" && !opts.merge ? undefined : opts.scope;
  // a conflict scope round reads only the merge's small resolution, so it runs the slot's first role (and a high-risk extra)
  const conflict = scope === "conflict";
  const stageRunsOf = blindish ? blindRuns(slot, opts.extras, { conflict }) : slot.runs;
  const highRuns = slot.extraRuns.high_risk;
  const limited = opts.stage === "final" && opts.onlyHighRisk
    ? (highRuns.length ? highRuns : stageRunsOf.slice(0, 1))
    : typeof opts.roleCount === "number" ? stageRunsOf.slice(0, Math.max(0, opts.roleCount)) : stageRunsOf;
  for (const r of limited) {
    const kind = resolveRole(r.role, roles).report;
    if (kind !== want) throw new Error(`pipeline.${STAGE_SLOT[opts.stage]} の role ${r.role} は report: ${kind}。この段は ${want} が必要`);
  }
  const worktree = resolve(opts.worktree);
  // the paths a reader kept from the records must not be told of either: the overlay manifest's rows, the same line the public face is cut by
  // one read of the rows over every rev the run reads: the rules of every stage drop them (C-284-2), and the recordless copy is cut by them
  const ruleRows = manifestRowsAt(worktree, [opts.head, opts.base, ...(opts.laneBase ? [opts.laneBase] : []), ...(opts.merge ? [opts.merge] : [])]);
  // only the stages kept from the records get a copy cut by the rows; the others work in the lane's worktree
  const rows = RECORDLESS.has(opts.stage) ? ruleRows : [];
  const task = stageTask(opts.stage, { ...(scope ? { scope } : {}), ...(opts.laneKind ? { laneKind: opts.laneKind } : {}), ...(opts.existingFollowups ? { existingFollowups: true } : {}), ...(opts.hasPlan ? { hasPlan: true } : {}), ...(opts.recordsShape ? { recordsShape: opts.recordsShape } : {}) });
  const increment = scope === "increment" && opts.stage === "final";
  // what an increment's final reads next to its diff, found once for all of its runs
  let contextFile: string | undefined;
  if (increment) {
    const dir = join(laneStateDir(), "..", "pipeline", "review", opts.iddId);
    mkdirSync(dir, { recursive: true });
    contextFile = join(dir, `increment-${opts.round}-${randomBytes(3).toString("hex")}.md`);
    writeFileSync(contextFile, renderIncrementContext(incrementContext(worktree, { base: opts.base, head: opts.head, ...(opts.merge ? { merge: opts.merge } : {}), ...(opts.laneBase ? { laneBase: opts.laneBase } : {}), ...(rows.length ? { omit: rows } : {}) })));
  }
  const inputs = [...(contextFile ? [contextFile] : []), ...opts.inputs];
  if (opts.stage === "map") {
    const skipped = riskMapSkipReason({ worktree, base: opts.base, head: opts.head }, roles);
    if (skipped) return { runIds: [], skipped };
  }
  // a route's file list and the leftovers are written into a focus, which a reader kept from the records reads: the records are taken out before any of it is built
  const { routes, changed } = withoutRecords(opts.routes ?? [], opts.routes?.length ? diffPaths(worktree, opts.base, opts.head).paths : [], rows);
  const routeCap = maxRoutesOf(roles);
  const blindPlans = stageRunPlans(opts.stage, slot, { routes, maxRoutes: routeCap, leftovers: changed, ...(opts.extras?.length ? { extras: opts.extras } : {}), ...(conflict ? { conflict: true } : {}), ...(typeof opts.roleCount === "number" ? { roleCount: opts.roleCount } : {}), ...(opts.onlyHighRisk ? { onlyHighRisk: true } : {}) });
  // the spec check runs beside the round's blinds, on the same head: a runner without its slot is a start that fails, never a round without it
  let specPlans: RunPlan[] = [];
  if (blindish && opts.spec && opts.spec.count > 0) {
    const specSlot = roles.pipeline[STAGE_SLOT.spec];
    if (!specSlot) throw new Error(`config/roles.yaml の pipeline に "${STAGE_SLOT.spec}" がありません。深さを持つ回は仕様の照合を走らせるので、宣言が要る`);
    specPlans = specRunPlans(specSlot, opts.spec.count);
    for (const r of specPlans) {
      const kind = resolveRole(r.role, roles).report;
      if (kind !== reportWanted("spec")) throw new Error(`pipeline.${STAGE_SLOT.spec} の role ${r.role} は report: ${kind}。この段は ${reportWanted("spec")} が必要`);
    }
  }
  const plans = [...blindPlans, ...specPlans];
  // before any run: a Claude Code role refused halfway would leave the runs before it started and unrecorded.
  // Over the windows, a Claude Code role with a fallback runs as its fallback; one without holds the stage.
  // A role in noFallback (a High lane's final) holds the stage even when it has a fallback (DEC-2765)
  const picked = rolesForStart(plans.map((plan) => (plan.model ? resolveRoleModel(plan.role, plan.model, roles, plan.thinking) : resolveRole(plan.role, roles))), roles, undefined, new Set(opts.noFallbackRoles ?? []));
  // in the order of the stage's roles, whether folded or run
  const fallbackAt: (QuotaFallback | undefined)[] = plans.map(() => undefined);
  // a fallback that is already one of the stage's runs over the same part of the diff is folded into it: n runs
  // of the same model would lose the difference between the reviewers and cost n times as much. The runs of a
  // mapped round each read a part of their own (the generic one the whole diff), so none of them is folded
  const scopeOf = (plan: RunPlan) => plan.label;
  const running = new Set(plans.flatMap((plan, i) => (picked[i].fallback ? [] : [`${scopeOf(plan)}\u0000${picked[i].role.name}\u0000${picked[i].role.model}`])));
  const starts: { at: number; plan: RunPlan; role: string; fallback?: QuotaFallback }[] = [];
  for (const [i, plan] of plans.entries()) {
    const { role, fallback } = picked[i];
    const key = `${scopeOf(plan)}\u0000${role.name}\u0000${role.model}`;
    if (fallback && running.has(key)) {
      fallbackAt[i] = { ...fallback, folded: true };
      continue;
    }
    running.add(key);
    starts.push({ at: i, plan, role: role.name, ...(fallback ? { fallback } : {}) });
  }
  const run = { ...REAL_DEPS, ...deps };
  // every copy is cut before any run starts, so a copy that cannot be cut (a full disk) leaves no run behind
  const prepared: { at: number; plan: RunPlan; role: string; fallback?: QuotaFallback; dir: string; rules: RuleSelection; copy: { path: string; repo: LaneRepo; refs?: RecordlessCopy["refs"] } | null }[] = [];
  const dropAll = () => { for (const p of prepared) if (p.copy) dropCopy(p.copy.repo, p.copy.path, run.removeWorktree); };
  try {
    for (const { at, plan, role, fallback } of starts) {
      // named after the role the stage asked for, so a fallback that is also one of the stage's roles has its own report
      const stage = plan.stage ?? opts.stage;
      const dir = runDir(opts.iddId, `${opts.round}-${stage}-${runName(plan)}`);
      // before the copy exists, so nothing here can leave one behind
      // the rules come from the version the run's own diff starts at: the spec check shows the lane's whole change, so it reads the rules the lane started with
      const rules = stageRules(worktree, diffStart(stage, opts), opts.head, dir, ruleRows);
      for (const w of rules.warnings) console.warn(`[idd-lane] ${opts.iddId} ${stage}: ${w}`);
      // parallel reviewers each get their own copy; the read-only stages work in the lane's worktree
      let copy: { path: string; repo: LaneRepo; refs?: RecordlessCopy["refs"] } | null = null;
      if (!READ_ONLY.has(stage)) {
        const repo = copySource(worktree, opts.base);
        // a unique name: a run that was abandoned (its copy left behind) must not block the next one
        const name = `${opts.iddId}-${opts.round}-${stage}-${runName(plan)}-${randomBytes(3).toString("hex")}`;
        try {
          // the repo's setup runs in the lane's supervisor (spec.setup), not in the tick that starts it
          if (RECORDLESS.has(stage) && rows.length) {
            // a repository of its own with the records taken out of every rev the run reads (C-223-1)
            const revs = { base: opts.base, head: opts.head, ...(opts.laneBase ? { laneBase: opts.laneBase } : {}), ...(opts.merge ? { merge: opts.merge } : {}) };
            const made = run.addRecordlessCopy(repo, { name, revs, rows, head: "head" });
            copy = { path: made.meta.path, repo, refs: made.refs };
          } else {
            const meta = run.addWorktree(repo, { rev: opts.head, name, skipSetup: true });
            copy = { path: meta.path, repo };
          }
        } catch (err) {
          // a failed setup leaves the checked-out copy behind; take it down before reporting
          dropCopy(repo, join(repo.reviewRoot, name), run.removeWorktree);
          throw err;
        }
      }
      prepared.push({ at, plan, role, ...(fallback ? { fallback } : {}), dir, rules, copy });
    }
  } catch (err) {
    dropAll();
    throw err;
  }
  const runIds: string[] = [];
  const wholeDiff: string[] = [];
  // the role each run was written for (the fallback's name when the windows swapped it), in the runIds order
  const runRoles: string[] = [];
  // the label of each run (empty for a stage's usual round), so a round can say which route a failed blind read
  const runLabels: string[] = [];
  try {
    for (const { at, plan, role, fallback, dir, rules, copy } of prepared) {
      const who = fallback ? `${role}、枠のため ${plan.role} の代わり` : plan.role;
      const stage = plan.stage ?? opts.stage;
      // the spec check reads the lane's whole change on its own inputs; a blind reads what the round shows it
      const specRun = stage === "spec";
      const refs = copy?.refs;
      const refOf = (name: "base" | "head" | "laneBase" | "merge", real: string) => refs?.[name] ?? real;
      // the repo whose checks the brief lists: the copy's own when the stage reads a copy, else the worktree's
      const checksRepo = copy?.repo ?? (() => { try { return repoForPath(worktree); } catch { return null; } })();
      // a copy with its records taken out (it has refs of its own) cannot run a check that needs them: the brief lists what the copy can run
      const recordless = copy?.refs !== undefined;
      const checks: BriefCheck[] = CHECKS_STAGES.has(stage)
        ? (checksRepo?.checks ?? []).filter((c) => !(recordless && c.scope === "records")).map((c) => ({ name: c.name, ...(c.timeoutMinutes !== undefined ? { timeoutMinutes: c.timeoutMinutes } : {}) }))
        : [];
      const runTask = specRun ? stageTask("spec", { ...(opts.recordsShape ? { recordsShape: opts.recordsShape } : {}) }) : task;
      // a stage whose task names solving.md reads it from the tree it works in; a tree without it is told where the original is.
      // A review lane (someone else's PR) is not held to the standard and is told nothing of it (C-259-8)
      const solvingNote = opts.laneKind !== "review" && runTask.includes("solving.md") ? solvingStandardNote(copy?.path ?? worktree) : null;
      const runInputs = specRun
        ? (opts.spec?.inputs ?? []).map((p) => resolve(worktree, p)).filter((p) => existsSync(p))
        : judgementInputs(stage, inputs.map((p) => resolve(worktree, p)).filter((p) => existsSync(p)));
      const solvingOriginal = join(standardsPath(), "solving.md");
      const spec = reviewSpec({
        stage,
        plan: { ...plan, role },
        title: `${opts.iddId} ${stage} ${opts.round} 巡目（${plan.label && !specRun ? `${plan.label} / ` : ""}${who}）`,
        worktree: copy?.path ?? worktree,
        // the spec check reads the lane's whole change: from where the lane started, whatever the blinds are shown
        base: refOf("base", diffStart(stage, opts)),
        head: refOf("head", opts.head),
        inputs: solvingNote && existsSync(solvingOriginal) ? [...runInputs, solvingOriginal] : runInputs,
        rules,
        report: join(dir, "report"),
        ...(stageGetsInjection({ stage }) ? { injectLane: opts.iddId } : {}),
        lane: opts.iddId,
        ...(copy?.repo.setup.length ? { setup: copy.repo.setup } : {}),
        ...(opts.norms?.length ? { norms: opts.norms } : {}),
        ...(opts.iddNorms?.length ? { iddNorms: opts.iddNorms } : {}),
        ...(opts.laneKind ? { laneKind: opts.laneKind } : {}),
        ...(opts.laneBase && !specRun ? { laneBase: refOf("laneBase", opts.laneBase) } : {}),
        ...(opts.overview && blindish ? { overview: opts.overview } : {}),
        task: solvingNote ? `${runTask}\n${solvingNote}` : runTask,
        ...(!specRun && ((scope === "conflict" && blindish) || (increment && opts.merge)) ? { merge: refOf("merge", opts.merge as string) } : {}),
        ...(increment && !specRun ? { increment: true } : {}),
        ...(checks.length ? { checks } : {}),
      });
      const specPath = join(dir, "spec.yaml");
      writeFileSync(specPath, yamlDump(spec, { lineWidth: -1 }));
      const lane = await run.runLane(specPath, { wait: false, ...(fallback ? { quotaFallback: fallback } : {}), ...(opts.noFallbackRoles?.includes(plan.role) ? { noFallback: true } : {}) });
      // the lane's own record says whether it ran on a fallback (it may have been refused after the check above)
      const ran = lane.quota_fallback;
      saveMeta({ lane_id: lane.id, stage: opts.stage, role: lane.role ?? role, ...(copy ? { copy: copy.path, source: worktree, repo: copy.repo.name } : {}), ...(ran ? { quota_fallback: ran } : {}) });
      fallbackAt[at] = ran;
      runIds.push(lane.id);
      runRoles.push(plan.role);
      runLabels.push(plan.label);
      if (plan.wholeDiff) wholeDiff.push(lane.id);
    }
  } catch (err) {
    // the runs started so far would go unrecorded (and uncounted in the budget): stop them and take every copy down
    for (const id of runIds) {
      try { run.stopLane(id); } catch { /* already gone */ }
      const meta = readMeta(id);
      if (meta) saveMeta({ ...meta, cleaned: true });
    }
    dropAll();
    throw err;
  }
  const fallbacks = fallbackAt.filter((f): f is QuotaFallback => !!f);
  // a routed round says which of its runs reads the whole diff: the round is judged only when it finished
  return {
    runIds,
    ...(plans.some((p) => p.wholeDiff) ? { wholeDiff } : {}),
    ...(fallbacks.length ? { fallbacks } : {}),
    runRoles,
    runLabels,
    ...(routes.length ? { routeCount: routes.length, routesOverCap: routes.length > routeCap } : {}),
  };
}

export interface RiskMapCliOptions {
  worktree: string;
  base: string;
  head: string;
  /** the map's role; pipeline.risk_map's when omitted, else risk-mapper */
  role?: string;
  /** directory for the map and the blind specs; defaults to state/lanes/risk-map/<timestamp> */
  out?: string;
  title?: string;
}

function cliOut(opts: RiskMapCliOptions): string {
  const out = opts.out ? resolve(expandHome(opts.out)) : join(laneStateDir(), "risk-map", `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomBytes(2).toString("hex")}`);
  mkdirSync(out, { recursive: true });
  return out;
}

/**
 * The map stage from the CLI (`idd review map`), with the spec the pipeline's map stage writes. It runs
 * whatever the diff's size; `diffLines` and `minLines` say whether the pipeline would map it.
 */
export function writeRiskMapSpec(opts: RiskMapCliOptions): { specPath: string; report: string; out: string; diffLines: number | null; minLines: number; maxRoutes: number; skipReason: string | null } {
  const worktree = resolve(expandHome(opts.worktree));
  if (!existsSync(worktree)) throw new Error(`worktree がありません: ${worktree}`);
  const roles = readRoles();
  const out = cliOut(opts);
  const slot = roles.pipeline.risk_map;
  const role = opts.role ?? slot?.role ?? "risk-mapper";
  if (resolveRole(role, roles).report !== "map") throw new Error(`role ${role} は report: map ではありません`);
  const maxRoutes = maxRoutesOf(roles);
  const mapRun = { role, thinking: resolveRole(role, roles).thinking };
  const [plan] = stageRunPlans("map", { role, roles: [role], models: [], runs: [mapRun], extraRuns: { first_round: [], high_risk: [] }, concurrency: 1 }, { maxRoutes });
  const rules = stageRules(worktree, opts.base, opts.head, out);
  for (const w of rules.warnings) console.warn(`[idd-lane] review map: ${w}`);
  const report = join(out, "map");
  const spec = reviewSpec({ stage: "map", plan, title: opts.title ?? `地図 ${opts.base.slice(0, 9)}..${opts.head.slice(0, 9)}`, worktree, base: opts.base, head: opts.head, inputs: [], rules, report });
  const specPath = join(out, "map.yaml");
  writeFileSync(specPath, yamlDump(spec, { lineWidth: -1 }));
  // what the tick would do: map only with both slots declared and a diff the map is for
  const skipReason = roles.pipeline.review_blind ? riskMapSkipReason({ worktree, base: opts.base, head: opts.head }, roles) : "pipeline.review_blind が未宣言";
  return { specPath, report, out, diffLines: diffLineCount(worktree, opts.base, opts.head), minLines: slot?.minLines ?? DEFAULT_MIN_LINES, maxRoutes, skipReason };
}

export interface MappedBlindSpecs {
  specs: { label: string; role: string; specPath: string; report: string; worktree: string }[];
  /**
   * The directory this run cut the blinds' copies under, which holds every copy and its record and nothing else (a
   * directory of its own under `<out>/review-wt`): removing it is all of the cleanup. Null when the repo has no overlay manifest rows and the specs point at the map's worktree.
   */
  copyRoot: string | null;
}

/**
 * The specs the blinds of a routed round would get, written next to the map (`<out>/blind/<run>/spec.yaml`), so a
 * comparison can run them by hand with `idd lane run`. A repo with overlay manifest rows gets the same blind the
 * pipeline runs: each spec points at a copy of its own with those rows taken out of every rev the blind reads (the
 * head's and base's manifests, and a merge head's parents'), cut under `<out>/review-wt` whether or not the repo is
 * registered, and a route that names only records starts no blind.
 */
export function writeMappedBlindSpecs(opts: RiskMapCliOptions, routes: RiskRoute[]): MappedBlindSpecs {
  const worktree = resolve(expandHome(opts.worktree));
  const roles = readRoles();
  const out = cliOut(opts);
  // the blinds take review_blind's roles; without the slot there is nothing to write them for
  const slot = roles.pipeline.review_blind;
  if (!slot) return { specs: [], copyRoot: null };
  const revs = { base: opts.base, head: opts.head };
  const read = manifestRowsAt(worktree, [opts.head, opts.base]);
  // only a repo the registry does not list is cut with nothing of its own; a registry that cannot be read or parsed fails here, before any directory is made, so a registered repo's copy, setup and checks are not dropped unseen.
  // Where the revs' manifests have no row there is nothing yet to cut a copy for, so a registry that cannot be read leaves the spec on the map's worktree
  let known: LaneRepo | null = null;
  if (existsSync(reposPath())) {
    try {
      known = repoForPath(worktree, readLaneRepos());
    } catch (err) {
      if (read.length) throw err;
    }
  }
  // the rows the copy takes out are the ones read from the revs and, for a registered repo, its change start's (which can hold a row the revs' manifests no longer do): a route or a focus that names one is for a path the copy does not hold
  const rows = recordlessRows(copyRepoOf(known, worktree, opts.base, join(out, "review-wt")), { revs, rows: read, head: "head" });
  const { routes: kept, changed } = withoutRecords(routes, diffPaths(worktree, opts.base, opts.head).paths, rows);
  const plans = stageRunPlans("blind", slot, { routes: routesInDiff(kept, new Set(changed)), maxRoutes: maxRoutesOf(roles), leftovers: changed });
  // one directory per run under <out>/review-wt, made by this run: removing it takes this run's copies and records and nothing a run before left there
  const copyRoot = rows.length && plans.length ? freshDir(join(out, "review-wt")) : null;
  const repo = copyRepoOf(known, worktree, opts.base, copyRoot ?? join(out, "review-wt"));
  // what the pipeline's blind is told to run: the registered repo's checks (a worktree the registry does not list has none)
  const registered = known ?? (rows.length ? null : (() => { try { return repoForPath(worktree); } catch { return null; } })());
  // a spec that points at a copy with its records taken out is not handed a check that needs them (the pipeline's blind is told the same)
  const checks: BriefCheck[] = (registered?.checks ?? []).filter((c) => !(rows.length > 0 && c.scope === "records")).map((c) => ({ name: c.name, ...(c.timeoutMinutes !== undefined ? { timeoutMinutes: c.timeoutMinutes } : {}) }));
  try {
    const specs = plans.map((plan) => {
      const dir = join(out, "blind", runName(plan));
      mkdirSync(dir, { recursive: true });
      let at: { path: string; base: string; head: string } = { path: worktree, base: opts.base, head: opts.head };
      if (rows.length) {
        const name = `blind-${runName(plan)}-${randomBytes(3).toString("hex")}`;
        const made = addRecordlessCopy(repo, { name, revs, rows, head: "head" });
        at = { path: made.meta.path, base: made.refs.base, head: made.refs.head };
      }
      // the rules are picked from what the blind reads: in the copy a rule the manifest takes out is not there to be handed, nor written under `dir` as the base's text
      const rules = stageRules(at.path, at.base, at.head, dir, rows);
      const report = join(dir, "report");
      const spec = reviewSpec({
        stage: "blind",
        plan,
        title: `blind ${plan.label || "all"}（${plan.role}）`,
        worktree: at.path,
        base: at.base,
        head: at.head,
        inputs: [],
        rules,
        report,
        ...(rows.length && repo.setup.length ? { setup: repo.setup } : {}),
        ...(checks.length ? { checks } : {}),
      });
      const specPath = join(dir, "spec.yaml");
      writeFileSync(specPath, yamlDump(spec, { lineWidth: -1 }));
      return { label: plan.label, role: plan.role, specPath, report, worktree: at.path };
    });
    return { specs, copyRoot };
  } catch (err) {
    // copies no spec names would be left for nobody to find; only the directory this run made is taken down
    if (copyRoot) rmSync(copyRoot, { recursive: true, force: true });
    throw err;
  }
}

/** a new, empty directory under `parent` that no earlier run or anyone else made: a name already taken is never reused, so removing it cannot take anything that was there */
export function freshDir(parent: string, nameOf: () => string = () => randomBytes(4).toString("hex")): string {
  mkdirSync(parent, { recursive: true });
  for (let i = 0; ; i++) {
    const dir = join(parent, nameOf());
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i >= 16) throw err;
    }
  }
}

/** `dryRun` writes the map's spec and starts nothing (no lane is recorded) */
export async function runRiskMap(opts: RiskMapCliOptions, run: RunOptions = {}): Promise<ReturnType<typeof writeRiskMapSpec> & { lane?: LaneRecord; routes?: RiskRoute[]; blind?: MappedBlindSpecs }> {
  const written = writeRiskMapSpec(opts);
  if (run.dryRun) return written;
  const lane = await runLane(written.specPath, run);
  if (lane.status !== "done" || !existsSync(`${written.report}.json`)) return { ...written, lane };
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(`${written.report}.json`, "utf8")) as Record<string, unknown>;
  } catch {
    return { ...written, lane };
  }
  const routes = changedRoutes(parseRoutes(raw.routes), resolve(expandHome(opts.worktree)), opts.base, opts.head);
  return { ...written, lane, routes, blind: routes.length ? writeMappedBlindSpecs({ ...opts, out: written.out }, routes) : { specs: [], copyRoot: null } };
}

/** the mark of a finding that undoes an earlier round's fix: that round's ref, and the two positions */
export interface Reversal { prior_ref: string; prior: string; current: string }

const EMPTY_MARK = /^(なし|無し|特になし|none|n\/a|null|-|ー|―|—)$/i;

/** a mark the triage filled in, or nothing: an empty or malformed one leaves the decision as it was */
function reversalOf(v: unknown): { reverts?: Reversal } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  // "なし" and the like fill the field without saying anything
  const str = (x: unknown) => (typeof x === "string" && !EMPTY_MARK.test(x.trim()) ? x.trim() : "");
  const mark = { prior_ref: str(r.prior_ref), prior: str(r.prior), current: str(r.current) };
  return mark.prior_ref || mark.prior || mark.current ? { reverts: mark } : {};
}

/** which reviewer runs a judged finding came from, the weight they gave it, and the review-lane report flag */
function originOf(d: Record<string, unknown>): { from?: string[]; reported_severity?: "must" | "should" | "nit"; correction_ref?: string; report?: boolean } {
  const from = Array.isArray(d.from) ? d.from.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
  const reported = (["must", "should", "nit"] as const).find((v) => v === d.reported_severity);
  const cited = typeof d.correction_ref === "string" ? d.correction_ref.trim() : "";
  return { ...(from.length ? { from } : {}), ...(reported ? { reported_severity: reported } : {}), ...(cited ? { correction_ref: cited } : {}), ...(d.report === true ? { report: true } : {}) };
}

export type ReviewRunState =
  | { state: "running" }
  | { state: "failed"; error: string }
  | {
    state: "done";
    reportJson: string;
    reportMd: string;
    findings: Finding[];
    decisions?: { ref: string; verdict: "accept" | "reject" | "escalate"; severity: "must" | "should" | "nit"; claim: string; path?: string; fix?: string; reason?: string; impact?: string; action?: "fix" | "followup" | "skip"; fix_basis?: "data_loss" | "halt" | "cross_lane"; followup?: boolean; no_request?: boolean; reverts?: Reversal; from?: string[]; reported_severity?: "must" | "should" | "nit"; correction_ref?: string; report?: boolean }[];
    items?: { ref: string; resolved: boolean; evidence?: string }[];
    skipped?: string;
    /** map */
    routes?: RiskRoute[];
    verdict?: string;
    /** the roles or providers the run moved to while it ran (mid-run switches) */
    fallbacks?: QuotaFallback[];
  };

function dropCopy(repo: LaneRepo, path: string, remove: typeof removeWorktree = removeWorktree): void {
  try {
    if (existsSync(path)) remove(repo, path, { force: true });
  } catch {
    // visible in `git worktree list` if it could not be removed
  }
}

function cleanup(meta: RunMeta | null): void {
  if (!meta?.copy || meta.cleaned) return;
  try {
    removeWorktree(copySource(meta.source ?? meta.copy), meta.copy, { force: true });
  } catch {
    // a copy that is already gone is fine; a stuck one is visible in `git worktree list`
  }
  saveMeta({ ...meta, cleaned: true });
}

/**
 * Stop one of a lane's runs where it stands and take its review copy down. `stopLane` records a person's stop, so
 * nothing resumes it; the copy is the one the run's meta names (a copy already gone is fine). Used when the lane
 * the run belongs to is taken out: nobody reads a stopped lane's runs, so the copy would otherwise stay behind.
 */
export function stopReviewRun(runId: string): void {
  stopLane(runId);
  cleanup(readMeta(runId));
}

/**
 * What a judging stage reads, from the inputs its caller listed: a review report's findings with the reviewer's
 * how-to-fix taken out. A judgement decides the weight of a finding from its claim and evidence, so a plan for the
 * fix in its input would let a wrong plan become a contract (C-197-2). The copy sits in the report's own directory,
 * so its parent name still tells the run the finding came from (`from`). A report with no how is read where it is,
 * as every older report was.
 */
function judgementInputs(stage: ReviewStage, inputs: string[]): string[] {
  if (!JUDGING.has(stage)) return inputs;
  return inputs.map((p) => (p.endsWith(".json") ? withoutHow(p) : p));
}

/** the same report with every finding's how-to-fix dropped, beside it; the report itself when it has none */
function withoutHow(path: string): string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return path;
  }
  const out = { ...raw };
  let changed = false;
  for (const key of ["findings", "new_findings"] as const) {
    if (!Array.isArray(raw[key])) continue;
    out[key] = (raw[key] as unknown[]).map((f) => {
      if (!f || typeof f !== "object" || !("how" in (f as Record<string, unknown>))) return f;
      changed = true;
      return Object.fromEntries(Object.entries(f as Record<string, unknown>).filter(([k]) => k !== "how"));
    });
  }
  if (!changed) return path;
  const copy = join(dirname(path), "report-without-how.json");
  writeFileSync(copy, `${JSON.stringify(out, null, 2)}\n`);
  return copy;
}

export function reviewRunState(laneId: string, opts: LaneReadOptions = {}): ReviewRunState {
  let rec;
  try {
    rec = closeDeadRun(readLane(laneId), opts);
  } catch (err) {
    return { state: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (rec.status === "running") return { state: "running" };
  const meta = readMeta(laneId);
  const json = `${rec.report}.json`;
  if (rec.status !== "done" || !existsSync(json)) {
    cleanup(meta);
    return { state: "failed", error: rec.error ?? `lane ${rec.status}` };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
  } catch (err) {
    cleanup(meta);
    return { state: "failed", error: `報告の JSON を読めません: ${err instanceof Error ? err.message : String(err)}` };
  }
  cleanup(meta);
  // an unknown severity must not silently weaken the loop's close condition, so it counts as a should
  const sev = (v: unknown) => ((["must", "should", "nit"] as const).includes(v as never) ? (v as "must" | "should" | "nit") : "should");
  return {
    state: "done",
    reportJson: json,
    reportMd: `${rec.report}.md`,
    ...(rec.fallbacks?.length ? { fallbacks: rec.fallbacks } : {}),
    findings: [...((raw.findings as Record<string, unknown>[] | undefined) ?? []), ...((raw.new_findings as Record<string, unknown>[] | undefined) ?? [])]
      .filter((f) => f && typeof f.claim === "string")
      .map((f) => ({
        severity: sev(f.severity),
        path: String(f.path ?? ""),
        line: typeof f.line === "number" ? f.line : null,
        claim: String(f.claim),
        evidence: String(f.evidence ?? ""),
        is_guess: Boolean(f.is_guess),
        ...(recommendedAction(f.action) ? { action: recommendedAction(f.action) } : {}),
        ...(typeof f.frequency === "string" && f.frequency.trim() ? { frequency: f.frequency.trim() } : {}),
        ...(typeof f.how === "string" && f.how.trim() ? { how: f.how.trim() } : {}),
      })),
    ...(Array.isArray(raw.decisions)
      ? {
        decisions: (raw.decisions as Record<string, unknown>[]).map((d) => ({
          ref: String(d.ref ?? ""),
          verdict: (["accept", "reject", "escalate"].includes(String(d.verdict)) ? d.verdict : "escalate") as "accept" | "reject" | "escalate",
          severity: sev(d.severity),
          claim: String(d.claim ?? ""),
          ...(d.path ? { path: String(d.path) } : {}),
          ...(d.fix ? { fix: String(d.fix) } : {}),
          ...(d.impact ? { impact: String(d.impact) } : {}),
          ...(recommendedAction(d.action) ? { action: recommendedAction(d.action) } : {}),
          ...(FIX_BASIS.includes(d.fix_basis as never) ? { fix_basis: d.fix_basis as "data_loss" | "halt" | "cross_lane" } : {}),
          ...(d.reason ? { reason: String(d.reason) } : {}),
          ...(d.followup === true ? { followup: true } : {}),
          ...(d.no_request === true ? { no_request: true } : {}),
          ...reversalOf(d.reverts),
          ...originOf(d),
        })),
      }
      : {}),
    ...(Array.isArray(raw.items)
      ? { items: (raw.items as Record<string, unknown>[]).map((i) => ({ ref: String(i.ref ?? ""), resolved: Boolean(i.resolved), ...(i.evidence ? { evidence: String(i.evidence) } : {}) })) }
      : {}),
    ...(typeof raw.skipped === "string" && raw.skipped.trim() ? { skipped: raw.skipped } : {}),
    ...(Array.isArray(raw.routes) ? { routes: parseRoutes(raw.routes) } : {}),
    ...(typeof raw.verdict === "string" && raw.verdict.trim() ? { verdict: raw.verdict.trim() } : {}),
  };
}
