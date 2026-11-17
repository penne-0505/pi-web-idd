/**
 * The decide API's decisions, split into the groups that matter, and the one place the engine says which of them need
 * a passkey signature. The engine's answer for each card names the signature of every operation from here, and the
 * screen reads that answer; no screen holds this list (C-265-2). The decide door refuses a decision no group names,
 * and a test reads the API's actions and fails on one left out, so a new decision has to be put in one of the groups.
 */

/** decisions that can change the work side's mainline or write outside it: a post, and a submit card's approval
 * (a push with its commit message and a new PR, a landing into the work side's mainline, a local completion, and one
 * signature over several landings laid on the mainline together) */
export const OUTBOUND_ACTIONS = ["outbound_approve", "s4_verify_clean", "land_batch_approve"];

/**
 * The decisions that write nothing outside this machine and still need the passkey signature: approving an
 * instruction proposal and putting one away. An approval changes what every later run and conversation is told; a
 * rejection deletes the proposal's text before the user has read it. The agent that filed the proposal can reach the
 * decide API, so the signature (which an agent cannot make) is what shows the user answered. Only a passkey signs
 * them; a PIN does not.
 */
export const SIGNED_LOCAL_ACTIONS = ["instruction_approve", "instruction_reject"];

/**
 * The GO card's judgements on a Purpose proposal. A rewrite adds one row to the intent column and moves no stage; a
 * withdrawal adds its row and sends the plan back to the planner in the same press, so a GO waits for the new report.
 * The decide door does not check its caller (the same as a GO, which confirms every proposal unsigned), so these stay
 * out of the agent's tools, the brief and the CLI instead (C-222-1).
 */
export const PURPOSE_PROPOSAL_ACTIONS = ["purpose_restate", "purpose_withdraw"];

/**
 * Every other decision the decide API takes. None of them changes the work side's mainline or writes outside this
 * machine: they come before the code
 * (a GO, a plan's revise, an answer to the planner or the executor), send the lane back into the loop (a send-back,
 * a reject), let a held lane go on where it stood (budget, a stalled session), rank it, start it over (`lane_redo`
 * closes the lane and opens a new one from the same Issue, and touches neither the ignore list nor anything outside
 * this machine), close a lane or put its Issue on intake's ignore list (`ignore`: those writes stay in the state
 * directory), only check (`s4_prepare` pushes nothing and takes only a lane already at the submit), queue a PR
 * body proposal (`pr_body_propose` writes nothing to GitHub), or answer a proposal (an approval or a rejection is
 * one row in the state directory: it applies nothing that leaves this machine and moves no stage).
 */
export const OTHER_ACTIONS = [
  "answer", "anyway_go", "ignore", "lane_budget_extend", "lane_redo", "lane_stall_resume", "merge",
  "outbound_discard", "pr_body_propose", "priority_elevated", "priority_reset", "proposal_approve",
  "proposal_reject", "s0_requeue_go", "s1_go",
  ...PURPOSE_PROPOSAL_ACTIONS,
  // the granularity card: approving a split or merge closes the lane and puts its Issue on the ignore list (both
  // stay in the state directory), and the other three only record the answer and queue a word to the same
  // planner session. None of them writes to GitHub or Linear (C-127-4, C-127-5, C-127-6).
  "granularity_approve", "granularity_reslice", "granularity_revise", "granularity_single",
  "s1_revise", "s2_review_accept", "s2_review_continue", "s2_review_hand_fix", "s2_review_replan", "s2_hand_fixed", "s3_ok", "s3_reject", "s4_prepare", "s4_revise",
  "s4_sub_todo", "speak",
];

/** whether a decision can write outside this machine, and so needs the passkey signature */
export function isOutboundAction(action: string): boolean {
  return OUTBOUND_ACTIONS.includes(action);
}

/** whether a decision needs the passkey signature, whether it writes outside this machine or not */
export function needsSignature(action: string): boolean {
  return OUTBOUND_ACTIONS.includes(action) || SIGNED_LOCAL_ACTIONS.includes(action);
}

/** the decisions of `actions` that no group names: a new decision must be put in one of them */
export function unclassifiedActions(actions: Iterable<string>): string[] {
  const classified = new Set([...OUTBOUND_ACTIONS, ...SIGNED_LOCAL_ACTIONS, ...OTHER_ACTIONS]);
  return [...actions].filter((action) => !classified.has(action)).sort();
}
