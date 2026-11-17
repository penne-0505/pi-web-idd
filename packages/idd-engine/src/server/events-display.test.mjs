import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { EVENT_META, buildTimeline } = await jiti.import("./events-display.ts");

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [readFileSync(p, "utf8")] : [];
  });
}

test("every event the engine records has a label on the timeline, so none shows up as its raw name", () => {
  const emitted = new Set();
  for (const src of [...sources("packages/idd-core/src"), ...sources("lib")]) {
    // the name can be chosen in the call (a ternary between two events), so take every literal in the first argument
    for (const m of src.matchAll(/appendLifecycle\(([^,]+),/g)) {
      for (const n of m[1].matchAll(/(?:^|[?:]\s*)"([a-z0-9_]+)"/g)) emitted.add(n[1]);
    }
    // the write gate: the event is its second argument, and `decide` writes through its own `write(event, ...)`
    for (const m of src.matchAll(/\btransition\(\s*[^,]+,\s*([^,]+),/g)) {
      for (const n of m[1].matchAll(/(?:^|[?:]\s*)"([a-z0-9_]+)"/g)) emitted.add(n[1]);
    }
    for (const m of src.matchAll(/\bawait write\(([^,]+),/g)) {
      for (const n of m[1].matchAll(/(?:^|[?:]\s*)"([a-z0-9_]+)"/g)) emitted.add(n[1]);
    }
    // the records a gate write carries after its event (`then: [{ event: ... }]`, a ternary between two included)
    for (const m of src.matchAll(/\bthen:\s*\[([\s\S]*?)\]/g)) {
      for (const n of m[1].matchAll(/\bevent:\s*"([a-z0-9_]+)"/g)) emitted.add(n[1]);
    }
  }
  // the scan reaches the events written only through the gate
  for (const e of ["s1_go", "s2_start", "s3_ready", "s3_check_clean", "s3_check_conflict", "s4_submit_started", "s4_verify_started", "lane_open", "lane_close"]) {
    assert.ok(emitted.has(e), e);
  }
  const missing = [...emitted].filter((e) => !EVENT_META[e]).sort();
  assert.deepEqual(missing, []);
});

test("AC-014: a follow-up record is not shown as written to the TODO, and an old one still shows its files", () => {
  const at = "2026-10-15T09:00:00+09:00";
  const t = buildTimeline([
    { event: "s3_followups_written", idd_id: "IDD-1", at, attrs: { entries: [{ severity: "should", claim: "x" }] } },
    { event: "s3_followups_written", idd_id: "IDD-1", at, attrs: { entries: [{ severity: "should", claim: "y" }], files: ["TODO.md"] } },
  ]);
  assert.equal(t[0].title, "follow-up を記録");
  assert.equal(t[0].items[0].detail, "1 件");
  assert.equal(t[0].items[1].detail, "1 件 · TODO.md", "an old record still shows the file it committed");
  assert.doesNotMatch(JSON.stringify(t), /TODO に記録/);
});

test("the PR feedback shows how many came in and from whom, and the replies how many were drafted", () => {
  const at = "2026-09-24T08:54:05+09:00";
  const t = buildTimeline([
    { event: "s4_review_comment_received", idd_id: "IDD-1", at, attrs: { items: [{ author: "rev" }, { author: "rev" }, { author: "ci" }] } },
    { event: "s4_replies_queued", idd_id: "IDD-1", at, attrs: { outbound_id: "OUT-1", parts: 2, followup_ids: ["OUT-2"] } },
    { event: "s4_replies_queued", idd_id: "IDD-1", at, attrs: { skipped: "返信するものが無い", parts: 0, followup_ids: [] } },
  ]);
  const flat = JSON.stringify(t);
  assert.match(flat, /3 件（rev, ci）/);
  assert.match(flat, /返信 2 件・別件 1 件/);
  assert.match(flat, /返信するものが無い/);
});

test("the landing's Issue close says the Issue it closed, and the reason when it could not", () => {
  const at = "2026-10-04T09:00:00+09:00";
  const t = buildTimeline([
    { event: "s4_land_issue_close_posted", idd_id: "IDD-1", at, attrs: { outbound_id: "OUT-1", issue: "https://github.com/o/r/issues/7" } },
    { event: "s4_land_issue_close_failed", idd_id: "IDD-1", at, attrs: { outbound_id: "OUT-2", issue: "https://github.com/o/r/issues/7", reason: "HTTP 422" } },
  ]);
  const flat = JSON.stringify(t);
  assert.match(flat, /Issue を閉じた/);
  assert.match(flat, /Issue を閉じられなかった/);
  assert.match(flat, /https:\/\/github.com\/o\/r\/issues\/7/);
  assert.match(flat, /HTTP 422/);
});

test("how long ago reads without a doubled '前', and review times are Japan time", async () => {
  const { agoLabel, clockJst } = await jiti.import("./events-display.ts");
  assert.equal(agoLabel("たった今"), "たった今");
  assert.equal(agoLabel("昨日"), "昨日");
  assert.equal(agoLabel("3h"), "3h 前");
  assert.equal(clockJst("2026-09-24T15:30:00.000Z"), "00:30");
});

test("a confirm after PR feedback shows the requests it left unresolved, nits included", () => {
  const at = "2026-09-24T08:54:05+09:00";
  const flat = JSON.stringify(buildTimeline([
    { event: "s2_confirm_done", idd_id: "IDD-1", at, attrs: { unresolved_must: 0, unresolved_should: 0, unresolved_requests: 1, unresolved_nit: 1, new_blocking: 0 } },
    { event: "s2_confirm_done", idd_id: "IDD-1", at, attrs: { unresolved_must: 1, unresolved_should: 0, new_blocking: 0 } },
  ]));
  assert.match(flat, /未解消 must 0 · should 0 · PR の指摘 1 · 新規 0/);
  assert.match(flat, /未解消 must 1 · should 0 · 新規 0/);
});

test("a plan review lists its runs by role, and the result counts the runs that broke", () => {
  const at = "2026-09-25T08:54:05+09:00";
  const flat = JSON.stringify(buildTimeline([
    { event: "s1_plan_review_started", idd_id: "IDD-1", at, attrs: { run_ids: ["A", "B"], runs: [{ run_id: "A", role: "pa" }, { run_id: "B", role: "pb" }] } },
    { event: "s1_plan_review_done", idd_id: "IDD-1", at, attrs: { must: 1, should: 0, nit: 2, failed_runs: 1 } },
  ]));
  assert.match(flat, /2 本（pa, pb）/);
  const partial = JSON.stringify(buildTimeline([
    { event: "s1_plan_review_started", idd_id: "IDD-1", at, attrs: { run_ids: ["B"], runs: [{ run_id: "B", role: "pb" }], start_failed: [{ role: "pa", error: "x" }] } },
  ]));
  assert.match(partial, /1 本（pb）· 起動失敗 pa/);
  assert.match(flat, /must 1 · should 0 · nit 2 · 1 本失敗/);
});

test("a stage run on a fallback for Claude's windows says which role ran in its place, from the event of its start", async () => {
  const { buildReviewTimeline } = await jiti.import("./events-display.ts");
  const at = "2026-09-25T08:54:05+09:00";
  const reason = "Claude の枠が止める閾値に達しているので lane を起動しません: 5 時間の枠 95%";
  const fb = { role: "escalation", fallback: "blind-reviewer-deep", reason };
  const flat = JSON.stringify(buildTimeline([
    { event: "s2_review_started", idd_id: "IDD-1", at, attrs: { kind: "blind", round: 1, run_ids: ["R1"], fallbacks: [fb, { ...fb, role: "escalation-2", folded: true }] } },
    { event: "s2_start", idd_id: "IDD-1", at, attrs: { model: "x/y", fallbacks: [fb] } },
    { event: "s1_plan_review_started", idd_id: "IDD-1", at, attrs: { run_id: "R2" } },
    // the planner has no start event of its own: its line comes after the session is recorded
    { event: "claude_quota_fallback", idd_id: "IDD-1", at, attrs: { stage: "planner", role: "escalation", fallback: "blind-reviewer-deep", reason } },
  ]));
  assert.match(flat, /1 巡目 · 1 本 · 枠のため blind-reviewer-deep で実行（escalation の代わり） · 枠のため blind-reviewer-deep で実行（escalation-2 の代わり、1 本にまとめた）/);
  assert.match(flat, /x\/y · 枠のため blind-reviewer-deep で実行（escalation の代わり）/);
  assert.match(flat, /枠のため blind-reviewer-deep で実行（escalation の代わり） · planner/);
  assert.equal((flat.match(/枠のため/g) ?? []).length, 4, "the plan review that ran as written says nothing");
  const review = JSON.stringify(buildReviewTimeline([
    { event: "r_blind_started", at, attrs: { round: 1, run_ids: ["R1", "R2"], fallbacks: [fb] } },
    { event: "r_triage_started", at, attrs: { round: 1, run_id: "R3" } },
  ]));
  assert.match(review, /2 本 · 枠のため blind-reviewer-deep で実行/);
  assert.equal((review.match(/枠のため/g) ?? []).length, 1);
});

test("a switch that happened while the run was going says its kind on the record that closes the round", async () => {
  const { buildTimeline } = await jiti.import("./events-display.ts");
  const at = "2026-09-25T08:54:05+09:00";
  const flat = JSON.stringify(buildTimeline([
    { event: "s2_review_findings", idd_id: "IDD-1", at, attrs: { kind: "blind", round: 1, files: ["r1.json"], fallbacks: [
      { role: "escalation", fallback: "blind-reviewer-deep", kind: "timeout", reason: "x" },
      { role: "escalation", fallback: "api", kind: "provider", reason: "y" },
      // a record from before the kinds were written names no kind: it still reads as a window wait
      { role: "escalation", fallback: "older", reason: "z" },
    ] } },
  ]));
  assert.match(flat, /時間切れのため blind-reviewer-deep で実行（escalation の代わり）/);
  assert.match(flat, /provider の障害のため api で実行（escalation の代わり）/);
  assert.match(flat, /枠のため older で実行（escalation の代わり）/);
});

test("a plan review that switched role while it ran says so, with its kind, on the record that closes the stage", () => {
  const at = "2026-09-25T08:54:05+09:00";
  const flat = JSON.stringify(buildTimeline([
    { event: "s1_plan_review_started", idd_id: "IDD-1", at, attrs: { run_ids: ["A"], runs: [{ run_id: "A", role: "reviewer" }] } },
    { event: "s1_plan_review_done", idd_id: "IDD-1", at, attrs: { must: 1, should: 0, nit: 0, fallbacks: [
      { role: "reviewer", fallback: "reviewer-deep", kind: "provider", reason: "x" },
    ] } },
  ]));
  assert.match(flat, /must 1 · should 0 · nit 0 · provider の障害のため reviewer-deep で実行（reviewer の代わり）/);
});

test("a final review left out on unchanged code shows why on the timeline", () => {
  const at = "2026-09-25T08:00:00+09:00";
  const flat = JSON.stringify(buildTimeline([
    { event: "s2_review_converged", idd_id: "IDD-1", at, attrs: { final_skipped: "差分全体を見たレビューから head が変わっていないので、最後のレビューを省いた" } },
  ]));
  assert.match(flat, /最後のレビューを省いた/);
});

test("penne's continue is named for what followed it: a fix, a stage run again, or going on without a fix", () => {
  const e = (event, attrs = {}) => ({ event, at: "2026-09-25T10:00:00+09:00", attrs });
  const judged = [e("s2_result"), e("s2_triage_done", { kind: "blind", accepted: [], escalated_claims: ["q"] }), e("s2_review_escalated", { reason: "q" })];
  const detail = (events) => buildTimeline(events).filter((t) => t.title === "判断").map((t) => t.detail);
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "continue", note: "A 案" }), e("s2_fix_sent", { round: 1, refs: [] })]), ["修正を続ける"]);
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "continue", note: "" }), e("s2_review_started", { kind: "final", round: 1 })]), ["直さずに続ける"]);
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "continue", note: "" }), e("s2_review_converged", { final_skipped: "x" })]), ["直さずに続ける"]);
  const failed = [e("s2_result"), e("s2_triage_done", { kind: "blind", failed: true, error: "x" }), e("s2_review_escalated", { reason: "判定に失敗", retry_state: { state: "start_triage" } })];
  assert.deepEqual(detail([...failed, e("s2_review_resumed", { decision: "continue", note: "" }), e("s2_triage_started", { kind: "blind", round: 1 })]), ["止まった段をやり直す"]);
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "accept", note: "" })]), ["この状態で進める"]);
  // just answered, before the loop moved: named for where the answer goes
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "continue", note: "" })]), ["直さずに続ける"]);
  assert.deepEqual(detail([...judged, e("s2_review_resumed", { decision: "continue", note: "A 案" })]), ["修正を続ける"]);
});

test("a move of the work branch shows its files, and a record with none says the fork and the work branch no longer differ in the plan's places", () => {
  const at = "2026-09-26T09:00:00Z";
  const [moved, back, unknown] = buildTimeline([
    { event: "s1_base_advanced", idd_id: "IDD-1", at, attrs: { from: "a", to: "bbbbbbbbbbbbbbbb", files: ["src/a.ts"], files_total: 1, known: true } },
    { event: "s1_base_advanced", idd_id: "IDD-1", at, attrs: { from: "a", to: "cccccccccccccccc", files: [], files_total: 0, known: true } },
    { event: "s1_base_advanced", idd_id: "IDD-1", at, attrs: { from: "a", to: "dddddddddddddddd", files: ["x.ts"], files_total: 1, known: false } },
  ]);
  assert.match(moved.detail, /1 ファイル · 本流 bbbbbbbbbbbb/);
  // the work branch took the change back, or the plan took the work branch in: either way no change is left
  assert.equal(back.detail, "plan の触る場所に、分岐点との差が無くなった · 本流 cccccccccccc");
  assert.equal(unknown.detail, "触る場所を取り出せない plan · 1 ファイル · 本流 dddddddddddd");
});

test("a plan that could not be archived shows its reason, and the rewritten references show their files", () => {
  const at = "2026-10-05T09:00:00+09:00";
  const t = buildTimeline([
    { event: "s3_plan_archive_failed", idd_id: "IDD-1", at, attrs: { reason: "lane の worktree に未 commit の変更があるので、plan.md を archive へ移せません" } },
    { event: "s3_plan_refs_fixed", idd_id: "IDD-1", at, attrs: { files: ["_docs/intent/Demo/x/decision.md"], commit: "abc" } },
  ]);
  const flat = JSON.stringify(t);
  assert.match(flat, /plan を archive へ移せず/);
  assert.match(flat, /未 commit の変更/);
  assert.match(flat, /plan への参照を直した/);
  assert.match(flat, /_docs\/intent\/Demo\/x\/decision\.md/);
});

test("a GO over a must shows the reason it was given with, and a GO without one shows no detail", () => {
  const at = "2026-10-26T10:00:00+09:00";
  const [withReason, without] = buildTimeline([
    { event: "s1_go", idd_id: "IDD-1", at, attrs: { reason: "2 巡目の must を読んだ上で、直さずに進める" } },
    { event: "s1_go", idd_id: "IDD-1", at, attrs: {} },
  ]);
  assert.equal(withReason.title, "GO");
  assert.equal(withReason.detail, "2 巡目の must を読んだ上で、直さずに進める");
  assert.equal(without.detail, undefined);
});

test("the records check before S3 shows its verdict, its send-back and the round it reopens", () => {
  const at = "2026-10-17T10:00:00+09:00";
  const [clean, errors, unavailable, conflict, instructed, reopened] = buildTimeline([
    { event: "s2_intent_checked", idd_id: "IDD-1", at, attrs: { outcome: "clean" } },
    { event: "s2_intent_checked", idd_id: "IDD-1", at, attrs: { outcome: "errors", remaining: [{}, {}], sent_back: false } },
    { event: "s2_intent_checked", idd_id: "IDD-1", at, attrs: { outcome: "unavailable", reason: "口を呼べませんでした" } },
    { event: "s2_records_conflict", idd_id: "IDD-1", at, attrs: { errors: [{}] } },
    { event: "s2_records_instructed", idd_id: "IDD-1", at, attrs: { errors: [{}] } },
    { event: "s2_records_reopened", idd_id: "IDD-1", at, attrs: { reason: "記録の置き場の外が変わった", files: ["a.ts"] } },
  ]);
  assert.equal(clean.title, "記録の検査");
  assert.equal(clean.detail, "error なし");
  assert.equal(errors.detail, "error 2 件（戻さず進む）");
  assert.equal(unavailable.detail, "答えず: 口を呼べませんでした");
  assert.equal(conflict.title, "記録の error");
  assert.equal(conflict.detail, "error 1 件");
  assert.equal(instructed.title, "記録の直しを依頼");
  assert.equal(reopened.title, "記録の直しで code が変わった");
  assert.equal(reopened.detail, "記録の置き場の外が変わった · 1 ファイル");
});

test("AC-001: a start the stage could not make shows its stage and reason on the timeline", () => {
  const [entry] = buildTimeline([{ event: "lane_start_skipped", idd_id: "IDD-1", at: "2026-11-11T10:50:00+09:00", attrs: { stage: "executor", reason: "no runner" } }]);
  assert.equal(entry.title, "段を起こせなかった");
  assert.equal(entry.detail, "実装役 · no runner");
});
