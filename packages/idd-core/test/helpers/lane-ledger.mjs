import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readLifecycle } from "../../src/ledger/read.ts";
import { scratchDir } from "./scratch.mjs";

// The lane "IDD-1" the shape-judge and replan tests build their ledgers from: events on a rising clock, the plan that
// went through its review and GO, the two rounds that stopped at the card, and the state directory the write side reads.

let clock = 0;
/** an event of lane IDD-1 one minute after the one before it */
export const ev = (event, attrs = {}) => ({ event, idd_id: "IDD-1", at: new Date(Date.UTC(2026, 9, 1, 0, clock++)).toISOString(), attrs });

/** a lane that went through the plan review and the GO of a plan of `depth`, and whose executor started */
export const reviewedPlan = (depth = "deep") => [
  ev("lane_open"),
  ev("s1_ready", { depth }),
  ev("s1_plan_review_started", { run_ids: ["P1"] }),
  ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 }),
  ev("s1_go"),
  ev("s2_start", { started_from_commit: "c0" }),
];

/** a round of the review loop: the executor's result changing `files`, then the triage accepting a must on `path` */
export const round = (n, files, path, claim, extra = {}) => [
  ev("s2_result", { outcome: "success", changed_files: files }),
  ev("s2_triage_done", { kind: "blind", round: n, accepted: [{ severity: "must", path, claim, action: "fix" }], ...extra }),
];

/** two rounds with the fix between them: the first changes `files` and names a.ts, the second changes `second` and names its first file */
export const twoRounds = (files, second, extra = {}) => [
  ...round(1, files, "a.ts", "x"),
  ev("s2_fix_sent", { round: 1 }),
  ...round(2, second, second[0], "y", extra),
];

/** a lane stopped at its card after two rounds that named files a.ts then b.ts */
export const stopped = () => [
  ...reviewedPlan(),
  ...twoRounds(["a.ts"], ["b.ts"], { escalated_claims: [] }),
  ev("s2_review_escalated", { reason: "修正が上限に達した" }),
];

/** the lane after the card's replan answer, and after its planner reported again (events after them are made after the call, so their clock follows) */
export const replanned = () => [...stopped(), ev("s1_replan_requested", { rounds: 2 })];
export const replannedReady = () => [...replanned(), ev("s1_ready", { depth: "deep" })];
/** a plan review that found nothing */
export const cleanReview = () => ev("s1_plan_review_done", { must: 0, should: 0, nit: 0 });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** the lifecycle events of lane IDD-1 as the write side reads them back */
export const laneEvents = () => readLifecycle().filter((e) => e.idd_id === "IDD-1");

export const backlogRow = { idd_id: "IDD-1", area: "default", title: "T", context: "", created_at: "2026-10-01T00:00:00Z" };

/** a row of planner-sessions.jsonl or executor-sessions.jsonl (`kind` is "planner" or "executor") */
export const sessionRow = (kind, id, startedAt, extra = {}) => ({ idd_id: "IDD-1", [`${kind}_session_id`]: id, started_at: startedAt, worktree_path: `/wt/${kind}`, branch: "idd/IDD-1", ...extra });

/** write the rows of a state file: the backlog (default) or a session file by name */
export function writeRows(state, file, ...rows) {
  writeFileSync(join(state, file), jsonl(rows));
}

/** a state directory (and the settings files beside it) holding the lifecycle of `events`, made the way the write side reads it */
export function openState(prefix, events, roles) {
  const root = scratchDir(prefix);
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(root, "repos.yaml"), "repos:\n");
  const env = { IDD_STATE_DIR: state, IDD_REPOS_FILE: join(root, "repos.yaml") };
  if (roles) {
    writeFileSync(join(root, "roles.yaml"), roles);
    env.IDD_ROLES_FILE = join(root, "roles.yaml");
  }
  Object.assign(process.env, env);
  writeFileSync(join(state, "lifecycle-default.jsonl"), jsonl(events));
  return { root, state };
}
