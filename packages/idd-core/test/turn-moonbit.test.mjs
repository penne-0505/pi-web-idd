import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as reference from "../src/ledger/turn-reference.ts";
import { oldestUnansweredReference } from "../src/ledger/derive-reference.ts";
import * as pick from "../src/ledger/pick-reference.ts";
import { laneAnswer } from "../src/intent/moonbit-fold.ts";
import { STRICT_EVENTS } from "../src/ledger/allowed.ts";

/**
 * The lane's turn, the waits around it and the stages' answer to "do you pick this lane up?", held against
 * committed fixtures.
 *
 * A real ledger lives outside git and the test entry drops the `IDD_` variables, so a test cannot see one. What a
 * real ledger would add — a question whose batch carries no id, a batch id of the wrong shape, a lane whose last
 * word is a wait for Claude Code's windows, a name no derivation reads — is written here instead, so this check
 * answers the same on every machine. The real ledger's every prefix is checked by
 * `packages/idd-fold/crosscheck.mjs`.
 *
 * The floor is `_docs/qa/pi-web-idd/idd-199/qa.md`: AC-001 (every prefix, the same answer), AC-002 (the running
 * path takes the fold's answer and does not fall back), AC-004 (the answer is the rows and the facts alone).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "turn", "lifecycle.jsonl");

function rowsOf() {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`fixture の ${index + 1} 行目が JSON ではありません: ${String(error)}`);
      }
    });
}

/** the answer without the keys a JSON round trip leaves out, so an absent field and an undefined one are one */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const rows = rowsOf();
const lanes = new Map();
for (const row of rows) {
  if (!lanes.has(row.idd_id)) lanes.set(row.idd_id, []);
  lanes.get(row.idd_id).push(row);
}

/** every prefix of every lane: what the caller reads at each step */
function* prefixes() {
  for (const [lane, events] of lanes) {
    for (let n = 1; n <= events.length; n += 1) {
      yield { lane, n, prefix: events.slice(0, n) };
    }
  }
}

/** the three states of the runtime's reading of Claude Code's windows */
const QUOTAS = [
  { mode: "record", now: 1792473600000 },
  { mode: "free", now: 1792473600000 },
  { mode: "unknown", now: 1792473600000 },
  { mode: "busy", now: 1792473600000, resetsAt: 1792473600, reason: "枠が埋まっている" },
];

/** the facts the stages read that the ledger does not hold */
const FACTS = [
  {},
  { hasSession: true },
  { hasSession: false, publishes: true, hasWorktree: true, hasHead: true, hasLocation: true },
  { hasSession: false, publishes: false, hasWorktree: false, hasHead: false, hasLocation: false },
  { blocked: true, depth: "shallow", lane: "IDD-927", cost: 10, base: 5, hasBlockers: true },
  { depth: "deep", lane: "IDD-927", cost: 1, base: 5, lastBatchAnswered: false },
  { awaitedRole: "executor", targetRole: "executor", pendingFixEnvelope: false },
  { awaitedRole: "planner", targetRole: "executor", pendingFixEnvelope: true },
  { reloadHold: true, waitingSlot: true, worktreeBusy: true, pendingEnvelope: true },
  {
    purposes: [{ status: "proposed", raisedBy: "IDD-927" }],
    choices: [{ id: "C-1", places: [{ kind: "root" }] }],
    laneRows: [{ supersedes: ["C-1"] }],
  },
];

test("AC-001 / AC-004: the turn and the waits are the same answer at every prefix", () => {
  for (const { lane, n, prefix } of prefixes()) {
    const where = `${lane} の ${n} 行目まで`;
    for (const quota of QUOTAS) {
      // the turn: the facts are the caller's, and the fold judges the rows and the facts together
      for (const facts of [{}, { pendingEnvelope: true }, { cardBuildable: false }, { awaitedAgent: { role: "planner" } }]) {
        const mine = laneAnswer("lane_turn", prefix, { ...facts, quota });
        const theirs = reference.laneTurnReference(prefix, facts, quota);
        assert.deepEqual(plain(mine), plain(theirs), `${where}で番（quota=${quota.mode}）`);
        const mineSince = laneAnswer("turn_since", prefix, { ...facts, quota }) ?? null;
        const theirsSince = reference.turnSinceReference(prefix, facts, quota) ?? null;
        assert.deepEqual(plain(mineSince), plain(theirsSince), `${where}で待ちの始まり（quota=${quota.mode}）`);
      }
      assert.deepEqual(
        plain(laneAnswer("awaiting_question", prefix, { quota })),
        plain(reference.awaitingQuestionReference(prefix, quota)),
        `${where}で答えの無い質問（quota=${quota.mode}）`,
      );
      assert.deepEqual(
        plain(laneAnswer("awaited_agent", prefix, { quota })),
        plain(reference.awaitedAgentReference(prefix, quota)),
        `${where}で待つ agent（quota=${quota.mode}）`,
      );
      assert.deepEqual(
        plain(laneAnswer("decision_since", prefix, { quota }) ?? null),
        plain(reference.decisionSinceReference(prefix, quota) ?? null),
        `${where}で決定の時点（quota=${quota.mode}）`,
      );
    }
    // the questions: the batch is matched by its id, and a batch that carries none needs any answer after it
    for (const since of [-1, 0, 1, 2]) {
      assert.equal(laneAnswer("oldest_unanswered", prefix, { since }), oldestUnansweredReference(prefix, since), `${where}で最古の未回答（since=${since}）`);
      assert.equal(laneAnswer("awaiting_answer", prefix, { since }), reference.awaitingAnswerReference(prefix, since), `${where}で回答待ちか（since=${since}）`);
      assert.deepEqual(
        plain(laneAnswer("unanswered_questions", prefix, { since })),
        plain(reference.unansweredQuestionsReference(prefix, since)),
        `${where}で未回答の質問（since=${since}）`,
      );
    }
    // the write side's refusal
    for (const event of [...STRICT_EVENTS, "s1_go", "lane_close", "s2_start", "s4_submit_started", "no_such_event"]) {
      assert.equal(
        laneAnswer("transition_refusal", prefix, { event, quota: QUOTAS[0] }),
        reference.transitionRefusalReference(event, prefix, QUOTAS[0]),
        `${where}で ${event} の断り`,
      );
    }
  }
});

test("AC-001: every stage's answer is the same at every prefix", () => {
  for (const { lane, n, prefix } of prefixes()) {
    const where = `${lane} の ${n} 行目まで`;
    for (const stage of ["prep", "exec", "check", "submit_prep", "submit_push", "land", "land_carry", "auto_go", "budget", "blocker", "pr_feedback", "watch", "stall"]) {
      for (const facts of FACTS) {
        for (const quota of QUOTAS) {
          const mine = laneAnswer("stage_pick", prefix, { stage, facts, quota });
          const theirs = pick.pickReference(stage, prefix, facts, quota);
          assert.deepEqual(plain(mine), plain(theirs), `${where}で ${stage} の拾う判定（facts=${JSON.stringify(facts)} / quota=${quota.mode}）`);
        }
      }
    }
  }
});

test("AC-001: the order of the approvals is the same answer", () => {
  assert.deepEqual(plain(laneAnswer("land_order", rows)), plain(pick.landOrderReference(rows)));
});

test("AC-002: a stage nobody knows is a failure the caller sees", () => {
  assert.throws(() => laneAnswer("stage_pick", rows, { stage: "no_such_stage", facts: {} }), /MoonBit の畳み/);
});

test("AC-004: a question whose batch id is null waits for penne, and an unrelated answer does not close it", () => {
  // the batch carries no id at all: any answer after it answers it, so only the last one waits
  const without = rows.filter((row) => row.idd_id === "IDD-921");
  assert.equal(laneAnswer("oldest_unanswered", without, { since: -1 }), 4);
  // the batch carries the id null: an answer that carries no id does not answer it
  const nulled = rows.filter((row) => row.idd_id === "IDD-934");
  assert.equal(laneAnswer("oldest_unanswered", nulled, { since: -1 }), 1);
  assert.equal(laneAnswer("awaiting_answer", nulled, { since: -1 }), true);
  // so the lane waits on penne, not on the engine
  const quota = { mode: "record", now: 1792473600000 };
  const facts = { pendingEnvelope: false, cardBuildable: true, awaitedAgent: null };
  assert.equal(laneAnswer("lane_turn", nulled, { ...facts, quota }), "penne");
  assert.deepEqual(
    plain(laneAnswer("lane_turn", nulled, { ...facts, quota })),
    plain(reference.laneTurnReference(nulled, facts, quota)),
  );
});

test("AC-004: a lane whose rows are all notes is judged, and the answer is the same on both sides", () => {
  const notes = rows.filter((row) => row.idd_id === "IDD-933");
  for (const stage of ["blocker", "stall"]) {
    const facts = {};
    const quota = { mode: "record", now: 1792473600000 };
    const mine = laneAnswer("stage_pick", notes, { stage, facts, quota });
    const theirs = pick.pickReference(stage, notes, facts, quota);
    assert.deepEqual(plain(mine), plain(theirs), `${stage} の拾う判定`);
  }
});

test("AC-004: the facts decide the answer, and the rows alone do not", () => {
  // the planner's start: a lane with a session is not the stage's business
  const lane = rows.filter((row) => row.idd_id === "IDD-931");
  const without = laneAnswer("stage_pick", lane, { stage: "prep", facts: { hasSession: false }, quota: QUOTAS[0] });
  const with_ = laneAnswer("stage_pick", lane, { stage: "prep", facts: { hasSession: true }, quota: QUOTAS[0] });
  assert.equal(without.pick, true);
  assert.equal(with_.pick, false);
  // the same lane, a different fact, a different answer: the answer is the rows and the facts together
  assert.notEqual(without.pick, with_.pick);
});
