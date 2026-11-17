#!/usr/bin/env node
// The cross-check: the MoonBit fold and the TypeScript fold, held against a real ledger.
//
// This is not a check the gate runs. A real ledger is not committed (it carries the lanes' own records and
// lives outside git), and the test entry drops the `IDD_` variables, so a test cannot see one: a check whose
// answer depended on what happens to be in the state directory would not answer the same on two machines
// (C-186-4). What the gate runs is the fixture test (`packages/idd-core/test/fold-moonbit.test.mjs`); this
// script is what a person runs against the ledger of a real repository, and what the lane's evidence names.
//
//   node --experimental-strip-types packages/idd-fold/crosscheck.mjs <state directory>
//
// It reads the whole lifecycle and the intent column of every repo in the state directory, folds both with
// both folds, and compares the answers: the lanes' states, the records as the outside sees them and as every
// lane in the ledger sees them, and — at every prefix of every lane — the review loop's state, the stage, the
// lane's end and its landing, and the loop's next step (the leg it steps on and the record that leg writes),
// over a fixed set of facts. The exit status is 0 only when nothing differs.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const stateDirectory = process.argv[2];
if (!stateDirectory) {
  console.error("使い方: node --experimental-strip-types packages/idd-fold/crosscheck.mjs <state の置き場>");
  process.exit(2);
}
// the readers take the state directory from the environment, and every import below reads it
process.env.IDD_STATE_DIR = stateDirectory;

const here = new URL(".", import.meta.url).pathname;
const core = join(here, "..", "idd-core", "src");
const { readLifecycle } = await import(join(core, "ledger", "read.ts"));
const { laneStates, foldRows, readRows, intentColumnPath } = await import(join(core, "intent", "store.ts"));
const { quotaFactOf, quotaFactOfAny } = await import(join(core, "ledger", "derive.ts"));
const turnRef = await import(join(core, "ledger", "turn-reference.ts"));
const pickRef = await import(join(core, "ledger", "pick-reference.ts"));
const { laneAnswer } = await import(join(core, "intent", "moonbit-fold.ts"));
const { judgeSync } = await import(join(core, "ledger", "review-loop.ts"));
const judgeRef = await import(join(core, "ledger", "review-judge-reference.ts"));
const loopRef = await import(join(core, "ledger", "review-loop-reference.ts"));
const nextRef = await import(join(core, "ledger", "review-loop-next-reference.ts"));
const stageRef = await import(join(core, "ledger", "derive-reference.ts"));
const { laneStatesTs, foldRowsTs } = await import(join(core, "intent", "fold-reference.ts"));
const landRef = await import(join(core, "overlay", "land-reads-reference.ts"));
const submitRef = await import(join(core, "plan", "submit-step-reference.ts"));
const landStepRef = await import(join(core, "plan", "land-step-reference.ts"));
const reads = await import(join(core, "plan", "ledger-reads.ts"));
const readsRef = await import(join(core, "plan", "ledger-reads-reference.ts"));
const startStepRef = await import(join(core, "plan", "start-step-reference.ts"));
const preMergeRef = await import(join(core, "plan", "pre-merge-reference.ts"));

/** the same answer, with the keys a JSON round trip leaves out taken out of both sides */
function normal(value) {
  return JSON.parse(JSON.stringify(value));
}

function laneStatesObject(states) {
  return Object.fromEntries(states);
}

let differed = 0;
function report(where, expected, actual) {
  differed += 1;
  if (differed > 5) return;
  console.error(`食い違い: ${where}`);
  console.error(`  TS  : ${JSON.stringify(normal(expected)).slice(0, 400)}`);
  console.error(`  MBT : ${JSON.stringify(normal(actual)).slice(0, 400)}`);
}

const started = Date.now();
const events = readLifecycle();
const repos = readdirSync(stateDirectory)
  .filter((name) => name.startsWith("intent-") && name.endsWith(".jsonl"))
  .map((name) => decodeURIComponent(name.slice("intent-".length, -".jsonl".length)));

console.log(`lifecycle: ${events.length} 行 / 意図の列: ${repos.length} repo`);

const states = laneStates(events);
const statesTs = laneStatesTs(events);
const stateAnswer = laneStatesObject(states);
const stateAnswerTs = laneStatesObject(statesTs);
console.log(`lane の状態: ${states.size} lane`);
if (!isDeepStrictEqual(normal(stateAnswerTs), normal(stateAnswer))) {
  report("lane の状態", stateAnswerTs, stateAnswer);
}

// intake's readings are over the whole column: the lanes that ended, and the ones whose Issue was landed
{
  const mine = reads.closedLanes(events);
  const theirs = readsRef.closedLanesReference(events);
  const keys = [...new Set([...mine.keys(), ...theirs.keys()])];
  for (const key of keys) {
    const a = mine.get(key);
    const b = theirs.get(key);
    const same = a === undefined || b === undefined ? a === b : Number.isNaN(a) && Number.isNaN(b) || a === b;
    if (!same) report(`閉じた lane ${key}`, b, a);
  }
  console.log(`閉じた lane: ${mine.size} 件`);
  const landedMine = [...reads.landedLanes(events)].sort();
  const landedTheirs = [...readsRef.landedLanesReference(events)].sort();
  if (!isDeepStrictEqual(landedMine, landedTheirs)) report("着地した lane", landedTheirs, landedMine);
  const ended = [...reads.laneEndedEvents()];
  if (!isDeepStrictEqual(ended, ["lane_close", "s1_defer", "s3_defer"])) report("lane の終わりの一覧", ["lane_close", "s1_defer", "s3_defer"], ended);
  // the retire list the running path uses, held against the copy's own list. A fold that counted the hold at S3 as a
  // final end would put a held lane's worktree in the pass's way, and both sides would agree if the copy read the
  // fold's list: the copy keeps its own, and only membership is compared
  const finalMine = [...reads.finalEndEvents()].sort();
  const finalTheirs = [...readsRef.FINAL_ENDS_REFERENCE].sort();
  if (!isDeepStrictEqual(finalMine, finalTheirs)) report("退役の終わりの一覧", finalTheirs, finalMine);
}

const viewers = [null, ...[...states.keys()].sort()];
let compared = 0;
for (const repo of repos) {
  const rows = readRows(intentColumnPath(repo));
  console.log(`意図の記録: ${repo} / ${rows.length} 行 / ${viewers.length} の見る側`);
  for (const viewer of viewers) {
    const mine = foldRows(rows, viewer, states);
    const reference = foldRowsTs(rows, viewer, statesTs);
    compared += 1;
    if (!isDeepStrictEqual(normal(reference), normal(mine))) {
      report(`${repo} / 見る側 ${viewer ?? "（lane の外）"}`, reference, mine);
    }
  }
}

// --- the derivations: the review loop, the stage, the end and the landing, at every prefix of every lane ---
const byLane = new Map();
for (const row of events) {
  if (!byLane.has(row.idd_id)) byLane.set(row.idd_id, []);
  byLane.get(row.idd_id).push(row);
}
let prefixes = 0;
let landCompared = 0;
let turnCompared = 0;
// the stages the tick asks, and the facts each of them reads that the ledger does not hold. The facts are fixed
// here: the cross-check compares the two readings over the same ledger and the same facts, and the fixture test
// (`packages/idd-core/test/turn-moonbit.test.mjs`) walks the facts' variety.
const STAGES = ["prep", "exec", "check", "submit_prep", "submit_push", "land", "land_ledger", "land_carry", "land_carry_ledger", "auto_go", "budget", "blocker", "pr_feedback", "watch", "stall"];
const STAGE_FACTS = {
  prep: { hasSession: false },
  exec: { hasSession: false },
  submit_push: { publishes: false, hasWorktree: true, hasHead: true },
  land: { hasLocation: true, publishes: false },
  land_carry: { hasLocation: true, publishes: false },
  auto_go: { lane: "", depth: "shallow", blocked: false, purposes: [], choices: [], laneRows: [] },
  budget: { cost: 0, base: 10 },
  blocker: { hasBlockers: false },
  pr_feedback: { lastBatchAnswered: true },
  watch: { awaitedRole: "executor", targetRole: "executor", pendingFixEnvelope: false },
  stall: { reloadHold: false, waitingSlot: false, worktreeBusy: false, pendingEnvelope: false, cardBuildable: true, awaitedAgent: null },
};
// the next step reads facts the ledger does not hold. The cross-check compares the two readings over the same rows
// and the same facts; the fixture test (`packages/idd-core/test/review-loop-next.test.mjs`) walks the facts' variety.
// Each set is one answer of the outside world: no run, a run still going, a run that wrote its report, a run that
// failed, the fix's envelope, the records check's queue, the device check's verdict, and the confirm's open refs.
const STEP_FACTS = {
  "run なし": {},
  "run 実行中": { runs: [{ state: "running" }] },
  "run 完了": { runs: [{ state: "done", routes: [{ id: "r1", paths: ["a.ts"], question: "q", harms: [] }], reportMd: "/m.md", reportJson: "/m.json", fallbacks: [{ role: "r", fallback: "q", reason: "x" }], runIds: ["R1"], runRoles: ["reviewer"], runLabels: ["r1"] }] },
  "run 失敗": { runs: [{ state: "failed", error: "boom" }] },
  "run の指摘と飛ばした理由": { runs: [{ state: "done", reportMd: "/m.md", reportJson: "/m.json", runIds: ["R1"], findings: [{ severity: "must", claim: "c" }], skipped: "why", fallbacks: [{ role: "r" }] }] },
  "人の判定の device": { runs: [{ state: "done", reportJson: "/m.json", runIds: ["R1"] }], judge: "human", deviceFindings: [{ severity: "must", claim: "c" }], staleReason: "old" },
  "修正の envelope": { envelopeId: "E-1", acceptedRefs: ["F-1"], hows: ["F-1"], boundaryRefs: ["F-2"], boundaryItems: [{ ref: "F-2", severity: "must", claim: "c" }] },
  "記録の指示の queue": { queued: true, recordsHead: "abc", recordsErrors: [{ rule: "r", message: "m" }] },
  "記録の指示の queue が失敗": { queued: false },
  "device の判定": { deviceOn: true, verdict: { action: "check", judge: "viewer", pictures: 2 }, judge: "viewer", pictures: 2, staleReason: "old", deviceFindings: [{ severity: "must", claim: "c" }] },
  "device の must": { deviceOn: true, verdict: { action: "must", reason: "r" }, pictures: 3 },
  "device が未宣言": { deviceOn: false },
  "confirm の残り": { severities: [{ ref: "F-1", severity: "must" }, { ref: "F-2", severity: "nit" }], unresolved: ["F-1"], missing: ["F-3"] },
  "confirm の残り（S4）": { severities: [{ ref: "F-1", severity: "must" }, { ref: "F-2", severity: "nit" }], unresolved: ["F-1"], missing: ["F-3"], scopeRefs: ["F-1", "F-3"], scopeRefsGiven: true, boundaryRefs: ["F-3"] },
  "段の枠と手段": { triageFits: true, confirmFits: true, means: [{ rule: "r" }] },
  "High の最後のレビュー": { runs: [{ state: "done", reportJson: "/f.json", runIds: ["R1"] }], policy: { highRiskWhen: "last", extras: { high_risk: 1 }, extraRoles: { high_risk: ["high"] } } },
  // the runs whose facts are missing, as an older writer or a runner that says little leaves them: none of them
  // stops the fold, and each answers the step the pre-wiring TS answered (C-203-2)
  "run の id 無し": { runs: [{ state: "done", reportJson: "/x.json" }] },
  "run の state 無し": { runs: [{ reportJson: "/x.json", runIds: ["R1"] }] },
  "報告の無い done": { runs: [{ state: "done", runIds: ["R1"] }] },
  "High の role が未完走": { runs: [{ state: "failed", error: "x", runIds: ["R1"] }], policy: { highRiskWhen: "last", extras: { high_risk: 1 }, extraRoles: { high_risk: ["high"] } } },
  // the blind's start: whether the map runs, the round a moved head is drawn again for, and the record the start writes
  "blind の始まり": { reviewOn: true, mapOn: true, mapFits: true, blindFits: true, routeBlindFits: true, at: { worktree: "/wt", base: "b0", head: "h1" }, policy: { closeOnMust: false, closeOnFix: false, maxFixRounds: 8, shouldDefault: "fix", highRiskWhen: "first", finalScope: "whole", afterMerge: "whole", finalWhen: "always", extras: { first_round: 1, high_risk: 1 }, extraRoles: { first_round: ["r"], high_risk: ["high"] } } },
  "blind の始まり（地図あり）": { reviewOn: true, mapOn: true, mapFits: true, blindFits: true, routeBlindFits: true, mapTried: true, mapSkipped: "差分 12 行", extras: ["first_round"], roundDepth: "standard", depthFixRounds: 2, wholeForUnread: false, risk: { risk: "High", high: true, hits: [{ kind: "permission", paths: ["scripts/x.sh"], total: 1 }] }, at: { worktree: "/wt", base: "b0", head: "h1" }, policy: { maxFixRounds: 2, shouldDefault: "followup", highRiskWhen: "last", extras: { first_round: 1, high_risk: 1 }, extraRoles: { first_round: ["r"], high_risk: ["high"] } }, runs: [{ state: "started", runIds: ["B1"], runRoles: ["r"], runLabels: ["r1"], wholeDiff: ["B1"], routeCount: 1, fallbacks: [{ role: "r" }] }] },
  "blind の始まり（地図の起動）": { reviewOn: true, mapOn: true, mapFits: true, blindFits: true, routeBlindFits: true, at: { worktree: "/wt", base: "b0", head: "h1" }, mapRun: { state: "done", runIds: ["M1"], fallbacks: [{ role: "r" }] } },
  "blind の始まり（地図の失敗）": { reviewOn: true, mapOn: true, mapFits: true, blindFits: true, routeBlindFits: true, at: { worktree: "/wt", base: "b0", head: "h1" }, mapRun: { state: "failed", error: "boom" } },
  "blind の始まり（枠が無い）": { reviewOn: true, mapOn: true, mapFits: false, blindFits: true, at: { worktree: "/wt", base: "b0", head: "h1" } },
  "blind の始まり（blind の枠が無い）": { reviewOn: true, mapOn: true, mapFits: true, blindFits: false, at: { worktree: "/wt", base: "b0", head: "h1" } },
};

// the push's next step: the steps the fold answers and the steps the TypeScript reads, over the same rows and the
// same observations. Each scenario is a reading of the outside world: a saved submit (waiting, or past its window),
// a change the review did not see, a push that reached the branch without its record (finishable or not), a PR found
// merged, a follow-up that came back refused (the lock, a passing failure, a failure of the change), and a check's
// answer (local only, blocking checks, already pushed, a new submit). AC-001 names the set.
const SUBMIT_HEAD = "a".repeat(40);
const SUBMIT_NOW = Date.parse("2026-10-23T10:00:00.000Z");
const submitScenarios = {
  "何も無い": () => ({}),
  "保存された提出（待っている）": (lane) => {
    const saved = { status: "prepared", head: SUBMIT_HEAD, mode: "publish", blocking: 0, expiresAt: new Date(SUBMIT_NOW + 3600_000).toISOString(), token: "T-1", pr: { title: "t", body: "" } };
    return { [`proposal|${lane}|`]: saved, [`location|${lane}|`]: true, [`outdated|${lane}|`]: { reason: null, threw: false } };
  },
  "期限の切れた提出": (lane) => {
    const saved = { status: "prepared", head: SUBMIT_HEAD, mode: "publish", blocking: 0, expiresAt: new Date(SUBMIT_NOW - 1000).toISOString(), token: "T-2", pr: { title: "t", body: "" } };
    return { [`proposal|${lane}|`]: saved, [`location|${lane}|`]: true, [`outdated|${lane}|`]: { reason: null, threw: false } };
  },
  "未レビューの変更": (lane) => ({
    [`proposal|${lane}|`]: { status: "prepared", head: SUBMIT_HEAD, mode: "publish", blocking: 0, expiresAt: new Date(SUBMIT_NOW + 3600_000).toISOString(), token: "T-3" },
    [`location|${lane}|`]: true,
    [`outdated|${lane}|`]: { reason: null, threw: false },
    [`unreviewed|${lane}|`]: { reason: "レビューが見ていない変更", seen: "b".repeat(40) },
  }),
  "記録の無い push（token が使える）": (lane) => ({
    [`unsaved|${lane}|`]: { token: "U-1", head: SUBMIT_HEAD },
    [`unsavedOutdated|${lane}|`]: false,
  }),
  "記録の無い push（token が古い）": (lane) => ({
    [`unsaved|${lane}|`]: { token: "U-2", head: SUBMIT_HEAD },
    [`unsavedOutdated|${lane}|`]: true,
  }),
  "記録の無い push（古い・もう記録した）": (lane) => ({
    [`unsaved|${lane}|`]: { token: "U-3", head: SUBMIT_HEAD },
    [`unsavedOutdated|${lane}|`]: true,
    [`call|record_unsaved_push|outdated`]: { keep: { id: lane }, result: null },
    [`call|settle_unsaved|outdated`]: { keep: { id: lane }, result: null },
  }),
  "記録の無い push（古い・lock の拒否）": (lane) => ({
    [`unsaved|${lane}|`]: { token: "U-4", head: SUBMIT_HEAD },
    [`unsavedOutdated|${lane}|`]: true,
    [`err|record_unsaved_push|outdated`]: { error: "検査が走っています", lockRefused: true },
  }),
  "push 済みで PR あり・失敗が直後": (lane, started) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-1" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`shipFailedAt|${lane}|${started}`]: new Date(SUBMIT_NOW - 60_000).toISOString(),
  }),
  "push 済みで PR あり・失敗が古い": (lane, started) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-2" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`shipFailedAt|${lane}|${started}`]: new Date(SUBMIT_NOW - 3600_000).toISOString(),
  }),
  "後始末の答え（lock の拒否）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-3" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: false, lockRefused: true, error: "検査が走っています" } },
  }),
  "後始末の答え（merge 済み）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-4" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: true, merged: true } },
  }),
  "後始末の答え（PR が無い）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-5" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: true, previousPr: { number: 7, state: "OPEN", headRefOid: "c".repeat(40) } } },
  }),
  "後始末の答え（PR が無い・前の PR は merge 済み）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-6" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: true, previousPr: { number: 7, state: "MERGED", headRefOid: "d".repeat(40) } } },
  }),
  "後始末の答え（環境の失敗）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-7" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: false, permanent: true, error: "base が変わりました" } },
  }),
  "後始末の答え（変更の失敗）": (lane) => ({
    [`proposal|${lane}|`]: { status: "pushed", head: SUBMIT_HEAD, token: "P-8" },
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`call|settle_pushed|retry`]: { keep: { id: lane, head: SUBMIT_HEAD, hasPr: true, what: "PR の確認に失敗しました" }, result: { ok: false, error: "PR の確認に失敗しました" } },
  }),
  "検査の答え（PR の状態を確かめられない）": () => ({
    [`err|propose_admitted|checked`]: { error: "connection reset", lockRefused: false },
  }),
  "検査の答え（保存されなかった）": (lane) => ({
    [`call|propose_admitted|checked`]: { keep: { id: lane }, result: { error: "レーンが動いています", notSaved: "refused" } },
  }),
  "検査の答え（ローカル完了だけ）": (lane) => ({
    [`call|propose_admitted|checked`]: { keep: { id: lane }, result: { status: "prepared", mode: "local", blocking: 0, token: "T-9" } },
  }),
  "検査の答え（必須検査が落ちた）": (lane) => ({
    [`call|propose_admitted|checked`]: { keep: { id: lane }, result: { status: "prepared", mode: "publish", blocking: 2, token: "T-10", blockingSummary: "test が 2 件落ちた" } },
  }),
  "検査の答え（push 済みで branch が持っている）": (lane) => ({
    [`call|propose_admitted|checked`]: { keep: { id: lane }, result: { status: "prepared", mode: "publish", blocking: 0, token: "T-11" } },
    [`carriesOf|${lane}|T-11`]: true,
  }),
  "検査の答え（新しい提出）": (lane) => ({
    [`call|propose_admitted|checked`]: { keep: { id: lane }, result: { status: "prepared", mode: "publish", blocking: 0, token: "T-12" } },
    [`carriesOf|${lane}|T-12`]: false,
  }),
  "PR の draft 待ち": (lane) => ({
    [`runnerDraft|${lane}|`]: true,
    [`prDraft|${lane}|`]: null,
    [`openPr|${lane}|`]: false,
    [`prDraftFailed|${lane}|`]: false,
  }),
  "merge 済みの PR": (lane) => ({
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`unpublished|${lane}|`]: false,
    [`call|settle_merged_pr|merged`]: { keep: { id: lane }, result: { number: 7, url: "https://github.com/test/project/pull/7" } },
  }),
  "merge 済みでない PR（Err は null）": (lane) => ({
    [`pr|${lane}|`]: { repo: "test/project", pr: 7, url: "https://github.com/test/project/pull/7" },
    [`unpublished|${lane}|`]: false,
    [`call|settle_merged_pr|merged`]: { keep: { id: lane }, result: null },
  }),
};

// the landing's next step: the steps the fold answers and the steps the TypeScript reads, over the same rows and the
// same observations. Two readings are compared: `carry` is an approval the pass carries out, `scan` is a lane at the
// landing's card, whose failed check is settled or whose check is started. Each scenario is a reading of the outside
// world: the approval, git's answer about the work_base branch, the saved record, the run a check wrote, and the
// answers of the helpers the answer calls.
const LAND_HEAD = "a".repeat(40);
const LAND_TIP = "b".repeat(40);
const LAND_OLD_TIP = "c".repeat(40);
const LAND_AT = Date.parse("2026-10-23T10:00:00.000Z");
const LAND_CUT = "時間の上限（5 分）で打ち切りました";

/** the observations of a lane with nothing in the way, for the approval a pass carries out */
function landCarryFactsOf(lane) {
  return {
    [`approval|${lane}|`]: { head: LAND_HEAD, at: 1000 },
    [`location|${lane}|`]: true,
    [`cur|${lane}|`]: LAND_HEAD,
    [`mainTip|${lane}|`]: LAND_TIP,
    [`branch|${lane}|`]: "work-main",
    [`ancestor|${lane}|`]: false,
    [`mergeCommitCarried|${lane}|`]: false,
    [`checkouts|${lane}|`]: null,
    [`ready|${lane}|`]: null,
    [`saved|${lane}|`]: null,
    [`blocked|${lane}|`]: null,
  };
}

/** the observations of a lane with nothing in the way, for the lane at the landing's card */
function landScanFactsOf(lane) {
  return {
    [`checked|${lane}|`]: null,
    [`runEnded|${lane}|`]: false,
    [`behind|${lane}|`]: null,
    [`stacked|${lane}|`]: null,
    [`head|${lane}|`]: LAND_HEAD,
    [`unreviewed|${lane}|`]: null,
    [`now|${lane}|`]: LAND_AT,
    [`branch|${lane}|`]: "work-main",
    [`runChecking|${lane}|`]: false,
    [`run|${lane}|`]: null,
    [`attempted|${lane}|`]: false,
  };
}

const LAND_PREPARED = { status: "prepared", head: LAND_HEAD, mainTip: LAND_TIP, mergeCommit: LAND_TIP, blocking: 0, checks: [], token: "T", expiresAt: "2026-10-24T10:00:00.000Z", configKey: "k" };
const LAND_CHECKING = { checking: true, lane: "", head: LAND_HEAD, mainTip: LAND_TIP, mergeCommit: LAND_TIP };
const LAND_FAILED = { ...LAND_PREPARED, blocking: 1, checks: [{ name: "test", status: "fail", severity: "blocking", detail: "✖ boom" }] };
const LAND_ENV = { ...LAND_PREPARED, blocking: 1, checks: [{ name: "test", status: "fail", severity: "blocking", detail: LAND_CUT }] };
const structureRow = (structure, detail = "本流 10 / 取り込み 12（+2）") => ({ name: "structure/duplicate-tokens", status: "fail", severity: "blocking", detail, structure });
const LAND_GREW = { ...LAND_PREPARED, blocking: 1, checks: [structureRow({ kind: "increase", command: ["node", "count.mjs"] })] };
const LAND_UNTAKEN_MAINLINE = { ...LAND_PREPARED, blocking: 1, checks: [structureRow({ kind: "unmeasured", sides: ["mainline"] }, "本流の先端の数を測れませんでした")] };
const LAND_UNTAKEN_MERGED = { ...LAND_PREPARED, blocking: 1, checks: [structureRow({ kind: "unmeasured", sides: ["merged"] }, "取り込む側の数を測れませんでした")] };
const LAND_SWEEP = { "call|carry_sweep|settle": { result: null } };
/** the facts of a lane whose group was checked at the mainline tip, or whose record is of an earlier tip (`behind`) */
const checkedWith = (lane, record) => ({ [`checked|${lane}|`]: record, ...LAND_SWEEP });
const behindWith = (lane, record, ...more) => Object.assign({ [`behind|${lane}|`]: record }, ...more);
/** the check of a new tip the sweep leaves to a fresh group, answered as one that started at the tip the record was counted at */
const LAND_FRESH_AT_OLD_TIP = { "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { ...LAND_CHECKING, mainTip: LAND_OLD_TIP } } };
const rechecked = (cause, times = 1) => (lane) => Array.from({ length: times }, () => landRecheckRow(lane, { cause }));
const sendBackSettle = (result, keep) => ({ "call|send_back_land_check_failure|settle": { result, ...(keep ? { keep } : {}) } });
const LAND_SETTLE_KEEP = { id: "", head: LAND_HEAD, mainTip: LAND_TIP, branch: "work-main", reason: LAND_CUT, attempt: 1 };
const LAND_REAL_KEEP = { ...LAND_SETTLE_KEEP, reason: "変更の失敗と読んだ検査 test を、同じ head と本流の先端で検査し直します", cause: "real" };

/** a line of the group's check again, as the tick writes it */
const landRecheckRow = (lane, attrs) => ({ idd_id: lane, event: "s4_land_recheck", at: new Date(LAND_AT - 10 * 60_000).toISOString(), attrs: { head: LAND_HEAD, main_tip: LAND_TIP, attempt: 1, ...attrs } });

const landScenarios = {
  "何も無い（カード）": ["scan", () => ({})],
  "検査が通って署名待ち": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_PREPARED })],
  "検査が走っている": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`runChecking|${lane}|`]: true })],
  "未レビューの変更": ["scan", (lane) => ({ [`unreviewed|${lane}|`]: { reason: "レビューが見ていない変更", seen: LAND_OLD_TIP } })],
  "積み上げの前提待ち": ["scan", (lane) => ({ [`stacked|${lane}|`]: "積み上げの前提がまだ入っていません" })],
  "新しい検査が走る": ["scan", () => ({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { ...LAND_CHECKING, inherit: { mainTip: LAND_OLD_TIP, checks: [{ name: "code", status: "pass", severity: "blocking" }] } } } })],
  "新しい検査が上限で待つ": ["scan", () => ({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { ...LAND_CHECKING, waiting: "空きができると次の tick が検査します" } } })],
  "新しい検査が衝突する": ["scan", () => ({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { ...LAND_PREPARED, conflict: ["app.txt"] } } })],
  "新しい検査が始まらない": ["scan", () => ({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { ...LAND_PREPARED, reason: "work 側の checkout に commit していない変更があります" } } })],
  "変更の失敗を差し戻す": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, "call|carry_sweep|settle": { result: null }, "call|send_back_land_check_failure|settle": { result: true } })],
  "変更の失敗を差し戻せない": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, "call|carry_sweep|settle": { result: null }, "call|send_back_land_check_failure|settle": { result: false, keep: { id: lane, head: LAND_HEAD, names: "test" } } })],
  "変更の失敗が待ちの内": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "done", ended_at: new Date(LAND_AT - 30_000).toISOString() }, "call|carry_sweep|settle": { result: null } })],
  "変更の失敗を検査し直す": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "done", ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: LAND_CHECKING, keep: { ...LAND_REAL_KEEP, id: lane } } })],
  "変更の失敗の検査し直しが動いた先端で始まる": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "done", ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: { ...LAND_CHECKING, mainTip: LAND_OLD_TIP }, keep: { ...LAND_REAL_KEEP, id: lane, attempt: 2 } } })],
  "環境の失敗の検査し直しが動いた先端で始まる": ["scan", (lane) => ({ [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "failed", error: LAND_CUT, ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: { ...LAND_CHECKING, mainTip: LAND_OLD_TIP }, keep: { ...LAND_SETTLE_KEEP, id: lane, attempt: 3 } } })],
  // the first check of a pair the mainline moved to is written with `moved`, and the count leaves it out
  "変更の失敗の組の最初の検査が動いた先端で始まった記録": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "done", ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null } }), (lane) => [landRecheckRow(lane, { cause: "real", moved: { from_main_tip: LAND_OLD_TIP } })]],
  "変更の失敗の組の検査し直しの記録": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_FAILED, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "done", ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null } }), (lane) => [landRecheckRow(lane, { cause: "real" })]],
  "環境の失敗の組の最初の検査が動いた先端で始まった記録": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_ENV, [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "failed", error: LAND_CUT, ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null } }), (lane) => [1, 2, 3].map(() => landRecheckRow(lane, { cause: "environment", moved: { from_main_tip: LAND_OLD_TIP } }))],
  // a structure row says its own kind: a count that grew is sent back at once, at the mainline tip it was counted at and after it moved
  "構造の数が増えた（検査し直しの記録の後）": ["scan", (lane) => checkedWith(lane, LAND_GREW), rechecked("real")],
  "構造の数が増えた": ["scan", (lane) => checkedWith(lane, LAND_GREW)],
  "本流が動いた後の構造の数の増加（掃き出しの前）": ["scan", (lane) => behindWith(lane, LAND_GREW)],
  "本流が動いた後の構造の数の増加を差し戻す": ["scan", (lane) => behindWith(lane, LAND_GREW, LAND_SWEEP)],
  "本流が動いた後の構造の数の増加を差し戻した": ["scan", (lane) => behindWith(lane, LAND_GREW, LAND_SWEEP, sendBackSettle(true))],
  "本流が動いた後の構造の数の増加を差し戻せない": ["scan", (lane) => behindWith(lane, LAND_GREW, LAND_SWEEP, sendBackSettle(false, { id: lane, head: LAND_HEAD, names: "structure/duplicate-tokens" }))],
  "本流が動いた後の測れなかった数は新しい先端で検査する": ["scan", (lane) => behindWith(lane, LAND_UNTAKEN_MERGED, LAND_FRESH_AT_OLD_TIP)],
  "本流が動いた後の構造の数の増加で新しい検査が走っている": ["scan", (lane) => behindWith(lane, LAND_GREW, LAND_SWEEP, { [`runChecking|${lane}|`]: true })],
  "本流側が測れなかった数は環境の失敗として検査し直す": ["scan", (lane) => checkedWith(lane, LAND_UNTAKEN_MAINLINE)],
  "取り込む側だけが測れなかった数をもう一度測って落ちた": ["scan", (lane) => checkedWith(lane, LAND_UNTAKEN_MERGED), rechecked("real")],
  "本流側が測れなかった数の検査し直しの上限": ["scan", (lane) => checkedWith(lane, LAND_UNTAKEN_MAINLINE), rechecked("environment", 3)],
  "取り込む側だけが測れなかった数は変更の失敗として検査し直す": ["scan", (lane) => checkedWith(lane, LAND_UNTAKEN_MERGED)],
  "環境の失敗が待ちの内": ["scan", (lane) => ({ [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "failed", error: LAND_CUT, ended_at: new Date(LAND_AT - 30_000).toISOString() }, "call|carry_sweep|settle": { result: null } })],
  "環境の失敗を検査し直す": ["scan", (lane) => ({ [`run|${lane}|`]: { head: LAND_HEAD, mainTip: LAND_TIP, status: "failed", error: LAND_CUT, ended_at: new Date(LAND_AT - 5 * 60_000).toISOString() }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: LAND_CHECKING, keep: { ...LAND_SETTLE_KEEP, id: lane } } })],
  "検査し直しの上限": ["scan", (lane) => ({ [`checked|${lane}|`]: LAND_ENV, "call|carry_sweep|settle": { result: null } })],
  "承認が無い": ["carry", (lane) => ({ [`approval|${lane}|`]: null })],
  "承認の後に head が進んだ": ["carry", (lane) => ({ [`cur|${lane}|`]: LAND_OLD_TIP })],
  "本流が既に持つ（checkout が汚れている）": ["carry", (lane) => ({ [`ancestor|${lane}|`]: true, [`checkouts|${lane}|`]: "work 側の checkout に commit していない変更があります。clean にしてから merge します" })],
  "本流が既に持つ（記録と close）": ["carry", (lane) => ({ [`ancestor|${lane}|`]: true, "call|close_landed|carried": { result: { ok: true }, keep: { id: lane, commit: LAND_TIP } } })],
  "保存された検査で merge する": ["carry", (lane) => ({ [`ready|${lane}|`]: LAND_PREPARED, "call|advance_land|carry": { result: { ok: true, committed: LAND_TIP }, keep: { id: lane, head: LAND_HEAD } } })],
  "merge が待つ": ["carry", (lane) => ({ [`ready|${lane}|`]: LAND_PREPARED, "call|advance_land|carry": { result: { ok: true, held: "本流が進みました。次の tick が検査し直して merge します" }, keep: { id: lane, head: LAND_HEAD } } })],
  "承認の検査が衝突する": ["carry", (lane) => ({ [`saved|${lane}|`]: { ...LAND_PREPARED, conflict: ["app.txt"] } })],
  "承認の検査が落ちた": ["carry", (lane) => ({ [`saved|${lane}|`]: { ...LAND_PREPARED, blocking: 2 } })],
  "承認の検査を始め直す": ["carry", (lane) => ({ "call|prepare_land|approved": { result: LAND_CHECKING, keep: { id: lane } } })],
  "承認の検査が始まらない": ["carry", () => ({ "call|prepare_land|approved": { result: { ...LAND_PREPARED, reason: "公開する repo の lane は merge の対象ではありません" }, keep: { id: "" } } })],
};

/** the observations of a lane with nothing in the way: both readings start from these, and a scenario moves them */
function submitFactsOf(lane, started) {
  return {
    [`head|${lane}|`]: SUBMIT_HEAD,
    [`now|${lane}|`]: SUBMIT_NOW,
    [`proposal|${lane}|`]: null,
    [`unsaved|${lane}|`]: null,
    [`unsavedOutdated|${lane}|`]: false,
    [`pr|${lane}|`]: null,
    [`shipFailedAt|${lane}|${started}`]: null,
    [`location|${lane}|`]: true,
    [`outdated|${lane}|`]: { reason: null, threw: false },
    [`unreviewed|${lane}|`]: null,
    [`carries|${lane}|`]: false,
    [`unpublished|${lane}|`]: true,
    [`openPr|${lane}|`]: false,
    [`runnerDraft|${lane}|`]: false,
    [`prDraft|${lane}|`]: null,
    [`prDraftFailed|${lane}|${started}`]: false,
    [`submitView|${lane}|`]: { title: "feat: 題", body: "- 本文" },
    [`gone|${lane}|`]: null,
  };
}

/** the observation the fold asks for that a scenario did not name: the reading of a lane with nothing in the way */
function defaultSubmitFact(need) {
  switch (need.kind) {
    case "proposal": return null;
    case "unsaved": return null;
    case "unsavedOutdated": return false;
    case "pr": return null;
    case "shipFailedAt": return null;
    case "location": return true;
    case "outdated": return { reason: null, threw: false };
    case "unreviewed": return null;
    case "carries": return false;
    case "carriesOf": return false;
    case "unpublished": return true;
    case "openPr": return false;
    case "runnerDraft": return false;
    case "prDraft": return null;
    case "prDraftFailed": return false;
    case "submitView": return { title: "feat: 題", body: "- 本文" };
    case "gone": return null;
    default: return null;
  }
}

// the facts the remaining readings take: every combination of the readings a pass gathers about a worktree, and the
// readings of a repo that publishes and one whose runner cannot draft
const RETIRE_FACTS = [];
for (const hasWorktreePath of [true, false]) {
  for (const hasLocalPath of [true, false]) {
    for (const hasWorkBase of [true, false]) {
      for (const exists of [true, false]) RETIRE_FACTS.push({ hasWorktreePath, hasLocalPath, hasWorkBase, exists });
    }
  }
}
const KEPT_FACTS = [{ path: "/w", reason: "session" }, { path: "/w", reason: "dirty" }, { path: "/x", reason: "session" }];
const DRAFT_FACTS = [
  { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: false },
  { publishes: false, hasDraftRunner: true, hasPrDraft: false, openPr: false },
  { publishes: true, hasDraftRunner: false, hasPrDraft: false, openPr: false },
  { publishes: true, hasDraftRunner: true, hasPrDraft: true, openPr: false },
  { publishes: true, hasDraftRunner: true, hasPrDraft: false, openPr: true },
];

let submitCompared = 0;
let stepCompared = 0;
let landStepCompared = 0;
let readCompared = 0;
for (const [lane, rows] of byLane) {
  // the step of every prefix of the lane, read once: the waiting time's answer compares them. The waiting time
  // reads the observation over the lane's whole record (`quotaFactOfAny`), so its prefixes are read that way too
  const steps = [];
  for (let k = 0; k <= rows.length; k += 1) {
    steps.push(turnRef.turnStepReference(rows.slice(0, k), { pendingEnvelope: false, cardBuildable: true, awaitedAgent: null }, quotaFactOfAny(rows.slice(0, k))));
  }
  for (let n = 1; n <= rows.length; n += 1) {
    const prefix = rows.slice(0, n);
    prefixes += 1;
    const where = `${lane} の ${n} 行目まで`;
    if (!isDeepStrictEqual(normal(loopRef.reviewLoopState(prefix)), normal(laneAnswer("state", prefix)))) report(`${where}の巡の状態`, loopRef.reviewLoopState(prefix), laneAnswer("state", prefix));
    if (!isDeepStrictEqual(normal(stageRef.deriveStageReference(prefix)), normal(laneAnswer("stage", prefix)))) report(`${where}の段`, stageRef.deriveStageReference(prefix), laneAnswer("stage", prefix));
    const ended = prefix.some((e) => e.event === "lane_close" || e.event === "s1_defer" || e.event === "s3_defer");
    if (ended !== laneAnswer("lane_ended", prefix)) report(`${where}の終わり`, ended, laneAnswer("lane_ended", prefix));
    const landed = prefix.some((e) => e.event === "s4_land_merged" || e.event === "s4_merged" || (e.event === "lane_close" && Boolean(e.attrs?.merged_commit)));
    if (landed !== laneAnswer("lane_landed", prefix)) report(`${where}の着地`, landed, laneAnswer("lane_landed", prefix));
    // the remaining readings: the PR a lane waits on, its end, the worktree a pass retires, the kept's record and
    // the PR text it drafts, over the same rows and the same facts on both sides (C-205-6)
    {
      const mine = reads.awaitingMerge(prefix);
      const theirs = readsRef.awaitingMergeReference(prefix);
      readCompared += 1;
      if (!isDeepStrictEqual(normal(mine), normal(theirs))) report(`${where}の PR 待ち`, theirs, mine);
      const endsMine = reads.laneEnds(prefix);
      const endsTheirs = readsRef.laneEndsReference(prefix);
      if (!isDeepStrictEqual(normal(endsMine), normal(endsTheirs))) report(`${where}の lane の終わり`, endsTheirs, endsMine);
      for (const facts of RETIRE_FACTS) {
        for (const extra of KEPT_FACTS) {
          const named = { ...facts, ...extra };
          const pickMine = reads.retirePick(prefix, facts);
          const pickTheirs = readsRef.retirePickReference(prefix, facts);
          readCompared += 1;
          if (pickMine !== pickTheirs) report(`${where}の退役の対象（${JSON.stringify(facts)}）`, pickTheirs, pickMine);
          const keptMine = reads.retireKept(prefix, named);
          const keptTheirs = readsRef.retireKeptReference(prefix, named);
          readCompared += 1;
          if (keptMine !== keptTheirs) report(`${where}の退役の記録（${JSON.stringify(named)}）`, keptTheirs, keptMine);
        }
      }
      for (const facts of DRAFT_FACTS) {
        const mineRead = reads.prDraftPick(prefix, facts, () => ({ hasView: true, hasRepo: true }));
        const theirsRead = readsRef.prDraftPickReference(prefix, { ...facts, hasView: true, hasRepo: true });
        readCompared += 1;
        if (mineRead !== theirsRead) report(`${where}の PR の下書き（${JSON.stringify(facts)}）`, theirsRead, mineRead);
        const withoutMaterial = reads.prDraftPick(prefix, facts, () => ({ hasView: false, hasRepo: true }));
        const theirsWithout = readsRef.prDraftPickReference(prefix, { ...facts, hasView: false, hasRepo: true });
        if (withoutMaterial !== theirsWithout) report(`${where}の PR の下書き（view 無し）`, theirsWithout, withoutMaterial);
      }
    }
    // the landing's readings, at every prefix: the approval in force (head, at, close), the hold's reason, and the
    // head S3 / R2 last saw (commit and by). The R2 record's hold went with R2 (2026-10-22)
    const approvalRef = landRef.currentLandApprovalReference(prefix);
    const approval = laneAnswer("land_approval", prefix);
    landCompared += 1;
    if (!isDeepStrictEqual(normal(approvalRef), normal(approval))) report(`${where}の取り込みの承認`, approvalRef, approval);
    const holdRef = landRef.lastLandHoldReference(prefix);
    const hold = laneAnswer("land_hold", prefix);
    if (holdRef !== hold) report(`${where}の着地の待ち`, holdRef, hold);
    const headRef = landRef.reviewedHeadReference(prefix);
    const head = laneAnswer("reviewed_head", prefix);
    if (!isDeepStrictEqual(normal(headRef), normal(head))) report(`${where}の見た head`, headRef, head);
    // the lane's turn and the waits around it, and the stages' answer to "do you pick this lane up?"
    // the observation is read the way each reading reads it: the last word's rule for the turn and the
    // questions, and the lane's whole record's rule for the waiting time and the decision's start (C-199-6)
    const quota = quotaFactOf(prefix);
    const quotaAny = quotaFactOfAny(prefix);
    const facts = { pendingEnvelope: false, cardBuildable: true, awaitedAgent: null };
    if (!isDeepStrictEqual(normal(laneAnswer("lane_turn", prefix, { ...facts, quota })), normal(turnRef.laneTurnReference(prefix, facts, quota)))) {
      report(`${where}の番`, turnRef.laneTurnReference(prefix, facts, quota), laneAnswer("lane_turn", prefix, { ...facts, quota }));
    }
    if (!isDeepStrictEqual(normal(laneAnswer("turn_since", prefix, { ...facts, quota: quotaAny })), normal(turnRef.turnSinceReference(prefix, facts, quotaAny, steps) ?? null))) {
      report(`${where}の待ちの始まり`, turnRef.turnSinceReference(prefix, facts, quotaAny, steps), laneAnswer("turn_since", prefix, { ...facts, quota: quotaAny }));
    }
    if (!isDeepStrictEqual(normal(laneAnswer("awaiting_question", prefix, { quota })), normal(turnRef.awaitingQuestionReference(prefix, quota)))) {
      report(`${where}の答えの無い質問`, turnRef.awaitingQuestionReference(prefix, quota), laneAnswer("awaiting_question", prefix, { quota }));
    }
    if (!isDeepStrictEqual(normal(laneAnswer("awaited_agent", prefix, { quota })), normal(turnRef.awaitedAgentReference(prefix, quota)))) {
      report(`${where}の待つ agent`, turnRef.awaitedAgentReference(prefix, quota), laneAnswer("awaited_agent", prefix, { quota }));
    }
    if (!isDeepStrictEqual(normal(laneAnswer("decision_since", prefix, { quota: quotaAny })), normal(turnRef.decisionSinceReference(prefix, quotaAny) ?? null))) {
      report(`${where}の決定の時点`, turnRef.decisionSinceReference(prefix, quotaAny), laneAnswer("decision_since", prefix, { quota: quotaAny }));
    }
    for (const since of [-1, 0]) {
      if (laneAnswer("oldest_unanswered", prefix, { since }) !== stageRef.oldestUnansweredReference(prefix, since)) {
        report(`${where}の最古の未回答`, stageRef.oldestUnansweredReference(prefix, since), laneAnswer("oldest_unanswered", prefix, { since }));
      }
      if (laneAnswer("awaiting_answer", prefix, { since }) !== turnRef.awaitingAnswerReference(prefix, since)) {
        report(`${where}の回答待ちか`, turnRef.awaitingAnswerReference(prefix, since), laneAnswer("awaiting_answer", prefix, { since }));
      }
      if (!isDeepStrictEqual(normal(laneAnswer("unanswered_questions", prefix, { since })), normal(turnRef.unansweredQuestionsReference(prefix, since)))) {
        report(`${where}の未回答の質問`, turnRef.unansweredQuestionsReference(prefix, since), laneAnswer("unanswered_questions", prefix, { since }));
      }
    }
    for (const event of ["s1_go", "s1_revise_requested", "s1_granularity_answered", "s1_defer", "lane_close", "s2_start", "s4_submit_started"]) {
      if (laneAnswer("transition_refusal", prefix, { event, quota }) !== turnRef.transitionRefusalReference(event, prefix, quota)) {
        report(`${where}の${event}の断り`, turnRef.transitionRefusalReference(event, prefix, quota), laneAnswer("transition_refusal", prefix, { event, quota }));
      }
    }
    // the review loop's judgements: the fold's answer against the TypeScript's, over the same rows and the same facts
    const policy = {
      extras: { first_round: 1, high_risk: 1 },
      highRiskWhen: "last",
      finalExtra: "high",
      finalWhen: "behaviour",
      finalScope: "increment",
      orderWaitHours: 6,
      orderExcludeFiles: ["TODO.md"],
    };
    const judgeReadings = { sameTree: true, behaviour: [], risk: false };
    const judgeHead = "0".repeat(40);
    const judgeFacts = (need) => {
      if (need.kind === "sameTree") return judgeReadings.sameTree;
      if (need.kind === "behaviour") return judgeReadings.behaviour;
      if (need.kind === "risk") return judgeReadings.risk;
      if (need.kind === "head") return judgeHead;
      if (need.kind === "trialMerge") return null;
      if (need.kind === "outsideRecords") return [];
      if (need.kind === "mergeOnlySkip") return null;
      if (need.kind === "recordsCheck") return { outcome: "clean" };
      return null;
    };
    const finalRef = judgeRef.finalReviewReference(prefix, policy, judgeReadings, judgeHead);
    const finalMine = judgeSync("final_review", prefix, { policy, head: judgeHead }, judgeFacts);
    if (!isDeepStrictEqual(normal({ skip: finalRef.skip, wholeForUnread: finalRef.wholeForUnread }), normal({ skip: finalMine.skip ?? null, wholeForUnread: finalMine.wholeForUnread }))) {
      report(`${where}の最後のレビュー`, { skip: finalRef.skip, wholeForUnread: finalRef.wholeForUnread }, { skip: finalMine.skip, wholeForUnread: finalMine.wholeForUnread });
    }
    for (const kind of ["blind", "final"]) {
      const extrasRef = judgeRef.roundExtrasReference(prefix, policy, kind, false, judgeReadings);
      const extrasMine = judgeSync("round_extras", prefix, { policy, kind, conflict: false }, judgeFacts);
      if (!isDeepStrictEqual(normal(extrasRef), normal(extrasMine.extras ?? []))) report(`${where}の${kind}の役`, extrasRef, extrasMine.extras);
    }
    const orderRef = judgeRef.orderGateReference(prefix, { policy, head: judgeHead, now: 0, orderAt: 0, inScope: true, prior: [], unreadable: [] }, {});
    const orderMine = judgeSync("order_gate", prefix, { policy, now: 0, orderAt: 0, inScope: true, prior: [], unreadable: [] }, judgeFacts);
    const orderSteps = (orderMine.steps ?? []).map((step) => ({ event: step.event, attrs: step.attrs }));
    if (!isDeepStrictEqual(normal(orderRef), normal({ wait: orderMine.wait, steps: orderSteps }))) report(`${where}の順番の確かめ`, orderRef, orderSteps);
    // a lane ahead whose head cannot be read is named as a lane, never as a bare string
    const unknownRef = judgeRef.orderGateReference(prefix, { policy, head: judgeHead, now: 0, orderAt: 0, inScope: true, prior: [], unreadable: ["IDD-900"] }, {});
    const unknownMine = judgeSync("order_gate", prefix, { policy, now: 0, orderAt: 0, inScope: true, prior: [], unreadable: ["IDD-900"] }, judgeFacts);
    const unknownSteps = (unknownMine.steps ?? []).map((step) => ({ event: step.event, attrs: step.attrs }));
    if (!isDeepStrictEqual(normal(unknownRef), normal({ wait: unknownMine.wait, steps: unknownSteps }))) report(`${where}の順番の確かめ（読めない先行 lane）`, unknownRef, unknownSteps);
    // the same check with more lanes ahead than the caller's fact rounds: every trial merge is one round's
    // question, so a lane with many opponents still gets an answer (one of them collides on app.txt)
    const manyPrior = Array.from({ length: 12 }, (_, i) => ({ lane: `IDD-9${String(i).padStart(2, "0")}`, head: String(i + 1).padStart(40, "0") }));
    const merges = Object.fromEntries(manyPrior.map((p, i) => [`${judgeHead}|${p.head}`, i === 3 ? { conflict: true, files: ["app.txt"] } : { conflict: false, files: [] }]));
    const manyFacts = (need) => (need.kind === "trialMerge" ? merges[`${need.a}|${need.b}`] ?? null : judgeFacts(need));
    const manyRef = judgeRef.orderGateReference(prefix, { policy, head: judgeHead, now: 0, orderAt: 0, inScope: true, prior: manyPrior, unreadable: [] }, { trialMerge: merges });
    const manyMine = judgeSync("order_gate", prefix, { policy, now: 0, orderAt: 0, inScope: true, prior: manyPrior, unreadable: [] }, manyFacts);
    const manySteps = (manyMine.steps ?? []).map((step) => ({ event: step.event, attrs: step.attrs }));
    if (!isDeepStrictEqual(normal(manyRef), normal({ wait: manyMine.wait, steps: manySteps }))) report(`${where}の順番の確かめ（先の lane 12 本）`, manyRef, manySteps);
    for (const recordsCase of [
      { hasCheck: true, headError: "", check: { outcome: "clean" } },
      { hasCheck: false, headError: "", check: undefined },
      // a repo that declares no check and a lane whose head cannot be read: the round closes without a record
      { hasCheck: false, headError: "worktree がありません", check: undefined },
      { hasCheck: true, headError: "worktree がありません", check: undefined },
    ]) {
      const checkRef = judgeRef.recordsCheckReference(prefix, { head: recordsCase.headError ? "" : judgeHead, headError: recordsCase.headError, hasCheck: recordsCase.hasCheck, check: recordsCase.check });
      const checkMine = judgeSync("records_check", prefix, { head: recordsCase.headError ? "" : judgeHead, headError: recordsCase.headError, hasCheck: recordsCase.hasCheck }, judgeFacts);
      if (!isDeepStrictEqual(normal(checkRef), normal({ steps: checkMine.steps }))) report(`${where}の記録の検査（${JSON.stringify(recordsCase)}）`, checkRef, checkMine);
      const recheckRef = judgeRef.recordsRecheckReference(prefix, { head: recordsCase.headError ? "" : judgeHead, headError: recordsCase.headError, hasCheck: recordsCase.hasCheck, check: recordsCase.check, from: "", changed: [], skip: undefined });
      const recheckMine = judgeSync("records_recheck", prefix, { head: recordsCase.headError ? "" : judgeHead, headError: recordsCase.headError, hasCheck: recordsCase.hasCheck }, judgeFacts);
      if (!isDeepStrictEqual(normal(recheckRef), normal({ steps: recheckMine.steps }))) report(`${where}の記録の再検査（${JSON.stringify(recordsCase)}）`, recheckRef, recheckMine);
    }
    const cardRef = judgeRef.stuckOutcomesReference(prefix, policy, { head: judgeHead, laneReadable: true, deviceOn: true }, judgeReadings);
    const cardMine = judgeSync("stuck_outcomes", prefix, { policy, deviceOn: true }, judgeFacts);
    if (!isDeepStrictEqual(normal(cardRef ?? null), normal(cardMine.continue ? { continue: cardMine.continue, continueWithNote: cardMine.continueWithNote, accept: cardMine.accept, handFix: cardMine.handFix } : null))) report(`${where}の card の選択肢`, cardRef, cardMine);
    for (const stage of STAGES) {
      const stageFacts = STAGE_FACTS[stage] ?? {};
      const mine = laneAnswer("stage_pick", prefix, { stage, facts: stageFacts, quota });
      const theirs = pickRef.pickReference(stage, prefix, stageFacts, quota);
      if (!isDeepStrictEqual(normal(mine), normal(theirs))) report(`${where}の${stage}の拾う判定`, theirs, mine);
    }
    // the push's next step: the steps of the fold and of the TypeScript reading, over the same rows and the same
    // observations on both sides
    {
      const laneStarted = prefix.map((e) => e.event).lastIndexOf("s4_submit_started");
      for (const [name, makeFacts] of Object.entries(submitScenarios)) {
        // both sides read the same observations: the scenario's, and the readings of a lane with nothing in the way
        const named = { ...submitFactsOf(lane, laneStarted), ...makeFacts(lane, laneStarted) };
        const mine = judgeSync("submit_step", prefix, { facts: named }, (need) => (need.id in named ? named[need.id] : defaultSubmitFact(need)));
        const theirs = submitRef.submitStepReference(prefix, named);
        submitCompared += 1;
        if (!isDeepStrictEqual(normal(theirs), normal({ steps: mine.steps ?? [] }))) {
          report(`${where}の提出の次の一歩（${name}）`, theirs, { steps: mine.steps ?? [] });
        }
      }
    }
    // the landing's next step: the steps of the fold and of the TypeScript reading, over the same rows and the same
    // observations on both sides
    {
      for (const [name, [mode, makeFacts, makeRows]] of Object.entries(landScenarios)) {
        const named = { ...(mode === "carry" ? landCarryFactsOf(lane) : landScanFactsOf(lane)), ...makeFacts(lane) };
        // a scenario may add lines to the lane's rows: the ledger holds none of the marks a new line carries
        const rows = makeRows ? [...prefix, ...makeRows(lane)] : prefix;
        const mine = judgeSync("land_step", rows, { mode, facts: named, maxRechecks: 3, recheckIntervalMs: 120_000 }, (need) => (need.id in named ? named[need.id] : null));
        const theirs = landStepRef.landStepReference(mode, rows, named, { max: 3, intervalMs: 120_000 });
        landStepCompared += 1;
        if (!isDeepStrictEqual(normal(theirs), normal({ steps: mine.steps ?? [] }))) {
          report(`${where}の取り込みの次の一歩（${name}）`, theirs, { steps: mine.steps ?? [] });
        }
      }
    }
    // the loop's next step: the leg the lane steps on and the record that leg writes, over the same rows and the
    // same facts on both sides
    for (const [name, stepFacts] of Object.entries(STEP_FACTS)) {
      const mine = laneAnswer("next_step", prefix, stepFacts);
      const theirs = nextRef.nextStepReference(prefix, stepFacts);
      stepCompared += 1;
      if (!isDeepStrictEqual(normal(theirs), normal(mine))) report(`${where}の次の一歩（${name}）`, theirs, mine);
    }
    turnCompared += 1;
    if (differed > 5) break;
  }
  if (differed > 5) break;
}
console.log(`lane の導出: ${byLane.size} lane / ${prefixes} の途中の列を比べた（取り込みの読みで ${landCompared} の承認、番と待ちと 13 段の判定で ${turnCompared} の列、次の一歩で ${stepCompared} の答え、提出の次の一歩で ${submitCompared} の答え、取り込みの次の一歩で ${landStepCompared} の答え、残りの読みで ${readCompared} の答えを比べた）`);


// --- the startup stages and the pre-review merge: the steps the fold answers and the steps the TypeScript reads,
// over the same rows and the same observations. Each scenario is one reading of the outside world: a runner, a
// slot's cap, a worktree that cannot be made, a plan record that cannot be written, a contract that is empty, a
// review whose runs all failed, a head that carries the mainline, a first conflict and a second one, and the merge
// that goes in. The rows a written step leaves are handed back to the fold, as the driver does, so a record that
// stops two answers of the same skip or the same conflict is compared too (C-205-1, C-205-5).
const objOf = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {});

/** one answer's steps run: a write joins the rows, a call's answer is kept under the fact it named */
function driveSteps(ask, rows, facts, answers, lane) {
  const read = [...rows];
  const given = { ...facts };
  const trail = [];
  for (let round = 0; round < 24; round += 1) {
    const answer = ask(read, { ...given });
    if (Array.isArray(answer.needs)) return { trail, needs: answer.needs };
    const list = answer.steps ?? [answer];
    if (!list.length) return { trail, action: "none" };
    for (const step of list) {
      trail.push(step);
      if (step.do === "action") {
        return { trail, action: step.action, ...(step.reason ? { reason: step.reason } : {}), ...(step.error ? { error: step.error } : {}) };
      }
      if (step.do === "write") {
        read.push({ idd_id: lane, event: step.event, at: `2026-10-23T10:${String(read.length).padStart(2, "0")}:00.000Z`, attrs: step.attrs ?? {} });
        if (step.action) return { trail, action: step.action };
        continue;
      }
      const key = `call|${step.helper}|${step.site}`;
      given[step.fact] = { result: step.fact in given ? objOf(given[step.fact]).result : (answers[key] ?? {}), keep: step.keep ?? {} };
    }
  }
  return { trail, error: "rounds over" };
}

// ---- the startup stages: one lane's planner, executor and plan review, at every prefix ----
const startFacts = (lane, extra = {}) => ({
  lane,
  limit: 2,
  started: 0,
  runner: true,
  sessions: [],
  hold: "",
  sessionShape: "",
  declared: true,
  runnerStart: true,
  runnerStatus: true,
  ...extra,
});

const START_SCENARIOS = {
  "何も無い": [{}],
  "runner が無い": [{}, { runner: false }],
  "engine の入れ替え待ち": [{}, { hold: "engine を入れ替え中" }],
  "枠が埋まっている": (lane) => [{}, { started: 2, sessions: [{ idd_id: lane, kind: "" }] }],
  "fix の session は枠を占めない": (lane) => [{ started: 2, sessions: [{ idd_id: lane, kind: "fix" }] }],
  "セッションの記録が無い": [{ started: 1 }],
  "worktree が作れない": [
    {},
    { "call|ensure_worktree|prep": { error: "場所が無い" }, "call|ensure_worktree|exec": { error: "場所が無い" } },
    { "call|ensure_worktree|prep": { error: "容量が足りません", hold: "storage が埋まっています" }, "call|ensure_worktree|exec": { error: "容量が足りません", hold: "storage が埋まっています" } },
  ],
  "worktree が none": [
    {},
    { "call|ensure_worktree|prep": { none: true }, "call|ensure_worktree|exec": { none: true } },
  ],
  "quota の窓": [
    {},
    { "call|spawn|prep": { error: "quota", quota: { reason: "5 時間の窓" } } },
    { "call|spawn|exec": { error: "quota", quota: { reason: "5 時間の窓" } }, "call|ensure_worktree|exec": { path: "/w" }, "call|transition_refusal|s2_start": {}, "call|read_contract|exec": {}, "call|commit_records|exec": {} },
    { "call|deliver|prep": { error: "quota", quota: { reason: "週の窓" } }, "call|ensure_worktree|prep": { path: "/w" }, "call|spawn|prep": { sessionId: "S" }, "call|record_session|prep": {}, "call|record_quota_fallbacks|prep": {} },
  ],
  "計画の記録を書けない": [
    {},
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|write_plan_records|exec": { error: "列が読めません" } },
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|write_plan_records|exec": { ok: false } },
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|write_plan_records|exec": { ok: true, done: false } },
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|write_plan_records|exec": { ok: true, done: true, attrs: { choices: 2 } } },
  ],
  "契約が空": [
    {},
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|read_contract|exec": { empty: true } },
  ],
  "s2_start が断られる": [
    {},
    { "call|transition_refusal|s2_start": { reason: "中断されました" } },
  ],
  "session を取り下げる": [
    {},
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|read_contract|exec": {}, "call|commit_records|exec": {}, "call|spawn|exec": { sessionId: "S" }, "call|write_start|exec": { reason: "動いています" }, "call|discard_session|exec": { left: "（session を畳みました）" } },
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|read_contract|exec": {}, "call|commit_records|exec": {}, "call|spawn|exec": { sessionId: "S" }, "call|write_start|exec": { error: "書けません" } },
  ],
  "記録の commit が失敗する": [
    { "call|transition_refusal|s2_start": {}, "call|ensure_worktree|exec": { path: "/w" }, "call|read_contract|exec": {}, "call|commit_records|exec": { error: "commit できません" } },
  ],
  "計画の査読の run が全部失敗": [
    {},
    { "call|planner_worktree|start": { path: "/w" }, "call|start_runs|start": { runs: [{ runId: "R1", role: "pa" }, { runId: "R2", model: "m" }] }, "call|run_status|R1": { state: "failed", error: "boom" }, "call|run_status|R2": { state: "failed", error: "bang" } },
    { "call|planner_worktree|start": { path: "/w" }, "call|start_runs|start": { runs: [], failed: [{ role: "x", error: "no" }] } },
  ],
  "計画の査読の run が通る": [
    {},
    {
      "call|planner_worktree|start": { path: "/w" },
      "call|start_runs|start": { runs: [{ runId: "R1", role: "pa" }, { runId: "R2", role: "pa", model: "m2" }], failed: [{ role: "x", error: "no" }] },
      "call|run_status|R1": { state: "done", findings: [{ severity: "must", claim: "c", path: "a.ts" }, { severity: "nit", claim: "d" }], reportMd: "/r1.md", fallbacks: [{ role: "pa" }] },
      "call|run_status|R2": { state: "done", findings: [{ severity: "should", claim: "e", source: "自分の名" }], reportMd: "/r2.md" },
      "call|merge_findings|review": { findings: [{ severity: "must", claim: "c", path: "a.ts" }, { severity: "nit", claim: "d" }, { severity: "should", claim: "e", source: "自分の名" }] },
      "call|has_plan|review": { hasPlan: true },
    },
    {
      "call|planner_worktree|start": { path: "/w" },
      "call|start_runs|start": { runs: [{ runId: "R1", role: "pa" }], run_ids: ["R1"] },
      "call|run_status|R1": { state: "done", findings: [], reportMd: "/r1.md" },
      "call|merge_findings|review": { findings: [] },
      "call|has_plan|review": { hasPlan: false },
    },
  ],
  "計画の査読が run の途中": [
    {},
    { "call|planner_worktree|start": { path: "/w" }, "call|start_runs|start": { runs: [{ runId: "R1" }], run_ids: ["R1"] }, "call|run_status|R1": { state: "running" } },
  ],
  "計画の査読の run が始まらない": [
    { "call|planner_worktree|start": { path: "/w" }, "call|start_runs|start": { error: "runner が落ちた" } },
    { "call|planner_worktree|start": { path: "/w" }, "call|start_runs|start": { error: "quota", quota: { reason: "窓" } } },
    { "call|planner_worktree|start": { none: true } },
  ],
  "計画の査読が宣言されていない": [{}, { declared: false }],
  "計画の査読の枠が無い": [{ runnerStart: false }, { started: 2 }],
};

const START_OPS = [
  ["start_prep", (rows, facts) => startStepRef.startPrepReference(rows, facts)],
  ["start_exec", (rows, facts) => startStepRef.startExecReference(rows, facts)],
  ["start_plan_review", (rows, facts) => startStepRef.startPlanReviewReference(rows, facts)],
];

let startCompared = 0;
for (const [lane, rows] of byLane) {
  for (let n = 1; n <= rows.length; n += 1) {
    const prefix = rows.slice(0, n);
    for (const [op, reference] of START_OPS) {
      for (const [name, makeFacts] of Object.entries(START_SCENARIOS)) {
        const readings = typeof makeFacts === "function" ? makeFacts(lane) : makeFacts;
        for (const [index, extra] of readings.entries()) {
          const facts = startFacts(lane, extra);
          const answers = Object.fromEntries(Object.entries(facts).filter(([k]) => k.startsWith("call|")));
          const plain = Object.fromEntries(Object.entries(facts).filter(([k]) => !k.startsWith("call|")));
          const mine = driveSteps((readNow, f) => laneAnswer(op, readNow, { facts: f }), prefix, plain, answers, lane);
          const theirs = driveSteps((readNow, f) => reference(readNow, f), prefix, plain, answers, lane);
          startCompared += 1;
          if (!isDeepStrictEqual(normal(mine), normal(theirs))) report(`${lane} ${n} 行目まで / ${op} / ${name}#${index}`, theirs, mine);
        }
      }
    }
  }
}

// ---- the pre-review merge: the same rows, and the rows the answers themselves leave ----
const CONFLICT_ROW = (lane) => ({ idd_id: lane, event: "s2_review_base_conflict", at: "2026-10-23T11:00:00.000Z", attrs: { head: "head", mainline: "tip", files: ["app.txt"], awaiting: true } });
const INSTRUCTED_ROW = (lane) => ({ idd_id: lane, event: "s2_review_base_instructed", at: "2026-10-23T11:01:00.000Z", attrs: { head: "head", mainline: "tip", files: ["app.txt"] } });
const SKIP_ROW = (lane) => ({ idd_id: lane, event: "s2_review_base_skipped", at: "2026-10-23T11:02:00.000Z", attrs: { head: "head", mainline: "tip", reason: "lane に未 commit の変更があります" } });
const BLIND_SKIP_ROW = (lane) => ({ idd_id: lane, event: "s2_review_base_skipped", at: "2026-10-23T11:03:00.000Z", attrs: { reason: "レビュー前の merge に要る commit を読めません: " } });

const mergeFacts = (extra = {}) => ({
  "hasLocation||": true,
  "publishes||": false,
  "hasLocalPath||": true,
  "hasWorkBase||": true,
  "baseReadable||": true,
  "hasReviewBase||": true,
  "head||": "head",
  "mainTip||": "tip",
  "readError||": "",
  "ancestor||": { headHas: false, baseHas: false },
  "ancestorError||": "",
  "runnerPresent||": true,
  "busy||": false,
  "busyError||": "",
  ...extra,
});

const LOCKED = { "call|lock_lane|merge": { held: true } };
const CLEAN = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: false, files: [], tree: "tree" } };
const CONFLICTED = { "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, conflict: true, files: ["app.txt"] } };
const MERGE_SCENARIOS = {
  "何も無い": [{}],
  "merge が入る": [
    mergeFacts(LOCKED),
    mergeFacts({ ...LOCKED, ...CLEAN, "call|review_base|merge": { reviewBase: "rb" }, "call|merge_mainline|merge": {} }),
  ],
  "衝突の初回と 2 回目": [
    mergeFacts({ ...LOCKED, ...CONFLICTED }),
    mergeFacts({ ...LOCKED, ...CONFLICTED, "call|conflict_envelope|conflict": { ok: true } }),
    mergeFacts({ ...LOCKED, ...CONFLICTED, "call|conflict_envelope|conflict": { error: "封筒が積めません" } }),
    mergeFacts({ ...LOCKED, ...CONFLICTED, "call|advance_origin|conflict": {}, "call|conflict_envelope|conflict": { ok: true } }),
  ],
  "head が本流を持つ": [
    mergeFacts({ "ancestor||": { headHas: true, baseHas: false } }),
    mergeFacts({ "ancestor||": { headHas: true, baseHas: false }, "call|review_base|head_has": { reviewBase: "rb" }, "call|record_executor_merge|head_has": {} }),
    mergeFacts({ "ancestor||": { headHas: true, baseHas: false }, "call|review_base|head_has": { error: "進めません" } }),
    mergeFacts({ "ancestor||": { headHas: true, baseHas: false }, "call|review_base|head_has": {}, "call|record_executor_merge|head_has": { error: "書けません" } }),
  ],
  "head が読めない": [
    mergeFacts({ "head||": "", "readError||": "bad object" }),
    mergeFacts({ "mainTip||": "" }),
    mergeFacts({ "head||": "", "call|advance_origin|skip": {} }),
  ],
  "lock が取れない": [mergeFacts({ "call|lock_lane|merge": { held: false, error: "取られています" } })],
  "session が動いている": [mergeFacts({ "busy||": true }), mergeFacts({ "busyError||": "読めません" })],
  "runner が無い": [mergeFacts({ "runnerPresent||": false })],
  "merge-tree が答えない": [mergeFacts({ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: true, unreadable: true, mergeError: "boom" } })],
  "worktree が汚れている": [
    mergeFacts({ ...LOCKED, "call|read_merge_state|merge": { clean: false, onBranch: true, headStill: true } }),
    mergeFacts({ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: false, headStill: true } }),
    mergeFacts({ ...LOCKED, "call|read_merge_state|merge": { clean: true, onBranch: true, headStill: false } }),
  ],
  "git の読みが落ちる": [
    mergeFacts({ ...LOCKED, "call|read_merge_state|merge": { error: "index が壊れています" } }),
    mergeFacts({ ...LOCKED, ...CLEAN, "call|review_base|merge": { error: "進めません" } }),
    mergeFacts({ ...LOCKED, ...CLEAN, "call|review_base|merge": {}, "call|merge_mainline|merge": { error: "commit が作れません" } }),
  ],
  "要否を git が答えない": [mergeFacts({ "ancestor||": null, "ancestorError||": "git が答えません" })],
  "scope の外": [mergeFacts({ "publishes||": true }), mergeFacts({ "hasLocation||": false }), mergeFacts({ "hasReviewBase||": false })],
  "事実が欠けている": [
    (() => { const f = mergeFacts(); delete f["busy||"]; return f; })(),
    (() => { const f = mergeFacts(); delete f["head||"]; return f; })(),
    (() => { const f = mergeFacts(); delete f["ancestor||"]; return f; })(),
    (() => { const f = mergeFacts(); delete f["runnerPresent||"]; return f; })(),
  ],
};

const MERGE_ROW_VARIANTS = (lane) => [[], [CONFLICT_ROW(lane)], [CONFLICT_ROW(lane), INSTRUCTED_ROW(lane)], [SKIP_ROW(lane)], [BLIND_SKIP_ROW(lane)]];

let mergeCompared = 0;
const mergeActions = new Map();
for (const [lane, rows] of byLane) {
  for (let n = 1; n <= rows.length; n += 1) {
    const prefix = rows.slice(0, n);
    for (const extraRows of MERGE_ROW_VARIANTS(lane)) {
      const read = [...prefix, ...extraRows];
      for (const [name, readings] of Object.entries(MERGE_SCENARIOS)) {
        for (const [index, facts] of readings.entries()) {
          const answers = Object.fromEntries(Object.entries(facts).filter(([k]) => k.startsWith("call|")));
          const plain = Object.fromEntries(Object.entries(facts).filter(([k]) => !k.startsWith("call|")));
          const mine = driveSteps((readNow, f) => laneAnswer("pre_merge", readNow, { facts: f }), read, plain, answers, lane);
          const theirs = driveSteps((readNow, f) => preMergeRef.preMergeReference(readNow, f), read, plain, answers, lane);
          mergeCompared += 1;
          const key = mine.action ?? (mine.needs ? "needs" : "?");
          mergeActions.set(key, (mergeActions.get(key) ?? 0) + 1);
          if (!isDeepStrictEqual(normal(mine), normal(theirs))) report(`${lane} ${n} 行目まで / pre_merge / ${name}#${index} / 行 ${extraRows.length}`, theirs, mine);
        }
      }
    }
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (differed) {
  console.error(`2 つの畳みは ${differed} か所で食い違いました（${compared} の見る側を比べた / ${seconds} 秒）`);
  process.exit(1);
}
console.log(
  `2 つの畳みは同じ答えでした（lane の状態 ${states.size} 件、意図の記録 ${compared} の見る側、${prefixes} の途中の列、${seconds} 秒）`,
);
console.log(
  `起動の三段と本流の取り込み: ${prefixes} の途中の列で ${startCompared} の起動の答えと ${mergeCompared} の取り込みの答えを比べた（取り込みの答えは ${JSON.stringify([...mergeActions])}）`,
);