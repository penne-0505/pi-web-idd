/**
 * What the engine answers for each card: the judgment it waits for and the operations that answer it now. The screen
 * draws from this and derives nothing from the card's fields, so the answer has to name, for every kind the engine
 * returns, which operations exist, which are held and why, what they need, and whether (and how) they are signed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { decisionOf, withDecisions } = await import("./card-decision.ts");
const { needsSignature, unclassifiedActions, OUTBOUND_ACTIONS } = await import("./action-classes.ts");
const { buildState } = await import("./state.ts");

const { AT, FOURTEEN } = await import("./card-kinds.fixture.mjs");
const ids = (item) => decisionOf(item).operations.map((o) => o.id);
const op = (item, id) => decisionOf(item).operations.find((o) => o.id === id);

describe("the answer on each card", () => {
  it("is made for each of the fourteen kinds, and every decide operation it names is a classified action", () => {
    assert.equal(new Set(FOURTEEN.map((i) => i.kind)).size, 14);
    for (const item of FOURTEEN) {
      const decision = decisionOf(item);
      assert.equal(decision.waiting, item.kind);
      assert.ok(decision.operations.length > 0, `${item.kind}: the card can be put off at least`);
      assert.ok(decision.operations.some((o) => o.id === "later"), item.kind);
      const actions = decision.operations.filter((o) => o.door === "decide").map((o) => o.action);
      assert.deepEqual(unclassifiedActions(actions), [], `${item.kind}: the engine's one classification names every action it offers`);
    }
  });

  it("names a signature for each operation from the engine's one classification, and none the classification does not sign", () => {
    for (const item of FOURTEEN) {
      for (const o of decisionOf(item).operations) {
        if (o.door !== "decide") assert.equal(o.signature, "none", `${item.kind}/${o.id}`);
        else assert.equal(o.signature !== "none", needsSignature(o.action), `${item.kind}/${o.id}`);
      }
    }
    // the three that leave the machine, by the same list the gate reads, are signed with a passkey or the PIN
    for (const action of OUTBOUND_ACTIONS) assert.equal(needsSignature(action), true, action);
    assert.equal(op(FOURTEEN[7], "approve").signature, "passkey_or_pin");
    assert.equal(op(FOURTEEN[6], "approve").signature, "passkey_or_pin");
    assert.equal(op(FOURTEEN[5], "approve").signature, "passkey_or_pin");
  });

  it("signs an instruction proposal's two answers by a passkey alone, and leaves a repo's proposal unsigned", () => {
    const instruction = { ...FOURTEEN[12], proposalKind: "instruction_add", repo: "instruction" };
    assert.deepEqual([op(instruction, "approve").action, op(instruction, "approve").signature], ["instruction_approve", "passkey"]);
    assert.deepEqual([op(instruction, "reject").action, op(instruction, "reject").signature], ["instruction_reject", "passkey"]);
    assert.deepEqual(op(instruction, "reject").input, { kind: "text", field: "reason", required: true });
    assert.equal(op(FOURTEEN[12], "approve").signature, "none");
    assert.deepEqual(op(FOURTEEN[12], "approve").payload, { repo: "r", proposal: "P-1" });
  });

  it("holds a GO the engine would refuse, with the reason, and names the Purposes its press confirms", () => {
    const go = FOURTEEN[3];
    assert.equal(op(go, "go").hold, undefined);
    const empty = { ...go, intentPath: "_docs/intent/x/" };
    assert.match(op(empty, "go").hold.reason, /契約/);
    const blocked = { ...go, blockedBy: { reason: "依存が着地していません", items: [] } };
    assert.equal(op(blocked, "go").hold.reason, "依存が着地していません");
    assert.equal(op(blocked, "revise"), undefined, "a GO waiting on a landing is not revised either");
    // the lane can be taken off the list from a GO card (held for an empty contract or not): it stops the lane and cannot be
    // taken back. A GO waiting on a landing never had it
    assert.equal(op(blocked, "ignore"), undefined);
    for (const card of [go, empty]) {
      assert.deepEqual([op(card, "ignore").action, op(card, "ignore").payload, op(card, "ignore").irreversible, op(card, "ignore").signature], ["ignore", { iddId: card.iddId }, true, "none"]);
      assert.equal(op(card, "ignore").hold, undefined);
    }
    const withPurposes = { ...go, purposeProposals: [{ id: "P-1", statement: "s", origin: "o" }, { id: "P-2", statement: "t", origin: "o" }] };
    assert.deepEqual(op(withPurposes, "go").confirms, { purposes: [{ id: "P-1", statement: "s", origin: "o" }, { id: "P-2", statement: "t", origin: "o" }] });
    // what the person reads beside the sentence is in the answer: the handle, and the sentence the planner first wrote
    const rewritten = { ...go, purposeProposals: [{ id: "P-1", statement: "直した文", origin: "o", name: "名前", raisedStatement: "計画役の文" }] };
    assert.deepEqual(op(rewritten, "go").confirms.purposes[0], { id: "P-1", statement: "直した文", name: "名前", raisedStatement: "計画役の文", origin: "o" });
    assert.deepEqual(ids(withPurposes), ["revise", "go", "ignore", "purpose_restate", "purpose_withdraw", "later"], "the two judgments on a Purpose are the engine's operations");
    assert.equal(op(withPurposes, "purpose_restate").keepsCard, true);
    assert.equal(op(withPurposes, "purpose_withdraw").keepsCard, true);
    assert.equal(op(go, "go").confirms, undefined);
    const reason = { ...go, planReview: { state: "skipped", must: 0, should: 0, nit: 0, findings: [], needsReason: true } };
    assert.deepEqual([op(reason, "go").needsReason, op(reason, "go").input], [true, { kind: "text", field: "reason", required: true }]);
  });

  it("puts the acceptance criteria's words and every changed file's diff in a review's material, file by file", () => {
    const side = (n, marker, prefix) => Array.from({ length: n }, (_, i) => ({ marker, code: `${prefix}${i}` }));
    const review = {
      ...FOURTEEN[4],
      criteria: [{ id: "AC-001", text: "未知の種類も描ける", state: "done" }, { id: "AC-002", text: "押せない理由を出す", state: "todo" }],
      diffs: [
        {
          file: "a/b.ts", fileIndex: 1, fileTotal: 3,
          before: [{ marker: "-", code: "const a = 1", lineNo: "4" }],
          after: [{ marker: "+", code: "const a = 2", lineNo: "4" }, { marker: null, code: "export {}" }],
        },
        { file: "c.ts", fileIndex: 2, fileTotal: 3, before: [], after: side(230, "+", "l"), omitted: { before: 0, after: 12 } },
        { file: "d.ts", fileIndex: 3, fileTotal: 3, before: side(2, "-", "x"), after: [] },
      ],
    };
    const material = Object.fromEntries(decisionOf(review).material.map((m) => [m.key, m.value]));
    assert.equal(material.criterion_1, "AC-001（済）未知の種類も描ける");
    assert.equal(material.criterion_2, "AC-002（未着手）押せない理由を出す");
    // every file is in the material, numbered, so the card can move from one to the next without asking again
    assert.equal(material.diff_file_1, "a/b.ts（1/3）");
    assert.equal(material.diff_file_2, "c.ts（2/3）");
    assert.equal(material.diff_file_3, "d.ts（3/3）");
    assert.equal(material.diff_before_1, "4 - const a = 1");
    assert.equal(material.diff_after_1, "4 + const a = 2\n  export {}");
    assert.equal("diff_before_2" in material, false, "a side with no line says nothing");
    assert.equal(material.diff_before_3, "- x0\n- x1");
    assert.equal("criteria" in material, false, "the ids and states alone are no longer all the criteria say");
    // a side longer than the material holds says how much it left out: what the lines passed here, and what the reading cut
    const long = material.diff_after_2.split("\n");
    assert.equal(long.length, 201);
    assert.equal(long.at(-1), "… あと 42 行（全文は lane の branch の c.ts）", "a cut file says what is left and where the whole is read");
    // with the lane's branch known, the cut names it and the file's path
    const named = Object.fromEntries(decisionOf({ ...review, diffBranch: "idd/IDD-9" }).material.map((m) => [m.key, m.value]));
    assert.equal(named.diff_after_2.split("\n").at(-1), "… あと 42 行（全文は idd/IDD-9 の c.ts）");
    assert.equal(named.diff_after_1.includes("全文"), false, "a file that was not cut points nowhere");
    // the lines are read into the material; the card is not sent a second copy of them
    assert.equal(withDecisions([review])[0].diffs, undefined);
    // the lane's diff has one reading: a card that carries only the old single `diff` has no diff rows
    const oldShape = decisionOf({ ...FOURTEEN[4], diff: { file: "a/b.ts", fileIndex: 1, fileTotal: 3, before: [], after: [{ marker: "+", code: "z" }] } }).material;
    assert.equal(oldShape.some((m) => m.key.startsWith("diff_")), false);
    // more files changed than the answer carries: it says so rather than read as if these were all
    const partial = decisionOf({ ...FOURTEEN[4], diffs: [{ file: "a/b.ts", fileIndex: 1, fileTotal: 3, before: [], after: [{ marker: "+", code: "z" }] }] }).material;
    assert.deepEqual(partial.filter((m) => m.key.startsWith("diff_")).map((m) => m.key), ["diff_file_1", "diff_after_1"]);
    assert.equal(partial.find((m) => m.key === "files_omitted").value, "2 file");
    const partialNamed = decisionOf({ ...FOURTEEN[4], diffBranch: "idd/IDD-9", diffs: [{ file: "a/b.ts", fileIndex: 1, fileTotal: 3, before: [], after: [{ marker: "+", code: "z" }] }] }).material;
    assert.equal(partialNamed.find((m) => m.key === "files_omitted").value, "2 file（全 file は idd/IDD-9 の差分）");
    assert.equal(decisionOf({ ...FOURTEEN[4], diffFiles: ["x.ts", "y.ts"] }).material.find((m) => m.key === "files").value, "x.ts\ny.ts");
  });

  it("gives each operation the key of the confirm it goes through, and the key moves with what the person read", () => {
    const review = { ...FOURTEEN[4], criteria: [{ id: "AC-001", text: "a", state: "todo" }], diffs: [{ file: "a.ts", fileIndex: 1, fileTotal: 1, before: [], after: [{ marker: "+", code: "x" }] }] };
    const key = (item, id = "ok") => op(item, id).confirmKey;
    assert.match(key(review), /^[0-9a-f]{24}$/);
    assert.equal(key(review), key({ ...review }), "the same answer is the same key");
    assert.notEqual(key(review), key(review, "reject_retry"), "another operation is another key");
    assert.notEqual(key(review), key({ ...review, criteria: [{ id: "AC-001", text: "b", state: "todo" }] }), "a criterion that changed");
    assert.notEqual(key(review), key({ ...review, diffs: [{ ...review.diffs[0], after: [{ marker: "+", code: "y" }] }] }), "a line of the diff that changed");
    assert.notEqual(key(review), key({ ...review, iddId: "#2" }), "the payload that changed");
    // a GO's key moves with the Purposes it confirms and the sentence it shows
    const go = FOURTEEN[3];
    const purposes = (statement) => ({ ...go, purposeProposals: [{ id: "P-1", statement, origin: "o" }] });
    assert.notEqual(key(purposes("文 1"), "go"), key(purposes("文 2"), "go"));
    // a submit card's key moves with the destination and the Issue it closes, a batch card's with its repo and branch
    const ship = FOURTEEN.find((i) => i.kind === "ship");
    const closes = (comment) => ({ ...ship, land: { token: "t", close: { repo: "r", issue: 1, comment } } });
    assert.notEqual(key(closes("一言 1"), "approve"), key(closes("一言 2"), "approve"));
    // the open PR a push goes to is named on the confirm, so another number is another key
    const pr = (number) => ({ ...ship, existingPr: { url: "u", number } });
    assert.notEqual(key(pr(7), "approve"), key(pr(8), "approve"), "the PR the confirm names");
    assert.equal(key(pr(7), "approve"), key(pr(7), "approve"));
    const batch = FOURTEEN[6];
    assert.notEqual(key(batch, "approve"), key({ ...batch, workBase: "other" }, "approve"));
    // the lanes the signature may name are the operation's own input; the key leaves them out, for the screen adds the kept ones
    const lane = { iddId: "IDD-1", title: "t", head: "a".repeat(40), close: { repo: "r", issue: 1, comment: "c" } };
    const two = { ...batch, lanes: [lane, { ...lane, iddId: "IDD-2", close: undefined }] };
    assert.deepEqual(op(two, "approve").input, { kind: "lanes", field: "lanes", offered: [{ iddId: "IDD-1", head: lane.head, close: lane.close }, { iddId: "IDD-2", head: lane.head, close: null }] });
    assert.equal(key(two, "approve"), key({ ...two, lanes: two.lanes.map((l) => ({ ...l, head: "f".repeat(40) })) }, "approve"), "which lanes stay on a batch is the person's choice, kept by the screen");
    // a proposal's key moves with what the card shows: the content now, the proposed one, the reason and when it takes effect
    const proposal = FOURTEEN[12];
    const shows = (over) => ({ ...proposal, ...over });
    assert.notEqual(key(proposal, "approve"), key(shows({ before: [{ label: "概要", value: "更新された現在値" }] }), "approve"), "the content now that changed");
    assert.notEqual(key(proposal, "approve"), key(shows({ after: [{ label: "概要", value: "別の案" }] }), "approve"), "the proposed content that changed");
    assert.notEqual(key(proposal, "reject"), key(shows({ reason: "別の理由" }), "reject"), "the reason that changed");
    assert.notEqual(key(proposal, "approve"), key(shows({ effect: proposal.effect === "now" ? "on_merge" : "now" }), "approve"), "when it takes effect");
    assert.equal(key(proposal, "approve"), key(shows({}), "approve"));
  });

  it("lets a card of a kind the engine does not know be put off, and offers it no judgement", () => {
    const unknown = { ...FOURTEEN[0], kind: "something_new" };
    assert.deepEqual(ids(unknown), ["later"]);
    assert.equal(op(unknown, "later").door, "snooze");
  });

  it("names a stuck card's operations by the shape of the stop, not by the screen", () => {
    const stuck = FOURTEEN[8];
    assert.deepEqual(ids(stuck), ["ignore", "accept", "hand_fix", "continue", "later"]);
    assert.deepEqual(ids({ ...stuck, handTurn: true }), ["ignore", "hand_fixed", "later"]);
    assert.deepEqual(ids({ ...stuck, budget: { cost: 1, limit: 0, parts: [], subscription: [] } }), ["ignore", "budget_extend", "later"]);
    assert.deepEqual(ids({ ...stuck, stall: { role: "executor", reason: "x" } }), ["ignore", "resume", "later"]);
    const halt = { ...stuck, halt: { stage: "impl", since: AT, lastEvent: { name: "n", at: AT }, reason: "r", causes: [], canSendBack: true } };
    assert.deepEqual(ids(halt), ["close", "send_back", "retry", "later"]);
    assert.deepEqual(ids({ ...halt, halt: { ...halt.halt, canSendBack: false } }), ["close", "retry", "later"]);
    const osc = { ...stuck, oscillations: [{ ref: "r", claim: "c", priorRef: "p", prior: "a", current: "b" }] };
    assert.deepEqual(ids(osc), ["ignore", "accept", "hand_fix", "continue", "later"], "a card of reversals can also be accepted or done by hand, as it always could");
    assert.deepEqual(op(osc, "continue").input, {
      kind: "text", field: "note", required: true,
      boundaries: { field: "boundaries", reversals: [{ ref: "r", claim: "c", priorRef: "p", prior: "a", current: "b" }] },
    }, "the loop needs a side picked or a note, and the reversals to pick over are the operation's own");
    assert.equal(op(osc, "accept").input.boundaries, undefined, "an accept settles no boundary");
    // the way back to the plan is offered only beside the judge's recommendation, and where the loop can take it
    const recommendation = { choice: "replan", reasons: [] };
    assert.ok(ids({ ...stuck, recommendation }).includes("replan"));
    assert.ok(!ids({ ...stuck, budget: { cost: 1, limit: 0, parts: [], subscription: [] }, recommendation }).includes("replan"));
    assert.ok(!ids({ ...osc, recommendation }).includes("replan"), "an oscillation the loop cannot send back has none");
    assert.ok(ids({ ...osc, recommendation, onReplan: { to: "plan" } }).includes("replan"));
  });

  it("declares the per-finding corrections and boundaries on the operations that carry them", () => {
    // every accepted finding, with the handlings it may be given and whether the fix then takes each (C-272-1, C-272-3)
    const handlings = (severity, inFixOf) => ["fix", "followup", "skip"].map((action) => ({ action, severity: action !== "fix" && severity === "must" ? "should" : severity, inFix: inFixOf === action, current: false }));
    const accepted = [
      { ref: "F-1", severity: "must", claim: "c", path: "a.ts", action: "fix", inFix: true, handlings: handlings("must", "fix") },
      { ref: "F-2", severity: "should", claim: "d", action: "followup", inFix: false, handlings: handlings("should", "fix") },
    ];
    const osc = { ...FOURTEEN[8], accepted, oscillations: [{ ref: "r", claim: "c", path: "b.ts", priorRef: "p", prior: "a", current: "b" }] };
    assert.deepEqual(op(osc, "continue").input.corrections, { field: "corrections", findings: accepted });
    assert.deepEqual(op(osc, "accept").input.corrections, { field: "corrections", findings: accepted });
    assert.equal(op(osc, "continue").input.boundaries.reversals[0].path, "b.ts");
    // a stop with no finding accepted or no reversal declares none, and the hand-off carries no input
    assert.equal(op(FOURTEEN[8], "accept").input.corrections, undefined);
    assert.equal(op({ ...FOURTEEN[8], accepted }, "continue").input.boundaries, undefined);
    assert.deepEqual(op(osc, "hand_fix").input, { kind: "none" });
    // the key of the confirm over an accept moves with the findings offered
    assert.notEqual(op(osc, "accept").confirmKey, op({ ...osc, accepted: [accepted[0]] }, "accept").confirmKey);
    // the old screen's list (`open`) is not the declaration: the operations read the accepted findings
    assert.equal(op({ ...FOURTEEN[8], open: [{ ref: "F-1", severity: "must", claim: "c" }] }, "accept").input.corrections, undefined);
  });

  it("holds the review's ok while a changed file's diff is unread, and keeps sending it back", () => {
    const review = FOURTEEN[4];
    assert.equal(op(review, "ok").hold, undefined, "nothing changed is a diff that was read");
    const read = { ...review, diffFiles: ["a.ts"], diffs: [{ file: "a.ts", fileIndex: 1, fileTotal: 1, before: [], after: [{ marker: "+", code: "x" }] }] };
    assert.equal(op(read, "ok").hold, undefined);
    // the base was not readable: no diff was counted at all
    const noBase = { ...review, diffFiles: undefined, baseNote: "parent lane が終わっています" };
    assert.match(op(noBase, "ok").hold.reason, /parent lane が終わっています/);
    assert.match(op(noBase, "ok").hold.reason, /実装へ戻す/, "the way out is named");
    assert.equal(op(noBase, "reject_retry").hold, undefined, "sending it back stays open");
    // one file git could not give
    const unread = { ...read, diffs: [{ ...read.diffs[0], unread: "bad object" }] };
    assert.match(op(unread, "ok").hold.reason, /a\.ts.*bad object/);
    // files named but no diffs carried
    assert.match(op({ ...review, diffFiles: ["a.ts"] }, "ok").hold.reason, /届いていません/);
    // a cut at the file limit is not unread: the card says how many files are left and where to read them
    const cut = { ...read, diffs: [{ ...read.diffs[0], fileTotal: 150 }] };
    assert.equal(op(cut, "ok").hold, undefined);
  });

  it("names the reservation of a submit approval apart from the conditions on what is written", () => {
    const ship = FOURTEEN[5];
    const checked = { ...ship, proposal: { mode: "pr", blocking: 0, checks: [], pr: { title: "t", body: "b" }, token: "tok", head: "h1", expiresAt: "2999-01-01T00:00:00Z" }, head: "h1", commit: { draft: "feat: x" } };
    const approve = op(checked, "approve");
    assert.equal(approve.hold, undefined, "nothing in the record holds it");
    assert.equal(approve.variant, "new-pr");
    assert.deepEqual(approve.sends, { commit: true, pr: true });
    assert.deepEqual(approve.conditions.map((c) => c.id), ["fresh", "commit_message", "pr_title"], "what depends on the text is named, not decided");
    assert.deepEqual(approve.payload, { iddId: "#1", token: "tok" });
    // a failing check, a head that moved and a records-only landing hold it whatever is written
    assert.match(op({ ...checked, proposal: { ...checked.proposal, blocking: 1, checks: [{ name: "unit", status: "fail", severity: "blocking" }] } }, "approve").hold.reason, /./);
    assert.match(op({ ...checked, head: "h2" }, "approve").hold.reason, /commit が進みました/);
    const landing = { ...ship, land: { blocking: 0, mergeCommit: "m", head: "h", token: "t" }, head: "h", recordsOnly: { reason: "記録だけ" } };
    assert.equal(op(landing, "approve").hold.reason, "記録だけ");
    assert.deepEqual(op(landing, "approve").conditions ?? [], []);
    // the check is offered while the approval cannot be given; a submit never checked offers it
    assert.ok(op(ship, "check"), "an unchecked submit asks for its check");
    assert.equal(op(ship, "check").keepsCard, true);
  });

  it("names the outbound approval's conditions by the kind of post, and the batch's lanes condition", () => {
    const post = FOURTEEN[7];
    assert.deepEqual(op(post, "approve").conditions.map((c) => c.id), ["post_title"]);
    assert.deepEqual(op({ ...post, outKind: "gh-pr-review" }, "approve").conditions.map((c) => c.id), ["review_body"]);
    assert.deepEqual(op({ ...post, outKind: "gh-pr-body", baseTitle: "t", baseBody: "b" }, "approve").conditions.map((c) => c.id), ["body_changed", "post_title"]);
    assert.deepEqual(op({ ...post, outKind: "gh-pr-replies", replies: [{ posted: true }, { posted: false }] }, "approve").conditions, [{ id: "replies_to_post", posted: [true, false] }]);
    const batch = FOURTEEN[6];
    assert.deepEqual(op(batch, "approve").conditions, [{ id: "lanes_kept" }]);
    assert.match(op({ ...batch, running: { phase: "checking", lanes: [], checking: true } }, "approve").hold.reason, /進行中/);
    assert.ok(op({ ...batch, settled: true }, "approve").hold);
  });

  it("answers the four kinds the new screen used to set aside: a check, a split, a replacement and low space", () => {
    assert.deepEqual(ids(FOURTEEN[4]), ["ok", "reject_retry", "reject_rethink", "later"]);
    assert.deepEqual(op(FOURTEEN[4], "reject_rethink").payload, { iddId: "#1", nextStage: "s1_rethink" });
    assert.deepEqual(op(FOURTEEN[4], "reject_rethink").input, { kind: "text", field: "feedback", required: true });
    assert.deepEqual(op(FOURTEEN[4], "reject_retry").input, { kind: "text", field: "feedback", required: true });
    assert.deepEqual(op(FOURTEEN[4], "reject_retry").payload, { iddId: "#1", nextStage: "s2_retry" });
    assert.deepEqual(ids(FOURTEEN[2]), ["approve", "reslice", "single", "revise", "later"]);
    assert.equal(op(FOURTEEN[2], "approve").hold, undefined);
    const over = { ...FOURTEEN[2], proposal: { ...FOURTEEN[2].proposal, approvable: false, limit: 4 } };
    assert.match(op(over, "approve").hold.reason, /4 本/, "a split over the limit cannot be approved, and says why");
    assert.deepEqual(ids(FOURTEEN[11]), ["reload", "later"]);
    assert.equal(op(FOURTEEN[11], "reload").door, "reload");
    assert.deepEqual(ids({ ...FOURTEEN[11], waiting: "requests", open: [], requests: [{ method: "POST", path: "/x", startedAt: AT, sending: false }] }), ["later"], "a wait on requests offers no cut");
    assert.deepEqual(ids(FOURTEEN[10]), ["later"]);
    assert.ok(decisionOf(FOURTEEN[10]).material.some((m) => m.key === "free"), "the materials carry what the card is read by");
    assert.ok(decisionOf(FOURTEEN[11]).material.some((m) => m.key === "conversation_1"));
  });

  it("offers a kind this engine does not know no judgement, only putting it off", () => {
    assert.deepEqual(ids({ kind: "cosmic", iddId: "#9" }), ["later"]);
  });

  it("is put on every card by withDecisions, from the card's own fields", () => {
    const answered = withDecisions(FOURTEEN);
    assert.equal(answered.length, 14);
    assert.ok(answered.every((i) => i.decision && i.decision.waiting === i.kind));
    // a copy of a card is answered from its own fields, not from the card it was copied from
    const copy = withDecisions([{ ...answered[3], intentPath: "_docs/intent/x/" }])[0];
    assert.ok(copy.decision.operations.find((o) => o.id === "go").hold);
  });
});

describe("the state carries the answer on its cards", () => {
  let dir;
  afterEach(() => {
    delete process.env.IDD_STATE_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("puts a decision on every card buildState returns, including a split over its limit", () => {
    dir = mkdtempSync(join(tmpdir(), "idd-card-decision-"));
    process.env.IDD_STATE_DIR = dir;
    writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-127", parent_id: null, created_at: AT, linear_issue_url: null, gh_issue_url: "https://github.com/me/app/issues/131", pull_req_url: null, source_type: "github", context: "", title: "粒度の案", area: "Demo" }) + "\n");
    const children = [1, 2, 3, 4, 5].map((n) => ({ title: `c${n}`, whole: `w${n}`, places: [`p${n}`], after: [] }));
    writeFileSync(join(dir, "lifecycle-Demo.jsonl"), [["lane_open", {}], ["s1_granularity_proposed", { kind: "split", reason: "多い", children }]].map(([event, attrs]) => JSON.stringify({ idd_id: "IDD-127", event, at: AT, attrs })).join("\n") + "\n");
    const state = buildState();
    assert.ok(state.items.length > 0);
    for (const item of state.items) assert.ok(item.decision, `${item.kind} carries its decision`);
    const card = state.items.find((i) => i.kind === "granularity");
    assert.equal(card.decision.operations.find((o) => o.id === "approve").hold !== undefined, !card.proposal.approvable);
    assert.ok(card.decision.operations.find((o) => o.id === "reslice"));
    assert.equal(state.progress.open, state.items.length);
  });
});

describe("the review's way back is recorded as the stage the card names", () => {
  let dir;
  afterEach(() => {
    delete process.env.IDD_STATE_DIR;
    delete process.env.IDD_REPOS_FILE;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // a lane that stands at the review card with nothing owed by the executor
  const atReview = () => {
    dir = mkdtempSync(join(tmpdir(), "idd-review-ways-"));
    writeFileSync(join(dir, "repos.yaml"), JSON.stringify({ repos: { "me/app": { upstream: join(dir, "u"), work: join(dir, "w"), public_base: "main" } } }));
    process.env.IDD_STATE_DIR = dir;
    process.env.IDD_REPOS_FILE = join(dir, "repos.yaml");
    writeFileSync(join(dir, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "me/app", title: "T", context: "", source_type: "github", gh_issue_url: "https://github.com/me/app/issues/1" }) + "\n");
    const rows = [["lane_open", {}], ["s1_ready", { depth: "deep" }], ["s1_plan_review_started", { run_ids: ["P1"] }], ["s1_plan_review_done", { must: 0, should: 0, nit: 0 }], ["s1_go", {}], ["s2_start", { started_from_commit: "c0" }], ["s2_result", { outcome: "success", changed_files: ["a.ts"] }], ["s3_ready", {}]];
    const events = rows.map(([event, attrs]) => ({ idd_id: "IDD-1", event, at: AT, attrs }));
    writeFileSync(join(dir, "lifecycle-me-app.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };

  for (const [id, group] of [["reject_retry", "impl"], ["reject_rethink", "plan"]]) {
    it(`${id}: the row the ledger writes names the stage the operation names, and the lane stands there`, async () => {
      const { applyDecision, laneStageSpans, readLifecycle } = await import("@idd/core");
      atReview();
      const sent = op(FOURTEEN[4], id);
      const done = await applyDecision(sent.action, { ...sent.payload, iddId: "IDD-1", feedback: "直して" });
      assert.equal(done.ok, true, done.error);
      const lane = readLifecycle().filter((r) => r.idd_id === "IDD-1");
      assert.equal(lane.at(-1).event, "s3_reject");
      assert.equal(lane.at(-1).attrs.next_stage, sent.payload.nextStage, "the recorded stage is the one the card sent");
      assert.equal(laneStageSpans(lane).at(-1).key, group, "the stage the lane is read at is the one the card names");
    });
  }
});
