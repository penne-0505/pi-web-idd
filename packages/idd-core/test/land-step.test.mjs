import assert from "node:assert/strict";
import { test } from "node:test";

import { landStepReference } from "../src/plan/land-step-reference.ts";
import { LAND_RECHECK_INTERVAL_MS, LAND_RECHECK_MAX } from "../src/plan/land-step.ts";
import { judgeSync } from "../src/ledger/review-loop.ts";

// The landing's next step, as the running tick reads it. The answer is the MoonBit fold's
// (`packages/idd-fold/land_step.mbt`); this holds it against the TypeScript reading over a lane's records and a set
// of observations, so a merge, a send-back or a check the pass starts cannot come to have two deciders (C-202-1).
// The observations are the answers of the outside world (`git`, the saved records, GitHub's run): each case hands
// the same answers to both sides.

const IDD = "IDD-1";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const OLD_TIP = "c".repeat(40);

const row = (event, attrs = {}) => ({ event, idd_id: IDD, at: "2026-10-23T10:00:00.000Z", attrs });
const atCard = [
  row("lane_open"),
  row("s1_ready"),
  row("s1_plan_review_done", { must: 0, should: 0, nit: 0 }),
  row("s1_go"),
  row("s2_start"),
  row("s2_result"),
  row("s3_ready"),
  row("s3_ok"),
  row("s4_submit_started"),
];
const approved = [...atCard, row("s4_land_approved", { head: HEAD, merge_commit: OTHER, signed: true })];

const fact = (kind, extra = "") => `${kind}|${IDD}|${extra}`;
const base = (extra = {}) => ({
  [fact("branch")]: "work-main",
  [fact("head")]: HEAD,
  [fact("now")]: 1_000_000_000,
  [fact("checked")]: null,
  [fact("runEnded")]: false,
  [fact("stacked")]: null,
  [fact("unreviewed")]: null,
  [fact("attempted")]: false,
  [fact("runChecking")]: false,
  [fact("run")]: null,
  [fact("approval")]: null,
  [fact("location")]: true,
  [fact("cur")]: HEAD,
  [fact("mainTip")]: OTHER,
  [fact("ancestor")]: false,
  [fact("mergeCommitCarried")]: false,
  [fact("checkouts")]: null,
  [fact("ready")]: null,
  [fact("saved")]: null,
  [fact("blocked")]: null,
  ...extra,
});

const check = (name, status, severity = "blocking", detail = "") => ({ name, status, severity, detail });
const prepared = (extra = {}) => ({ iddId: IDD, branch: "lane/idd-1", head: HEAD, workBase: "work-main", mainTip: OTHER, mergeCommit: OTHER, checks: [], blocking: 0, token: "T", expiresAt: "2026-10-24T10:00:00.000Z", configKey: "k", status: "prepared", ...extra });
const checking = (extra = {}) => ({ checking: true, lane: IDD, head: HEAD, mainTip: OTHER, mergeCommit: OTHER, ...extra });
const recheck = (at, inherit = undefined, cause = undefined, moved = undefined) => row("s4_land_recheck", { head: HEAD, main_tip: OTHER, attempt: 1, ...(inherit ? { inherit } : {}), ...(cause ? { cause } : {}), ...(moved ? { moved } : {}) });
const TRIES = [recheck("900"), recheck("910"), recheck("920")];
const TRIES_USED = [...atCard, ...TRIES];
const realFailed = (extra = {}) => base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test:lane", "fail", "blocking", "1 tests failed:\n✖ boom")] }), "call|carry_sweep|settle": { result: null }, ...extra });
const structureRow = (kind, extra = {}, detail = "本流 10 / 取り込み 12（+2）") => ({ name: "structure/duplicate-tokens", status: "fail", severity: "blocking", detail, structure: { kind, ...extra } });
const structureFailed = (row) => prepared({ blocking: 1, checks: [row] });
const behindFacts = (record, extra = {}) => base({ [fact("behind")]: record, ...extra });
const SETTLE = { "call|carry_sweep|settle": { result: null } };
const settledCase = (row, extra = {}, rows = undefined) => scan(base({ [fact("checked")]: structureFailed(row), ...SETTLE, ...extra }), rows);
const behindCase = (row, extra = {}, rows = undefined) => scan(behindFacts(structureFailed(row), extra), rows);
const FRESH_AT_OLD_TIP = { "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: checking({ mainTip: OLD_TIP }) } };
const GREW = structureRow("increase");
const UNMEASURED_MAINLINE = structureRow("unmeasured", { sides: ["mainline"] }, "本流の先端の数を測れませんでした");
const UNMEASURED_MERGED = structureRow("unmeasured", { sides: ["merged"] }, "取り込む側の数を測れませんでした");
const realKeep = { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "変更の失敗と読んだ検査 test:lane を、同じ head と本流の先端で検査し直します", cause: "real", attempt: 1 };
const realRun = (endedAt) => ({ head: HEAD, mainTip: OTHER, status: "done", ended_at: endedAt });

// a landing whose generated files could not be made again: no merge commit, no check, the failure on the record
const unbuilt = (cause, at, extra = {}) => prepared({ mergeCommit: undefined, reason: "生成物（gen.txt）を作り直せないので、検査も承認もしていません", rebuildFailure: { cause, reason: `gen.txt を作り直すコマンドが失敗しました:\nbuild-output`, paths: ["gen.txt"], at }, ...extra });
const REBUILT_AT = "2026-10-23T09:59:00.000Z";
const rebuildKeep = { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "生成物（gen.txt）をこの環境では作り直せませんでした", cause: "environment", attempt: 1 };
const rebuildFacts = (cause, extra = {}) => base({ [fact("checked")]: unbuilt(cause, REBUILT_AT), "call|carry_sweep|settle": { result: null }, ...extra });
const FRESH_REBUILT = (cause) => ({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: unbuilt(cause, REBUILT_AT) } });
const AFTER_WAIT = Date.parse("2026-10-23T10:05:00.000Z");
const later = (cause, extra = {}) => unbuilt(cause, "2026-10-23T10:05:00.000Z", extra);
// the answer of a check again of the group, with the keep the call was made with
const tried = (result, keep = rebuildKeep) => ({ "call|prepare_land|settle": { result, keep } });
const approvedSaved = (saved, now = undefined) => base({ [fact("approval")]: { head: HEAD }, [fact("saved")]: saved, ...(now ? { [fact("now")]: now } : {}) });
const approvedBuilt = (result, extra = {}) => base({ [fact("approval")]: { head: HEAD }, "call|prepare_land|approved": { result }, ...extra });
const SENT_ALREADY = { result: false, keep: { id: IDD, head: HEAD, names: "生成物の作り直し（gen.txt）" } };
const SENT_ROW = row("s4_land_check_sent_back", { head: HEAD });
const SENT_ROWS = [...atCard, SENT_ROW];
const scan = (facts, rows = atCard) => ({ mode: "scan", rows, facts });
const carry = (facts, rows = approved) => ({ mode: "carry", rows, facts });

// the answer of a check again of the environment's failure, on the group and on a tip the mainline moved to
const RETRIED = [
  ["tried again and made: the check runs", "tried again on a tip the mainline moved to", checking],
  ["tried again and not made", "tried again at a tip the mainline moved to and not made", (extra) => later("environment", extra)],
  ["tried again and the build refused: sent back at once", "tried again at a tip the mainline moved to and the build refused", (extra) => later("build", extra)],
].flatMap(([name, movedName, make]) => [
  [`a rebuild the environment could not make, ${name}`, scan(rebuildFacts("environment", tried(make())))],
  [`a rebuild the environment could not make, ${movedName}`, scan(rebuildFacts("environment", tried(make({ mainTip: OLD_TIP }), { ...rebuildKeep, attempt: 3 })))],
]);
const cases = [
  // the card: a lane with nothing in the way, then each answer the check can give
  ["nothing in the way", scan(base())],
  ["a check that passed waits for the signature", scan(base({ [fact("checked")]: prepared() }))],
  ["the signature sweep runs before a settle", scan(base({ [fact("checked")]: prepared({ blocking: 2, checks: [check("test", "pass")] }) }))],
  ["a lane the sweep carried out is left", scan(base({ [fact("checked")]: prepared({ blocking: 2 }), [fact("attempted")]: true, "call|carry_sweep|settle": { result: null } }))],
  ["the check is running", scan(base({ [fact("checked")]: prepared({ blocking: 2 }), [fact("runChecking")]: true }))],
  ["a count that grew, the mainline moved, the new tip's run ended without a result: sent back", behindCase(GREW, { ...SETTLE, [fact("runEnded")]: true })],
  ["a change the review did not see", scan(base({ [fact("unreviewed")]: { reason: "レビューが見ていない変更", seen: OLD_TIP } }))],
  ["a blocked lane", scan(base({ [fact("stacked")]: "積み上げの前提がまだ入っていません" }))],
  ["the check answers with a run", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: checking() } }))],
  ["the limit left the check waiting", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: checking({ waiting: "空きができると次の tick が検査します" }) } }))],
  ["a check that took results over", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: checking({ inherit: { mainTip: OLD_TIP, checks: [check("code", "pass")] } }) } }))],
  ["a conflict at the fresh check", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: prepared({ conflict: ["app.txt"] }) } }))],
  ["a blocked preparation", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: prepared({ reason: "work 側の checkout に commit していない変更があります" }) } }))],
  ["a prepared land with an inherit", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: prepared({ inherit: { mainTip: OLD_TIP, checks: [check("code", "pass")] } }) } }))],
  ["the lock refused the preparation", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { error: "検査が走っています", lockRefused: true } } }))],
  ["the preparation failed", scan(base({ "call|carry_sweep|fresh": { result: null }, "call|prepare_land|scan": { result: { error: "設定が変わりました" } } }))],
  // a failed check: the environment is checked again, the change is sent back, a person is asked
  ["a check the change failed, sent back", scan(base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test", "fail", "blocking", "✖ boom")] }), "call|carry_sweep|settle": { result: null }, "call|send_back_land_check_failure|settle": { result: true } }))],
  ["a check the change failed, already sent back", scan(base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test", "fail", "blocking", "✖ boom")] }), "call|carry_sweep|settle": { result: null }, "call|send_back_land_check_failure|settle": { result: false, keep: { id: IDD, head: HEAD, names: "test" } } }), [...atCard, row("s4_land_check_sent_back", { head: HEAD })])],
  ["the environment failed, the wait has not passed", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました", ended_at: "2026-10-23T09:59:30.000Z" }, "call|carry_sweep|settle": { result: null } }))],
  ["the environment failed, the wait has passed", scan(base({ [fact("now")]: Date.parse("2026-10-23T10:05:00.000Z"), [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました", ended_at: "2026-10-23T09:59:30.000Z" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: checking(), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }))],
  ["a run that died is checked again at once", scan(base({ [fact("now")]: Date.parse("2026-10-23T10:00:00.000Z"), [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "", ended_at: "2026-10-23T09:59:59.000Z" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: checking(), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }))],
  ["the re-checks are used up", scan(base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test", "fail", "blocking", "✖ boom")] }), [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null } }), [...atCard, row("s4_land_approved", { head: HEAD }), recheck("900"), recheck("910"), recheck("920")])],
  [
    "a handover line is not a re-check",
    scan(
      base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: checking(), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }),
      [...atCard, recheck("900", { from_main_tip: OLD_TIP }), recheck("910", { from_main_tip: OLD_TIP }), recheck("920", { from_main_tip: OLD_TIP }), { ...recheck("930"), event: "s4_land_held", attrs: { head: HEAD, reason: "前" } }],
    ),
  ],
  // a check the change failed is run again once on the same group, then sent back
  ["the change failed, the wait has not passed", scan(realFailed({ [fact("now")]: Date.parse("2026-10-23T10:00:30.000Z"), [fact("run")]: realRun("2026-10-23T10:00:00.000Z") }))],
  ["the change failed, the wait has passed", scan(realFailed({ [fact("now")]: Date.parse("2026-10-23T10:05:00.000Z"), [fact("run")]: realRun("2026-10-23T10:00:00.000Z") }))],
  ["the change failed, no run is kept", scan(realFailed())],
  ["the change failed, the check again started", scan(realFailed({ "call|prepare_land|settle": { result: checking(), keep: realKeep } }))],
  ["the change failed, the check again started on a tip the mainline moved to", scan(realFailed({ "call|prepare_land|settle": { result: checking({ mainTip: OLD_TIP }), keep: { ...realKeep, attempt: 2 } } }))],
  ["the change failed, the check again started on the counted group", scan(realFailed({ "call|prepare_land|settle": { result: checking(), keep: { ...realKeep, attempt: 2 } } }))],
  ["the environment failed, the check again started on a tip the mainline moved to", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: checking({ mainTip: OLD_TIP }), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "x", attempt: 3 } } }))],
  ["the change failed, the check again waits for a slot", scan(realFailed({ "call|prepare_land|settle": { result: checking({ waiting: "空きができると次の tick が検査します" }), keep: realKeep } }))],
  ["the change failed again after the check again", scan(realFailed({ [fact("now")]: Date.parse("2026-10-23T10:00:01.000Z"), [fact("run")]: realRun("2026-10-23T10:00:00.000Z") }), [...atCard, recheck("900", undefined, "real")])],
  ["the change failed again at another mainline tip", scan(realFailed({ [fact("now")]: Date.parse("2026-10-23T10:05:00.000Z"), [fact("run")]: realRun("2026-10-23T10:00:00.000Z") }), [...atCard, { ...recheck("900", undefined, "real"), attrs: { head: HEAD, main_tip: OLD_TIP, attempt: 1, cause: "real" } }])],
  ["the change failed, a check again of the environment is not its one", scan(realFailed(), [...atCard, recheck("900"), recheck("910", undefined, "environment")])],
  ["the change failed, a handover line is not its check again", scan(realFailed(), [...atCard, recheck("900", { from_main_tip: OLD_TIP }, "real")])],
  ["the environment failed beside a check again of the change", scan(base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test", "fail", "blocking", "時間の上限（5 分）で打ち切りました")] }), "call|carry_sweep|settle": { result: null } }), [...atCard, recheck("900", undefined, "real"), recheck("910", undefined, "real")])],
  ["the environment's check again keeps the mark", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: checking(), keep: { ...realKeep, cause: "environment", reason: "x" } } }))],
  ["the change failed, the first check of a pair the mainline moved to is not its check again", scan(realFailed(), [...atCard, recheck("900", undefined, "real", { from_main_tip: OLD_TIP })])],
  ["the change failed, a check again beside the first check of a moved pair", scan(realFailed(), [...atCard, recheck("900", undefined, "real", { from_main_tip: OLD_TIP }), recheck("910", undefined, "real")])],
  ["the environment failed, the first checks of a moved pair are not its checks again", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null } }), [...atCard, recheck("900", undefined, "environment", { from_main_tip: OLD_TIP }), recheck("910", undefined, "environment", { from_main_tip: OLD_TIP }), recheck("920", undefined, "environment", { from_main_tip: OLD_TIP })])],
  ["the settle's check conflicts", scan(base({ [fact("checked")]: prepared({ blocking: 1, checks: [check("test", "fail", "blocking", "✖ boom")] }), "call|carry_sweep|settle": { result: null }, "call|send_back_land_check_failure|settle": { result: false, keep: { id: IDD, head: HEAD, names: "test" } }, "call|prepare_land|settle": { result: prepared({ conflict: ["app.txt"] }), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }))],
  ["the settle holds the lane", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: prepared({ reason: "work 側の checkout を本流 work-main にしてください" }), keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }))],
  ["the settle's lock refused", scan(base({ [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "時間の上限（5 分）で打ち切りました" }, "call|carry_sweep|settle": { result: null }, "call|prepare_land|settle": { result: { error: "検査が走っています", lockRefused: true }, keep: { id: IDD, head: HEAD, mainTip: OTHER, branch: "work-main", reason: "test が時間の上限で打ち切りられました", attempt: 1 } } }))],
  // a count that grew is the head's tree: it is sent back without the check again, and also when the mainline moved since
  ["a count that grew, sent back at once", settledCase(structureRow("increase", { command: ["node", "count.mjs"] }))],
  ["a count that grew, already sent back", settledCase(GREW, { "call|send_back_land_check_failure|settle": { result: false, keep: { id: IDD, head: HEAD, names: "structure/duplicate-tokens" } } }, [...atCard, row("s4_land_check_sent_back", { head: HEAD })])],
  ["a declaration that holds less, sent back at once", settledCase(structureRow("weakened", {}, "取り込む側の宣言から止める数が外れています"))],
  ["a count that grew, the mainline moved: the sweep first", behindCase(structureRow("increase", { command: ["node", "count.mjs"] }))],
  ["a count that grew, the mainline moved: sent back", behindCase(GREW, SETTLE)],
  ["a count that grew, the mainline moved, a check again of it was asked", behindCase(GREW, SETTLE, [...atCard, recheck("900", undefined, "real")])],
  ["a count that grew, the mainline moved: sent back and sent", behindCase(GREW, { ...SETTLE, "call|send_back_land_check_failure|settle": { result: true } })],
  ["a count that grew, the mainline moved, a check of the new tip is running: sent back", behindCase(GREW, { ...SETTLE, [fact("runChecking")]: true })],
  ["a count that grew, the mainline moved, the sweep carried the lane out", behindCase(GREW, { ...SETTLE, [fact("attempted")]: true })],
  ["a count that could not be taken only in the merge commit, the mainline moved: checked afresh", behindCase(structureRow("unmeasured", { sides: ["merged"] }), FRESH_AT_OLD_TIP)],
  ["a record of the head that passed, the mainline moved: checked afresh", scan(behindFacts(prepared(), FRESH_AT_OLD_TIP))],
  ["a run that ended without a result beside a record at another tip", behindCase(GREW, { ...SETTLE, [fact("runEnded")]: true, [fact("run")]: { head: HEAD, mainTip: OTHER, status: "failed", error: "" } })],
  // a count the mainline's tree could not give is the environment's; one only the merge commit could not give is the change's
  ["a count the mainline could not give, checked again as the environment's", settledCase(UNMEASURED_MAINLINE)],
  ["a count the mainline could not give, in words of a failure of the change", settledCase(structureRow("unmeasured", { sides: ["mainline"] }, "✖ error TS2304"))],
  ["a count the mainline could not give, the checks again are used up", settledCase(UNMEASURED_MAINLINE, {}, [...atCard, recheck("900"), recheck("910"), recheck("920")])],
  ["a count only the merge commit could not give, checked again once", settledCase(UNMEASURED_MERGED)],
  ["a count only the merge commit could not give, failed again", settledCase(UNMEASURED_MERGED, {}, [...atCard, recheck("900", undefined, "real")])],
  // a landing whose generated files could not be made again: tried again for the environment, sent back for the build
  ["a rebuild the environment could not make, the sweep first", scan(base({ [fact("checked")]: unbuilt("environment", REBUILT_AT) }))],
  ["a rebuild the environment could not make, the wait has not passed", scan(rebuildFacts("environment", { [fact("now")]: Date.parse("2026-10-23T10:00:00.000Z") }))],
  ["a rebuild the environment could not make, the wait has passed", scan(rebuildFacts("environment", { [fact("now")]: AFTER_WAIT }))],
  ...RETRIED,
  ["a rebuild the environment could not make, the tries are used up", scan(rebuildFacts("environment", { [fact("now")]: AFTER_WAIT }), TRIES_USED)],
  ["a rebuild the environment could not make, the tries of the change are not its tries", scan(rebuildFacts("environment", { [fact("now")]: AFTER_WAIT }), [...atCard, recheck("900", undefined, "real"), recheck("910", undefined, "real")])],
  ["a rebuild the build refused, sent back at once", scan(rebuildFacts("build", { [fact("now")]: Date.parse("2026-10-23T09:59:01.000Z") }))],
  ["a rebuild the build refused, already sent back", scan(rebuildFacts("build", { "call|send_back_land_check_failure|settle": SENT_ALREADY }), SENT_ROWS)],
  ["a rebuild the build refused, sent", scan(rebuildFacts("build", { "call|send_back_land_check_failure|settle": { result: true } }))],
  ["a rebuild the build refused, a check of the change again is not asked first", scan(rebuildFacts("build"), [...atCard, recheck("900", undefined, "real")])],
  ["a rebuild the build refused, the mainline moved: checked afresh", scan(behindFacts(unbuilt("build", REBUILT_AT), FRESH_AT_OLD_TIP))],
  // a fresh check whose generated files could not be made again: the change's failure is sent back at the card, the environment's is held for the next tick to count
  ["a fresh rebuild the build refused, sent back at once", scan(base(FRESH_REBUILT("build")))],
  ["a fresh rebuild the build refused, sent", scan(base({ ...FRESH_REBUILT("build"), "call|send_back_land_check_failure|scan": { result: true } }))],
  ["a fresh rebuild the build refused, already sent back", scan(base({ ...FRESH_REBUILT("build"), "call|send_back_land_check_failure|scan": SENT_ALREADY }), SENT_ROWS)],
  ["a fresh rebuild the environment could not make, held", scan(base(FRESH_REBUILT("environment")))],
  // a check again of the group that meets the change's failure to rebuild is sent back in that tick, not counted as a wait
  ["a rebuild the environment could not make, tried again and the build refused: the send-back answered", scan(rebuildFacts("environment", { ...tried(later("build")), "call|send_back_land_check_failure|settle": { result: true } }))],
  ["a rebuild the environment could not make, tried again and the build refused: the send-back already sent", scan(rebuildFacts("environment", { ...tried(later("build")), "call|send_back_land_check_failure|settle": SENT_ALREADY }), SENT_ROWS)],
  // the approval whose group is built again after the mainline moved
  ["the approval's rebuild the build refused", carry(approvedBuilt(later("build")))],
  ["the approval's rebuild the environment could not make", carry(approvedBuilt(later("environment")))],
  ["the approval's rebuild the environment could not make, the tries are used up", carry(approvedBuilt(later("environment")), [...approved, ...TRIES])],
  ["the approval's rebuild the build refused: the send-back answered", carry(approvedBuilt(later("build"), { "call|send_back_land_check_failure|approved": { result: true } }))],
  ["the approval's rebuild the build refused: the send-back already sent", carry(approvedBuilt(later("build"), { "call|send_back_land_check_failure|approved": SENT_ALREADY }), [...approved, SENT_ROW])],
  // the approval of a group whose record says it was never built: the approval is dropped before the one decision reads it
  ["the approval's record never built, the environment could not make it, the wait has not passed", carry(approvedSaved(unbuilt("environment", REBUILT_AT), Date.parse("2026-10-23T09:59:01.000Z")))],
  ["the approval's record never built, the environment could not make it, the wait has passed", carry(approvedSaved(unbuilt("environment", REBUILT_AT), AFTER_WAIT))],
  ["the approval's record never built, the environment could not make it, the tries are used up", carry(approvedSaved(unbuilt("environment", REBUILT_AT), AFTER_WAIT), [...approved, ...TRIES])],
  ["the approval's record never built, the build refused", carry(approvedSaved(unbuilt("build", REBUILT_AT)))],
  ["the approval's record never built at an earlier tip is built again", carry(approvedSaved(unbuilt("build", REBUILT_AT, { mainTip: OLD_TIP })))],
  ["the approval's record from before the failure was kept apart is built again", carry(approvedSaved(prepared({ rebuildFailure: { cause: "build", reason: "x", paths: ["gen.txt"], at: REBUILT_AT } })))],
  // a check again that meets the failure once more and uses the last try up is handed to a person in that tick
  ["a rebuild the environment could not make, the last try failed", scan(rebuildFacts("environment", tried(later("environment"), { ...rebuildKeep, attempt: 3 })), [...atCard, recheck("900"), recheck("910")])],
  ["a rebuild the environment could not make, the last try failed at a tip the mainline moved to", scan(rebuildFacts("environment", tried(later("environment", { mainTip: OLD_TIP }), { ...rebuildKeep, attempt: 3 })), [...atCard, recheck("900"), recheck("910")])],
  ["a fresh rebuild the environment could not make, the tries are used up", scan(base(FRESH_REBUILT("environment")), TRIES_USED)],
  // the approval the pass carries out
  ["no approval", carry(base())],
  ["a closed lane", carry(base(), [...atCard, row("lane_close", { outcome: "merged" })])],
  ["the lane moved after the approval", carry(base({ [fact("cur")]: OLD_TIP }))],
  ["the lane is not there", carry(base({ [fact("location")]: false }))],
  ["the mainline already carries the head", carry(base({ [fact("ancestor")]: true }))],
  ["the mainline carries the checked merge", carry(base({ [fact("ancestor")]: true, [fact("mergeCommitCarried")]: true, [fact("saved")]: prepared({ mergeCommit: OTHER }) }))],
  ["the mainline carries the head, the checkout is dirty", carry(base({ [fact("ancestor")]: true, [fact("checkouts")]: "work 側の checkout に commit していない変更があります。clean にしてから merge します" }))],
  ["the records and the close are written", carry(base({ [fact("ancestor")]: true, "call|close_landed|carried": { result: { ok: true, committed: OTHER } } }))],
  ["the close failed", carry(base({ [fact("ancestor")]: true, "call|close_landed|carried": { result: { ok: false, reason: "lane を閉じられませんでした" } } }))],
  ["the saved check still stands", carry(base({ [fact("ready")]: prepared() }))],
  ["the guards stopped the merge", carry(base({ [fact("ready")]: prepared(), [fact("blocked")]: "公開 branch（custody）を持つ lane は merge できません" }))],
  ["the merge went in", carry(base({ [fact("ready")]: prepared(), "call|advance_land|carry": { result: { ok: true, committed: OTHER } } }))],
  ["the merge is held", carry(base({ [fact("ready")]: prepared(), "call|advance_land|carry": { result: { ok: true, held: "本流が進みました。次の tick が検査し直して merge します" } } }))],
  ["the merge failed", carry(base({ [fact("ready")]: prepared(), "call|advance_land|carry": { result: { ok: false, error: "merge の承認が効かなくなりました" } } }))],
  ["the approval's check conflicts", carry(base({ [fact("saved")]: prepared({ conflict: ["app.txt"] }) }))],
  ["the approval's check failed", carry(base({ [fact("saved")]: prepared({ blocking: 2 }) }))],
  ["the approval's check starts again", carry(base({ [fact("saved")]: null, "call|prepare_land|approved": { result: checking({ inherit: { mainTip: OLD_TIP, checks: [check("code", "pass")] } }) } }))],
  ["the approval's check cannot start", carry(base({ "call|prepare_land|approved": { result: prepared({ reason: "公開する repo の lane は merge の対象ではありません" }) } }))],
  ["the approval's check was refused", carry(base({ "call|prepare_land|approved": { result: { error: "設定が変わりました。検査し直してください" } } }))],
];

/** the answer the fold gives, reading the observations the answer names from the case */
function answerOf({ mode, rows, facts }) {
  return judgeSync("land_step", rows, { mode, facts, maxRechecks: LAND_RECHECK_MAX, recheckIntervalMs: LAND_RECHECK_INTERVAL_MS }, (need) => (need.id in facts ? facts[need.id] : null));
}

test("the fold answers the landing's next step the TypeScript reading gives, over every case", () => {
  for (const [where, scenario] of cases) {
    const reference = landStepReference(scenario.mode, scenario.rows, scenario.facts, { max: LAND_RECHECK_MAX, intervalMs: LAND_RECHECK_INTERVAL_MS });
    const mine = answerOf(scenario);
    assert.deepEqual(
      JSON.parse(JSON.stringify(mine.steps ?? [])),
      JSON.parse(JSON.stringify(reference.steps)),
      where,
    );
  }
});

test("the fold asks only for the observations the branch it is on reads", () => {
  // a check that passed leaves the lane where it is: the run, the approval and the saved record are not read
  const mine = answerOf(scan(base({ [fact("checked")]: prepared() })));
  assert.deepEqual(JSON.parse(JSON.stringify(mine.steps)), [{ do: "end" }]);
});

test("a fold that cannot answer is a failure, not a second reading", () => {
  // the row is not a lane at the landing: the answer still comes from the fold, and a missing observation is read
  // as none rather than decided in TypeScript (the same rows and facts give the same answer on both sides)
  const scenario = scan(base());
  assert.deepEqual(JSON.parse(JSON.stringify(answerOf(scenario).steps)), JSON.parse(JSON.stringify(landStepReference("scan", scenario.rows, scenario.facts, { max: LAND_RECHECK_MAX, intervalMs: LAND_RECHECK_INTERVAL_MS }).steps)));
});

const caseSteps = (where) => JSON.parse(JSON.stringify(answerOf(cases.find(([name]) => name === where)[1]).steps));
const stepNames = (list) => list.map((step) => `${step.do}:${step.helper ?? step.event ?? step.field ?? ""}${step.site ? `@${step.site}` : ""}`);
const SENT_BACK = ["call:send_back_land_check_failure@settle"];

test("a count that grew is sent back without the check again, whether or not the mainline moved", () => {
  const steps = caseSteps;
  const sendsBack = (where, message) => assert.deepEqual(stepNames(steps(where)), SENT_BACK, message);
  sendsBack("a count that grew, sent back at once");
  sendsBack("a declaration that holds less, sent back at once");
  // the record is of an earlier tip: the sweep runs, then the send-back is asked with that record's group
  assert.deepEqual(stepNames(steps("a count that grew, the mainline moved: the sweep first")), ["call:carry_sweep@settle"]);
  const moved = steps("a count that grew, the mainline moved: sent back");
  assert.deepEqual(stepNames(moved), SENT_BACK);
  assert.deepEqual([moved[0].args.head, moved[0].args.mainTip, moved[0].args.checks[0].name], [HEAD, OTHER, "structure/duplicate-tokens"]);
  sendsBack("a count that grew, the mainline moved, a check again of it was asked", "an earlier check again does not stand in front of it");
  assert.deepEqual(stepNames(steps("a count that grew, the mainline moved: sent back and sent")), ["result:sentBack", "end:"]);
  // the head's failed record is the failure before the new tip's run, whether it is under way or ended without a result
  sendsBack("a count that grew, the mainline moved, a check of the new tip is running: sent back");
  sendsBack("a count that grew, the mainline moved, the new tip's run ended without a result: sent back");
  assert.deepEqual(stepNames(steps("a count that grew, the mainline moved, the sweep carried the lane out")), ["end:"]);
  // another record of the head at an earlier tip is the new tip's to check
  assert.deepEqual(stepNames(steps("a count that could not be taken only in the merge commit, the mainline moved: checked afresh")), ["result:checking", "end:"], "the fresh check's answer, not a send-back");
  assert.deepEqual(stepNames(steps("a record of the head that passed, the mainline moved: checked afresh")), ["result:checking", "end:"]);
});

test("a count the mainline could not give is the environment's, one only the merge commit could not give is the change's", () => {
  const steps = caseSteps;
  const first = steps("a count the mainline could not give, checked again as the environment's");
  assert.deepEqual([first[0].helper, first[0].keep.cause], ["prepare_land", "environment"]);
  assert.equal(steps("a count the mainline could not give, in words of a failure of the change")[0].keep.cause, "environment", "the words of the detail do not make it the change's");
  const used = steps("a count the mainline could not give, the checks again are used up");
  assert.deepEqual(used.map((step) => step.do), ["write", "result", "end"], "past the three, a person is asked");
  assert.match(used[0].attrs.reason, /3 回検査し直しても通らない/);
  assert.equal(steps("a count only the merge commit could not give, checked again once")[0].keep.cause, "real");
  assert.equal(steps("a count only the merge commit could not give, failed again")[0].helper, "send_back_land_check_failure");
});

function expectSteps(where, names, message = where) {
  assert.deepEqual(stepNames(caseSteps(where)), names, message);
}
// the lane is handed to a person after the checks' own limit of tries, with why and the paths
function expectHandedOver(where, names) {
  const out = caseSteps(where);
  assert.deepEqual(stepNames(out), names, where);
  const reason = out.find((step) => step.event === "s4_land_held").attrs.reason;
  assert.match(reason, /3 回検査し直しても通らない/, where);
  assert.match(reason, /gen\.txt/, where);
}

// the call that sends the lane back for a failed rebuild: the change's cause, the paths, the build's output and the group it names
function expectRebuildSend(call, { head = HEAD, mainTip = OTHER, branch = "work-main", where = "" } = {}) {
  assert.deepEqual([call.args.rebuild.cause, call.args.rebuild.paths, call.args.checks, call.args.head, call.args.mainTip, call.args.branch], ["build", ["gen.txt"], [], head, mainTip, branch], where);
  assert.match(call.args.rebuild.reason, /build-output/, "the build's output goes to the send-back");
}

test("a landing whose generated files could not be made again is tried again for the environment and sent back for the build", () => {
  const steps = caseSteps;
  expectSteps("a rebuild the environment could not make, the sweep first", ["call:carry_sweep@settle"]);
  assert.deepEqual(steps("a rebuild the environment could not make, the wait has not passed"), [{ do: "end" }], "the wait runs from the time the failure was taken");
  const again = steps("a rebuild the environment could not make, the wait has passed");
  assert.deepEqual([again[0].helper, again[0].keep.cause, again[0].keep.attempt, again[0].args.signed], ["prepare_land", "environment", 1, false]);
  assert.match(again[0].keep.reason, /gen\.txt/);
  // the check that starts once it is made is the check of the group, counted as a check again; a try that meets the
  // failure again is counted the same, and the lane is held with why rather than shown as checking
  const counted = { head: HEAD, main_tip: OTHER, reason: rebuildKeep.reason, cause: "environment", attempt: 1 };
  for (const [name, tail, tip, extra] of [
    ["tried again and made: the check runs", "result:checking", OTHER, {}],
    ["tried again and not made", "result:held", OTHER, {}],
    ["tried again at a tip the mainline moved to and not made", "result:held", OLD_TIP, { moved: { from_main_tip: OTHER } }],
  ]) {
    const where = `a rebuild the environment could not make, ${name}`;
    const out = steps(where);
    expectSteps(where, ["write:s4_land_recheck", tail, "end:"]);
    assert.deepEqual(out[0].attrs, { ...counted, main_tip: tip, ...extra }, where);
    if (tail === "result:held") assert.match(out[1].reason, /作り直せない/, where);
  }
  expectHandedOver("a rebuild the environment could not make, the tries are used up", ["write:s4_land_held", "result:held", "end:"]);
  assert.equal(steps("a rebuild the environment could not make, the tries of the change are not its tries")[0].helper, "prepare_land");
  // the build's failure is not tried again: the same sources build the same way
  for (const where of ["a rebuild the build refused, sent back at once", "a rebuild the build refused, a check of the change again is not asked first"]) {
    const sent = steps(where);
    assert.deepEqual(stepNames(sent), SENT_BACK, where);
    expectRebuildSend(sent[0], { where });
    assert.equal(sent[0].keep.names, "生成物の作り直し（gen.txt）");
  }
  expectSteps("a rebuild the build refused, already sent back", ["write:s4_land_held", "result:held", "end:"]);
  expectSteps("a rebuild the build refused, sent", ["result:sentBack", "end:"]);
  // the mainline moved: the group is new, and it is built afresh rather than read from the old record
  expectSteps("a rebuild the build refused, the mainline moved: checked afresh", ["result:checking", "end:"]);
});

test("a try that meets the change's failure to rebuild is sent back in that tick, and the environment's is counted as before", () => {
  const steps = caseSteps;
  const sent = steps("a rebuild the environment could not make, tried again and the build refused: sent back at once");
  assert.deepEqual(stepNames(sent), SENT_BACK, "no wait row and no hold stand in the way");
  expectRebuildSend(sent[0]);
  const moved = steps("a rebuild the environment could not make, tried again at a tip the mainline moved to and the build refused");
  assert.equal(moved[0].args.mainTip, OLD_TIP, "the send-back names the pair the try was built on");
  // both answers stand together after the call: the send-back is the later one and is read first
  expectSteps("a rebuild the environment could not make, tried again and the build refused: the send-back answered", ["result:sentBack", "end:"]);
  expectSteps("a rebuild the environment could not make, tried again and the build refused: the send-back already sent", ["write:s4_land_held", "result:held", "end:"]);
  // the environment's failure keeps the row of the checks' own count, marked as the environment's even when the earlier try was the change's
  const env = steps("a rebuild the environment could not make, tried again and not made");
  assert.equal(env[0].attrs.cause, "environment");
});

test("an approval whose group is built again and cannot be drops the approval, then waits for the environment and sends back for the build", () => {
  const steps = caseSteps;
  const sent = steps("the approval's rebuild the build refused");
  assert.deepEqual(stepNames(sent), ["write:s4_land_approval_dropped", "call:send_back_land_check_failure@approved"]);
  expectRebuildSend(sent[1]);
  assert.equal(sent[0].attrs.head, HEAD);
  expectSteps("the approval's rebuild the build refused: the send-back answered", ["result:errors", "end:"]);
  expectSteps("the approval's rebuild the build refused: the send-back already sent", ["write:s4_land_held", "result:held", "end:"]);
  // the environment's failure drops the approval too, and the lane waits as any lane waits: not an error, and not a merge waiting
  const env = steps("the approval's rebuild the environment could not make");
  assert.deepEqual(stepNames(env), ["write:s4_land_approval_dropped", "result:held", "end:"]);
  assert.match(env[1].reason, /作り直せない/);
  // past the tries a person is asked with the reason, as for a check
  expectHandedOver("the approval's rebuild the environment could not make, the tries are used up", ["write:s4_land_approval_dropped", "write:s4_land_held", "result:held", "end:"]);
});

test("an approval whose record was never built is read by the same decision, the approval dropped first", () => {
  const steps = caseSteps;
  for (const where of ["the approval's record never built, the environment could not make it, the wait has not passed", "the approval's record never built, the environment could not make it, the wait has passed"]) {
    assert.deepEqual(stepNames(steps(where)), ["write:s4_land_approval_dropped", "result:held", "end:"], where);
  }
  expectHandedOver("the approval's record never built, the environment could not make it, the tries are used up", ["write:s4_land_approval_dropped", "write:s4_land_held", "result:held", "end:"]);
  const sent = steps("the approval's record never built, the build refused");
  assert.deepEqual(stepNames(sent), ["write:s4_land_approval_dropped", "call:send_back_land_check_failure@approved"]);
  expectRebuildSend(sent[1]);
  // a record of another tip is not the approved group: the group is built again, and a record with a merge commit is no unbuilt record
  for (const where of ["the approval's record never built at an earlier tip is built again", "the approval's record from before the failure was kept apart is built again"]) {
    assert.deepEqual(stepNames(steps(where)), ["call:prepare_land@approved"], where);
  }
});

test("a check again that fails once more and uses the last try up is handed to a person in that tick, the fresh check's first try is not a check again", () => {
  const steps = caseSteps;
  expectHandedOver("a rebuild the environment could not make, the last try failed", ["write:s4_land_recheck", "write:s4_land_held", "result:held", "end:"]);
  // a pair the mainline moved to starts its count at that line: it is not one of the three
  const moved = steps("a rebuild the environment could not make, the last try failed at a tip the mainline moved to");
  assert.deepEqual(stepNames(moved), ["write:s4_land_recheck", "result:held", "end:"]);
  expectHandedOver("a fresh rebuild the environment could not make, the tries are used up", ["write:s4_land_held", "result:held", "end:"]);
});

test("a fresh landing whose generated files the change cannot make again is sent back once, and the environment's is held", () => {
  const steps = caseSteps;
  const sent = steps("a fresh rebuild the build refused, sent back at once");
  assert.deepEqual(stepNames(sent), ["call:send_back_land_check_failure@scan"]);
  expectRebuildSend(sent[0]);
  assert.equal(sent[0].keep.names, "生成物の作り直し（gen.txt）");
  expectSteps("a fresh rebuild the build refused, sent", ["result:sentBack", "end:"]);
  expectSteps("a fresh rebuild the build refused, already sent back", ["write:s4_land_held", "result:held", "end:"], "the same head is not sent the same instruction twice");
  expectSteps("a fresh rebuild the environment could not make, held", ["result:held", "end:"], "the next tick reads the record and counts the try");
});

test("a check the change failed is run again once on the same group before it is sent back", () => {
  const steps = (where) => {
    const scenario = cases.find(([name]) => name === where)[1];
    return JSON.parse(JSON.stringify(answerOf(scenario).steps));
  };
  const named = (list) => list.map((step) => `${step.do}:${step.helper ?? step.event ?? step.field ?? ""}`);
  assert.deepEqual(steps("the change failed, the wait has not passed"), [{ do: "end" }], "not right after the failure");
  const first = steps("the change failed, the wait has passed");
  assert.deepEqual(named(first), ["call:prepare_land"]);
  assert.equal(first[0].keep.cause, "real");
  assert.equal(first[0].keep.attempt, 1);
  assert.match(first[0].keep.reason, /test:lane/, "the failed check is named");
  assert.equal(first[0].args.signed, false);
  const written = steps("the change failed, the check again started");
  assert.deepEqual(named(written), ["write:s4_land_recheck", "result:checking", "end:"]);
  assert.deepEqual(written[0].attrs, { head: HEAD, main_tip: OTHER, reason: realKeep.reason, cause: "real", attempt: 1 });
  // the row names the pair the check started on, and a pair of its own is counted from its first line
  const moved = steps("the change failed, the check again started on a tip the mainline moved to");
  assert.deepEqual(moved[0].attrs, { head: HEAD, main_tip: OLD_TIP, reason: realKeep.reason, cause: "real", attempt: 1, moved: { from_main_tip: OTHER } });
  assert.equal(written[0].attrs.moved, undefined, "a line on the counted group is its check again");
  assert.equal(steps("the change failed, the check again started on the counted group")[0].attrs.attempt, 2);
  const movedEnvironment = steps("the environment failed, the check again started on a tip the mainline moved to");
  assert.deepEqual([movedEnvironment[0].attrs.main_tip, movedEnvironment[0].attrs.attempt, movedEnvironment[0].attrs.cause], [OLD_TIP, 1, "environment"]);
  assert.deepEqual(named(steps("the change failed, the check again waits for a slot")), ["end:"]);
  assert.deepEqual(named(steps("the change failed again after the check again")), ["call:send_back_land_check_failure"]);
  assert.deepEqual(named(steps("the change failed again at another mainline tip")), ["call:prepare_land"], "another tip is another group");
  assert.deepEqual(named(steps("the change failed, a check again of the environment is not its one")), ["call:prepare_land"]);
  assert.deepEqual(named(steps("the change failed, a handover line is not its check again")), ["call:prepare_land"]);
  // the first check of a pair the mainline moved to is that pair's first check: its failure is checked again, not sent back
  assert.deepEqual(named(steps("the change failed, the first check of a pair the mainline moved to is not its check again")), ["call:prepare_land"]);
  assert.deepEqual(named(steps("the change failed, a check again beside the first check of a moved pair")), ["call:send_back_land_check_failure"], "the check again after it is counted");
  assert.deepEqual(named(steps("the environment failed, the first checks of a moved pair are not its checks again")), ["call:prepare_land"], "the environment's three start from the pair's first check");
  const environment = steps("the environment's check again keeps the mark");
  assert.equal(environment[0].attrs.cause, "environment");
  // the environment's three are its own: two checks again of the change do not use them
  assert.deepEqual(named(steps("the environment failed beside a check again of the change")), ["call:prepare_land"]);
});
