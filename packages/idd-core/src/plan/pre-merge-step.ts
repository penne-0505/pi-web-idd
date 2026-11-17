import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { FactNeed } from "../ledger/review-loop.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The mainline merge before a lane's first review: the steps the tick runs for one lane, and the action they leave.
 *
 * The decision is the MoonBit fold's (`packages/idd-fold/pre_merge.mbt`), from the lane's rows and the observations
 * the caller gathered (C-205-5). The caller keeps the readings of git, the runner and the lane's lock, and the
 * effects themselves: the merge, the envelope, the records. What it does not do is decide which of them comes next.
 *
 * A fold that cannot be read is a failure the caller sees, never a second reading in TypeScript.
 */

/** the action a lane's merge leaves: nothing to do, the review goes on, the lane waits, or the review starts */
export type PreMergeAction = "none" | "proceed" | "busy" | "awaiting" | "merged";

/** one step of the merge, as the fold answers it */
export interface PreMergeStep {
  do: "write" | "call" | "action";
  /** the record to write, and its attrs */
  event?: string;
  attrs?: Record<string, unknown>;
  /** the helper to call, the site it is called from, and the fact its answer is kept under */
  helper?: string;
  site?: string;
  fact?: string;
  keep?: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** the action, and the failure the caller reports for the lane */
  action?: PreMergeAction;
  error?: string;
}

/** the fold's answer: one step, or the observations it still wants */
export interface PreMergeAnswer extends PreMergeStep {
  needs?: FactNeed[];
}

/** what the caller reads when the fold asks for an observation, and what it says beside it */
export type PreMergeObserver = (need: FactNeed, put: (id: string, value: unknown) => void) => unknown;

/** what the caller does with a step */
export interface PreMergeRun {
  /** write the record the step names, and answer the row as the caller's snapshot holds it */
  write(event: string, attrs: Record<string, unknown>): Promise<LifecycleRecord>;
  /** call the helper the step names; its failure is answered as `{ error }`, never thrown (the fold decides) */
  call(step: PreMergeStep): Promise<unknown>;
  /** let go of whatever the steps took hold of (the lane's lock) */
  done?(): void;
}

/** the lane's merge, as the caller reads it */
export interface PreMergeOutcome {
  action: PreMergeAction;
  error?: string;
}

/** how many rounds the observations are asked for */
const ASK_ROUNDS = 24;
/** how many steps one lane is run for */
const STEP_ROUNDS = 24;

/**
 * Ask the fold until it has every observation it needs: a reading the caller cannot make is answered as null, and
 * the fold reads it as one more reading that failed, never as a decision somebody else took.
 */
async function askPreMerge(
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: PreMergeObserver,
  memory: Record<string, unknown>,
): Promise<PreMergeAnswer> {
  for (let round = 0; round < ASK_ROUNDS; round += 1) {
    const answer = laneAnswer<PreMergeAnswer>("pre_merge", events, { facts: { ...facts, ...memory } });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (need.id in facts) continue;
      const value = observer(need, (id, read) => { facts[id] = read; });
      facts[need.id] = value ?? null;
    }
  }
  throw new Error("MoonBit の畳み（pre_merge）が答えを返しませんでした");
}

/**
 * Run one lane's merge: ask the fold for the next step, run it, and ask again. A record the step writes is added to
 * the rows at once, so the rest of the answer reads the ledger as it is now — the duplicate guards on the skip and
 * the conflict records depend on it. A write the fold ends the pass at (the conflict instruction) answers its action
 * then and there: the instruction is sent, and the lane waits for the executor. The caller keeps the records it wrote:
 * a gated write a helper makes (the review origin's move) is one of them.
 */
export async function drivePreMerge(
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: PreMergeObserver,
  run: PreMergeRun,
): Promise<PreMergeOutcome> {
  const rows = [...events];
  const memory: Record<string, unknown> = {};
  try {
    for (let round = 0; round < STEP_ROUNDS; round += 1) {
      const step = await askPreMerge(rows, facts, observer, memory);
      if (step.do === "action") {
        return { action: step.action ?? "none", ...(step.error ? { error: step.error } : {}) };
      }
      if (step.do === "write") {
        rows.push(await run.write(String(step.event), step.attrs ?? {}));
        if (step.action) return { action: step.action };
        continue;
      }
      // a call: the fold reads its answer next, so the outcome is kept under the fact the step named
      memory[String(step.fact)] = { result: await run.call(step), keep: step.keep ?? {} };
    }
  } finally {
    run.done?.();
  }
  throw new Error("本流の取り込みの一歩が終わりませんでした");
}
