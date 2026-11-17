import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const actions = await jiti.import("./action-classes.ts");
const { shipApprovalOf } = await jiti.import("./ui-session.ts");

/** every action the decide API takes: the cases of applyDecision, and those the route answers itself */
function decideActions() {
  const write = readFileSync(new URL("../../../idd-core/src/ledger/write.ts", import.meta.url), "utf8");
  const apply = write.slice(write.indexOf("export async function applyDecision"));
  const cases = [...apply.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]);
  const route = readFileSync(new URL("../routes/decide.ts", import.meta.url), "utf8");
  const routed = [...route.matchAll(/body\.action === "([a-z0-9_]+)"/g)].map((m) => m[1]);
  return new Set([...cases, ...routed]);
}

test("every decision the decide API takes is in one of the two groups, and the outbound ones are the gates'", () => {
  const { OUTBOUND_ACTIONS, OTHER_ACTIONS, isOutboundAction, unclassifiedActions } = actions;
  assert.ok([OUTBOUND_ACTIONS, OTHER_ACTIONS].every(Array.isArray), "the classification is exported");
  const taken = decideActions();
  assert.ok(taken.size > 20, `the actions were read (${taken.size})`);
  assert.deepEqual(unclassifiedActions(taken), [], "a new decision must be put in one of the two groups");
  const named = [...OUTBOUND_ACTIONS, ...OTHER_ACTIONS];
  assert.equal(new Set(named).size, named.length, "no action is in both groups");
  assert.deepEqual(named.filter((a) => !taken.has(a)).sort(), [], "a group names only decisions the API takes");
  // the two that can leave this machine, and only those
  assert.deepEqual([...OUTBOUND_ACTIONS].sort(), ["land_batch_approve", "outbound_approve", "s4_verify_clean"]);
  assert.ok(isOutboundAction("land_batch_approve"));
  assert.equal(isOutboundAction("outbound_approve"), true);
  assert.equal(isOutboundAction("s4_verify_clean"), true);
  assert.equal(isOutboundAction("s1_go"), false);
  assert.equal(isOutboundAction("ignore"), false);
  // the decisions that ask for no signature are on the other side: a send-back, a GO, an answer, a discard
  for (const action of ["s3_reject", "s4_revise", "s1_revise", "outbound_discard", "s1_go", "s0_requeue_go", "anyway_go", "answer", "s4_prepare", "merge"]) {
    assert.equal(isOutboundAction(action), false, action);
    assert.ok(OTHER_ACTIONS.includes(action), action);
  }
});

test("AC-037: answering a proposal asks for no signature and is on the side that leaves this machine alone", () => {
  const { OTHER_ACTIONS, isOutboundAction } = actions;
  for (const action of ["proposal_approve", "proposal_reject"]) {
    assert.ok(OTHER_ACTIONS.includes(action), action);
    assert.equal(isOutboundAction(action), false, action);
  }
});

test("answering an instruction proposal needs a signature though it leaves nothing outside this machine", () => {
  const { OTHER_ACTIONS, SIGNED_LOCAL_ACTIONS, needsSignature, isOutboundAction } = actions;
  assert.ok(SIGNED_LOCAL_ACTIONS.includes("instruction_approve"));
  assert.equal(needsSignature("instruction_approve"), true);
  assert.equal(isOutboundAction("instruction_approve"), false);
  assert.equal(OTHER_ACTIONS.includes("instruction_approve"), false, "an approval in the unsigned list would pass without a signature");
  // putting one away deletes its text from the open file, which an agent that reached the door could do unread
  assert.ok(SIGNED_LOCAL_ACTIONS.includes("instruction_reject"));
  assert.equal(needsSignature("instruction_reject"), true);
  assert.equal(isOutboundAction("instruction_reject"), false);
  assert.equal(OTHER_ACTIONS.includes("instruction_reject"), false, "a rejection in the unsigned list would pass without a signature");
});

test("AC-005: the granularity card's four presses ask for no signature and leave this machine alone", () => {
  const { OTHER_ACTIONS, isOutboundAction } = actions;
  for (const action of ["granularity_approve", "granularity_reslice", "granularity_revise", "granularity_single"]) {
    assert.ok(OTHER_ACTIONS.includes(action), action);
    assert.equal(isOutboundAction(action), false, action);
  }
});

test("the submit card's approval is read as the commit message, a new PR's text and the passkey signature, and nothing else", () => {
  // an R2 override (removed with R2, 2026-10-22) is one of the fields left out
  assert.deepEqual(shipApprovalOf({ iddId: "IDD-1", token: "t", commitMessage: "fix: 直す", pr: { title: "題", body: "本文" }, r2Override: true, push: true }), { commitMessage: "fix: 直す", pr: { title: "題", body: "本文" } });
  assert.deepEqual(shipApprovalOf({ commitMessage: 3, r2Override: true }), {}, "only a string message");
  assert.deepEqual(
    shipApprovalOf({ commitMessage: "fix: 直す", pr: { title: "題", body: "本文" }, nonce: "n-1", assertion: { id: "key" } }),
    { commitMessage: "fix: 直す", pr: { title: "題", body: "本文" }, nonce: "n-1", assertion: { id: "key" } },
  );
  assert.deepEqual(shipApprovalOf({ nonce: 3, assertion: "x" }), {}, "only a string nonce and an object assertion");
});
