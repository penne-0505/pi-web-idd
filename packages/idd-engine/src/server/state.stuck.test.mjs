import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");

let dir;

function lane(events, worktree, pipeline = "") {
  dir = mkdtempSync(join(tmpdir(), "idd-state-stuck-"));
  process.env.IDD_STATE_DIR = dir;
  writeFileSync(join(dir, "roles.yaml"), `roles:\n  r: { model: x/y }\npipeline:\n${pipeline}`);
  process.env.IDD_ROLES_FILE = join(dir, "roles.yaml");
  if (worktree) writeFileSync(join(dir, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", executor_session_id: "E1", worktree_path: worktree }) + "\n");
  writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-24T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" }) + "\n");
  writeFileSync(join(dir, "lifecycle-Demo.jsonl"), events.map(([event, attrs = {}]) => JSON.stringify({ idd_id: "IDD-1", event, at: "2026-09-24T00:00:00Z", attrs })).join("\n") + "\n");
  return buildState().items.find((i) => i.kind === "stuck");
}

const nit = (claim) => ({ ref: "F-1", severity: "nit", claim, path: "a.ts", fix: "f" });
const pass = [
  ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }],
  ["s2_review_started", { kind: "blind", round: 1 }], ["s2_triage_done", { kind: "blind", accepted: [] }],
  ["s2_review_started", { kind: "final", round: 1 }], ["s2_triage_done", { kind: "final", accepted: [] }],
  ["s2_review_converged"], ["s2_device_skipped"], ["s3_ready"], ["s3_ok"], ["s4_submit_started"], ["s4_pr_created", { pr_url: "https://github.com/o/r/pull/7" }],
];

afterEach(() => {
  delete process.env.IDD_STATE_DIR;
  delete process.env.IDD_ROLES_FILE;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the stuck card's open items", () => {
  it("list the checks' failures the lane made on a stop over the checks before the convergence, not the last judgement's", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }],
      ["s2_review_started", { kind: "blind", round: 1, head: "h1", depth: "standard", max_fix_rounds: 1, close_on: "must" }], ["s2_triage_done", { kind: "blind", accepted: [{ ref: "F-1", severity: "must", claim: "m", path: "a.ts", action: "fix" }] }],
      ["s2_fix_sent", { round: 1, refs: ["F-1"] }], ["s2_result"],
      ["s2_review_started", { kind: "blind", round: 2, head: "H" }], ["s2_triage_done", { kind: "blind", accepted: [{ ref: "F-9", severity: "should", claim: "later", action: "followup" }] }],
      ["s2_review_started", { kind: "final", round: 2, head: "H" }], ["s2_triage_done", { kind: "final", accepted: [] }],
      ["s2_checks_started", { run_id: "C1", head: "H" }],
      ["s2_checks_done", { run_id: "C1", head: "H", outcome: "new", checks: [], findings: [{ ref: "checks/test", severity: "must", claim: "test が落ちた", fix: "tail", action: "fix" }] }],
    ]);
    assert.ok(card);
    assert.match(card.reason, /収束の前の必須の検査が lane の変更で落ちた（test）/);
    assert.deepEqual(card.open.map((o) => [o.ref, o.severity]), [["checks/test", "must"]]);
    assert.equal(card.accepted, undefined, "no judgement is decided on this stop");
    assert.equal(card.continueFixes, 1, "a continue sends the failure to the fix");
  });

  it("list the nit a reviewer asked for when an S4 pass stalls on it", () => {
    const card = lane([
      ...pass, ["s4_review_comment_received", { files: [] }], ["s2_triage_done", { kind: "feedback", accepted: [{ ...nit("a"), ref: "C-1" }] }],
      ["s2_fix_sent", { round: 1 }], ["s2_result"], ["s2_confirm_done", { round: 1, unresolved_requests: 1, files: [] }], ["s2_triage_done", { kind: "confirm", accepted: [nit("b")] }],
      ["s2_fix_sent", { round: 2 }], ["s2_result"], ["s2_confirm_done", { round: 2, unresolved_requests: 1, files: [] }], ["s2_triage_done", { kind: "confirm", accepted: [nit("c")] }],
    ]);
    assert.ok(card);
    assert.match(card.reason, /減らない/);
    assert.deepEqual(card.open.map((o) => [o.severity, o.claim]), [["nit", "c"]]);
  });

  it("leave an S2 pass's accepted nits out: they are not fixed", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: "blind", round: 1 }],
      ["s2_triage_done", { kind: "blind", accepted: [{ ref: "F-1", severity: "must", claim: "m", path: "a.ts" }, nit("n")], escalated_claims: ["仕様が決まらない"] }],
    ]);
    assert.ok(card);
    assert.deepEqual(card.open.map((o) => [o.severity, o.claim]), [["must", "m"]]);
  });
});

describe("the stuck card's accepted findings", () => {
  // a pass at its first judgement, which accepted a must, a should left for later and a nit the loop never sends
  const judged = [
    { ref: "F-1", severity: "must", claim: "m", path: "a.ts", action: "fix" },
    { ref: "F-2", severity: "should", claim: "later", path: "b.ts", action: "followup" },
    { ...nit("n"), ref: "F-3", action: "fix" },
  ];
  const stopped = (...after) => lane([...pass.slice(0, 4), ["s2_triage_done", { kind: "blind", accepted: judged, escalated_claims: ["仕様が決まらない"] }], ...after]);

  it("lists every accepted finding with what each handling does to the fix, while `open` stays the judgement's own scope", () => {
    const card = stopped();
    assert.ok(card);
    assert.deepEqual(card.open.map((o) => o.claim), ["m"], "the old screen reads what the judgement sends to the fix");
    assert.deepEqual(card.accepted.map((f) => [f.claim, f.action, f.inFix]), [["m", "fix", true], ["later", "followup", false], ["n", "fix", false]]);
    const [must, later] = card.accepted;
    assert.deepEqual(later.handlings.map((h) => [h.action, h.inFix, h.current]), [["fix", true, false], ["followup", false, true], ["skip", false, false]]);
    assert.deepEqual(must.handlings.map((h) => [h.action, h.severity, h.inFix]), [["fix", "must", true], ["followup", "should", false], ["skip", "should", false]]);
  });

  it("carries none for a stop outside the review loop", () => {
    const card = stopped(["s2_review_escalated", { reason: "x" }], ["s2_review_resumed", { decision: "hand_fix" }]);
    assert.ok(card);
    assert.equal(card.accepted, undefined);
  });
});

describe("the stuck card of a merged lane the acceptance could not go on with", () => {
  it("carries the reason and the place to fix, and no send-back", () => {
    const reason = "公開本流の受け入れが衝突しています。直す場所: /state/overlay/recovery/abc（衝突を解いて commit すると、次の巡が読み直して受け入れます）";
    const card = lane([
      ...pass, ["s4_merged", { merged_at: "2026-09-24T00:00:00Z" }],
      ["lane_stall_detected", { source: "merge_accept", stage: "本流の受け入れ・記録回収", since: "2026-09-24T00:00:00Z", last_event: { event: "s4_merged", at: "2026-09-24T00:00:00Z" }, reason, causes: [], can_send_back: false, stand: "work=1" }],
    ]);
    assert.ok(card);
    assert.equal(card.reason, `engine が進められない: ${reason}`);
    assert.equal(card.halt.stage, "本流の受け入れ・記録回収");
    assert.equal(card.halt.canSendBack, false);
  });
});

describe("the stuck card's reversals", () => {
  it("lay out both positions with the earlier round's ref, apart from the questions", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: "final", round: 3 }],
      ["s2_triage_done", { kind: "final", round: 3, accepted: [], escalated_claims: [], oscillations: [{ ref: "F-1", severity: "should", path: "t.py", claim: "語彙で文言を縛る", prior_ref: "2-final/F-1", prior: "通過が判別できる", current: "語で合否を決めない" }] }],
    ]);
    assert.ok(card);
    assert.match(card.reason, /往復/);
    assert.deepEqual(card.escalated, []);
    assert.deepEqual(card.oscillations, [{ ref: "F-1", claim: "語彙で文言を縛る", path: "t.py", priorRef: "2-final/F-1", prior: "通過が判別できる", current: "語で合否を決めない" }]);
  });

  it("skip a malformed mark instead of breaking the card", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }],
      ["s2_triage_done", { kind: "final", round: 3, accepted: [], oscillations: [null, "x", { ref: "F-2", claim: "c", prior: 1 }] }],
    ]);
    assert.ok(card);
    assert.deepEqual(card.oscillations, [{ ref: "F-2", claim: "c", priorRef: "", prior: "", current: "" }]);
  });
});

describe("the stuck card's continue", () => {
  const stop = (kind, accepted) => lane([
    ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: kind === "final" ? "final" : "blind", round: 1 }],
    ["s2_triage_done", { kind, round: 1, accepted, escalated_claims: ["仕様が決まらない"] }],
  ]);

  it("says a question over nits only is not fixed: the loop closes or goes on to the final review", () => {
    assert.deepEqual(stop("final", [nit("a"), nit("b")]).onContinue, { to: "close", device: "none", left: { accepted: 2, questions: 1, reversals: 0 } });
    assert.equal(stop("blind", [nit("a")]).onContinue.to, "final");
  });

  it("says what a note does: the fix, with the nit left and the question answered by the note", () => {
    const card = stop("blind", [nit("a")]);
    assert.deepEqual(card.onContinueWithNote, { to: "fix", all: false, refs: [], boundaries: 0, note: true, left: { accepted: 1, questions: 0, reversals: 0 } });
    assert.deepEqual(card.onAccept, { to: "close", device: "none", left: { accepted: 1, questions: 1, reversals: 0 } });
  });

  it("carries how many items a plain continue sends to the fix, 0 when it sends none", () => {
    assert.equal(stop("blind", [{ ref: "F-2", severity: "must", claim: "m", path: "a.ts" }]).continueFixes, 1);
    assert.equal(stop("blind", [nit("a")]).continueFixes, 0);
    assert.equal(stop("final", [nit("a")]).continueFixes, 0);
    const failed = lane([["s1_go"], ["s2_start"], ["s2_result"], ["s2_triage_started", { kind: "blind", round: 1, run_id: "t" }], ["s2_triage_done", { kind: "blind", round: 1, failed: true, error: "x" }]]);
    assert.equal(failed.continueFixes, undefined, "a continue that retries a stage has no count");
  });

  it("says a question with must / should over the limit is sent to the fix, and a failed stage is retried", () => {
    const fix = stop("blind", [{ ref: "F-2", severity: "must", claim: "m", path: "a.ts" }]).onContinue;
    assert.equal(fix.to, "fix");
    assert.deepEqual(fix.refs, ["F-2"]);
    const failed = lane([["s1_go"], ["s2_start"], ["s2_result"], ["s2_triage_started", { kind: "blind", round: 1, run_id: "t" }], ["s2_triage_done", { kind: "blind", round: 1, failed: true, error: "x" }]]);
    assert.deepEqual(failed.onContinue, { to: "retry" });
    assert.deepEqual(failed.onContinueWithNote, { to: "retry" });
  });
});

describe("the stuck card's continue in an S4 pass", () => {
  it("says the reviewer's nits are fixed too", () => {
    const card = lane([
      ...pass, ["s4_review_comment_received", { files: [] }], ["s2_triage_done", { kind: "feedback", accepted: [{ ...nit("a"), ref: "C-1" }] }],
      ["s2_fix_sent", { round: 1 }], ["s2_result"], ["s2_confirm_done", { round: 1, unresolved_requests: 1, files: [] }], ["s2_triage_done", { kind: "confirm", accepted: [nit("b")] }],
      ["s2_fix_sent", { round: 2 }], ["s2_result"], ["s2_confirm_done", { round: 2, unresolved_requests: 1, files: [] }], ["s2_triage_done", { kind: "confirm", accepted: [nit("c")] }],
    ]);
    assert.match(card.reason, /減らない/);
    assert.equal(card.onContinue.to, "fix");
    assert.equal(card.onContinue.all, true);
    assert.deepEqual(card.onContinue.refs, ["F-1"]);
  });
});

describe("the stuck card's continue on a head a blind already read", () => {
  // the final review is skipped only when the lane's worktree is still at that head, as the loop checks it
  function withWorktree(move) {
    const wt = mkdtempSync(join(tmpdir(), "idd-state-stuck-wt-"));
    const git = (...args) => execFileSync("git", ["-C", wt, "-c", "user.email=a@b", "-c", "user.name=a", ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", wt]);
    git("commit", "-q", "--allow-empty", "-m", "init");
    const head = git("rev-parse", "HEAD");
    if (move) { writeFileSync(join(wt, "x.txt"), "moved"); git("add", "-A"); git("commit", "-q", "-m", "moved"); }
    const card = lane([
      ["s1_go"], ["s2_start", { started_from_commit: head }], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: "blind", round: 1, head }],
      ["s2_triage_done", { kind: "blind", round: 1, accepted: [nit("a")], escalated_claims: ["仕様が決まらない"] }],
    ], wt);
    rmSync(wt, { recursive: true, force: true });
    return card;
  }

  it("says the review closes, since the final review of the same head is skipped", () => {
    assert.equal(withWorktree(false).onContinue.to, "close");
  });

  it("says the final review runs once the code moved from that head", () => {
    assert.equal(withWorktree(true).onContinue.to, "final");
  });

  it("says the final review runs when the worktree cannot be read, as the loop cannot skip it then", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: "blind", round: 1, head: "H1" }],
      ["s2_triage_done", { kind: "blind", round: 1, accepted: [nit("a")], escalated_claims: ["仕様が決まらない"] }],
    ]);
    assert.equal(card.onContinue.to, "final");
  });
});

describe("the stuck card at the device check", () => {
  const dev = [["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_converged"], ["s2_device_started", { round: 1, run_id: "D" }]];
  it("says going on closes the review again and runs the device check again, when it is declared", () => {
    const judged = lane([...dev, ["s2_device_done", { round: 1, blocking: 2, files: [] }], ["s2_triage_done", { kind: "device", accepted: [{ ref: "F-1", severity: "must", claim: "m" }, { ref: "F-2", severity: "must", claim: "n" }], escalated_claims: ["q"] }]], undefined, "  device_check: { role: r }\n");
    assert.equal(judged.onContinue.to, "fix");
    assert.deepEqual(judged.onAccept, { to: "close", device: "again", left: { accepted: 2, questions: 1, reversals: 0 } });
    assert.equal(judged.stoppedAt, undefined, "where it stopped is no longer read apart from the transition");
    const failed = lane([...dev, ["s2_device_done", { round: 1, failed: true, error: "x" }]], undefined, "  device_check: { role: r }\n");
    assert.deepEqual(failed.onContinue, { to: "retry" });
    assert.deepEqual(failed.onAccept, { to: "close", device: "again", left: { accepted: 0, questions: 0, reversals: 0 } });
  });

  it("goes on without a fix after a question on PR feedback that accepted nothing", () => {
    const card = lane([...pass, ["s4_review_comment_received", { files: [] }], ["s2_triage_done", { kind: "feedback", accepted: [], escalated_claims: ["返信の要否"] }]]);
    assert.deepEqual(card.onContinue, { to: "close", device: "none", left: { accepted: 0, questions: 1, reversals: 0 } });
  });
});

describe("the stuck card's open items count what the fix would take", () => {
  it("leave an S2 pass's follow-up and skipped should out, whatever the judgement accepted", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }], ["s2_review_started", { kind: "blind", round: 1 }],
      ["s2_triage_done", { kind: "blind", accepted: [
        { ref: "F-1", severity: "should", claim: "直す", path: "a.ts", action: "fix" },
        { ref: "F-2", severity: "should", claim: "次の変更に回す", path: "b.ts", action: "followup" },
        { ref: "F-3", severity: "should", claim: "見送る", path: "c.ts", action: "skip" },
      ], escalated_claims: ["仕様が決まらない"] }],
    ]);
    assert.ok(card);
    assert.deepEqual(card.open.map((o) => o.claim), ["直す"]);
  });

  it("leave a follow-up nit out of an S4 pass's open items: its reply and Issue card answer it, not a fix", () => {
    const card = lane([
      ...pass, ["s4_review_comment_received", { files: [] }],
      ["s2_triage_done", { kind: "feedback", accepted: [
        { ref: "C-1", severity: "nit", claim: "直す", path: "a.ts", action: "fix" },
        { ref: "C-2", severity: "nit", claim: "外で扱う", path: "b.ts", action: "followup" },
      ], escalated_claims: ["仕様が決まらない"] }],
    ]);
    assert.ok(card);
    assert.deepEqual(card.open.map((o) => o.claim), ["直す"]);
  });
});

describe("the hand turn and the stop's history", () => {
  it("a lane at penne's hand turn shows only the 直した answer, with the stop's history (AC-043, AC-052)", () => {
    const card = lane([
      ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }],
      ["s2_review_started", { kind: "blind", round: 1, depth: "deep", max_fix_rounds: 1, close_on: "must" }],
      ["s2_triage_done", { kind: "blind", round: 1, accepted: [{ ref: "F-1", severity: "must", claim: "残った must", action: "fix", path: "a.ts" }] }],
      ["s2_fix_sent", { refs: ["F-1"] }], ["s2_result", { outcome: "success", side_findings: ["直したつもり"] }],
      ["s2_review_started", { kind: "blind", round: 2 }], ["s2_review_findings", { kind: "blind", round: 2, files: [] }],
      ["s2_triage_done", { kind: "blind", round: 2, accepted: [], prior: [{ ref: "F-1" }] }],
      ["s2_review_escalated", { reason: "修正が 1 巡に達した" }],
      ["s2_review_resumed", { decision: "hand_fix", note: "" }],
    ]);
    assert.ok(card);
    assert.equal(card.handTurn, true);
    assert.deepEqual(card.history.sideFindings, ["直したつもり"]);
    assert.equal(card.history.unresolved, undefined, "the fix's refs are not read back as unresolved");
    // the loop is not escalated anymore: only the 直した answer applies
    assert.equal(card.onContinue, undefined);
    // the card reads the same母数 the loop does: the judgement accepted none, and nothing of the fix comes back as a must
    assert.equal(card.open.length, 0);
  });
});

describe("the stuck card's mark that its note answers the judgement's question", () => {
  const stopAt = (triage) => [
    ["s1_go"], ["s2_start"], ["s2_result", { outcome: "success" }],
    ["s2_review_started", { kind: "blind", round: 1, head: "h1" }],
    ["s2_triage_done", { kind: "blind", round: 1, accepted: [], rejected: [], ...triage }],
    ["s2_review_escalated", { reason: "判定が penne の判断を求めた指摘がある" }],
  ];

  it("is set on a stop whose judgement put one question to penne and found no reversal, and on no other", () => {
    assert.equal(lane(stopAt({ escalated_claims: ["計測の時点はどちらか"] })).noteAnswersQuestion, true);
    // two questions: the one line cannot say which part answers which, so the note stays the executor's
    assert.equal(lane(stopAt({ escalated_claims: ["一つ目", "二つ目"] })).noteAnswersQuestion, undefined);
    // a reversal beside the question: the note may be its boundary
    const reversal = { ref: "F-2", severity: "should", claim: "c", prior_ref: "0-blind/F-1", prior: "a", current: "b" };
    assert.equal(lane(stopAt({ escalated_claims: ["問い"], oscillations: [reversal] })).noteAnswersQuestion, undefined);
    assert.equal(lane(stopAt({})).noteAnswersQuestion, undefined);
  });
});
