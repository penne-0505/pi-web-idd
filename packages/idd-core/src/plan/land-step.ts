import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { FactNeed } from "../ledger/review-loop.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The landing's next step: the record the tick writes for one lane, the helper it calls, and the point it reads
 * the ledger again.
 *
 * The step is decided by the MoonBit fold (`packages/idd-fold/land_step.mbt`) from the lane's rows and the
 * observations the caller gathered (C-202-1). The caller runs the steps in the order they come; it never decides
 * which one is next (C-202-2). A fold that cannot be read is a failure the caller sees, never a second reading in
 * TypeScript.
 *
 * Two readings are asked for. `carry` is an approval still in force that the pass carries out
 * (`recheckApprovedLand`); `scan` is a lane at the landing's card, either one whose failed check the pass settles
 * or one the pass checks afresh. The pass's order — which lanes, in which order, and the points where the approval
 * sweep runs — is the caller's, as the push stage's lane loop is (`submit-step.ts`, C-199-2).
 */

/** one step of the landing stage, as the fold answers it */
export interface LandStep {
  do: "write" | "call" | "result" | "end";
  /** the record to write, and its attrs */
  event?: string;
  attrs?: Record<string, unknown>;
  /** the helper to call, the site it is called from, and the fact its answer is kept under */
  helper?: string;
  site?: string;
  fact?: string;
  keep?: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** a call whose failure the stage does not catch: it is thrown on to the tick, as before */
  fatal?: boolean;
  /** the ledger is read again after this call */
  reread?: boolean;
  /** the result list, the lane, and what the list carries */
  field?: "prepared" | "checking" | "merged" | "sentBack" | "inherited" | "held" | "errors";
  id?: string;
  error?: string;
  reason?: string;
  /** the check a lane waits on (null when the pass only knows it is running) */
  checking?: string | null;
  /** the merge commit a merged lane was advanced to */
  committed?: string | null;
  /** the checked results a check took over from an earlier mainline tip, as the record carries them */
  inherit?: Record<string, unknown>;
}

/** the fold's answer: the steps, or the observations it still wants */
export interface LandAnswer {
  steps?: LandStep[];
  needs?: FactNeed[];
}

/** where the observations the fold asks for come from: the caller's readings, never a decision */
export type LandObserver = (need: FactNeed, memory: Record<string, unknown>) => unknown;

/** which reading of the landing a lane is asked for */
export type LandMode = "carry" | "scan";

/** what the caller does with a step */
export interface LandRun {
  /** write the record the step names */
  write(event: string, attrs: Record<string, unknown>): Promise<void>;
  /** call the helper the step names, and answer what it answered */
  call(step: LandStep): Promise<unknown>;
  /** put the lane into one of the stage's result lists, with what the step carries */
  result(step: LandStep): void;
  /** the lane's rows, as the ledger has them now */
  reload(): LifecycleRecord[];
  /** whether a failure is the repo's lock refusing: a wait, not an error (DEC-2328) */
  lockRefused(err: unknown): boolean;
}

/**
 * How long the tick waits after a failure of the environment before it checks the same group again, and how many
 * times it checks the same lane head and mainline tip again for the environment's failures. The fold reads both,
 * so the tick's waiting and the answer the card reads are one reading.
 */
export const LAND_RECHECK_INTERVAL_MS = 2 * 60_000;
export const LAND_RECHECK_MAX = 3;

/** how many rounds a lane's observations are asked for */
const ASK_ROUNDS = 24;

async function askLand(
  mode: LandMode,
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: LandObserver,
  memory: Record<string, unknown>,
): Promise<LandAnswer> {
  for (let round = 0; round < ASK_ROUNDS; round += 1) {
    const answer = laneAnswer<LandAnswer>("land_step", events, {
      mode,
      facts,
      maxRechecks: LAND_RECHECK_MAX,
      recheckIntervalMs: LAND_RECHECK_INTERVAL_MS,
    });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (need.id in facts) continue;
      facts[need.id] = observer(need, memory) ?? null;
    }
  }
  throw new Error("MoonBit の畳み（land_step）が答えを返しませんでした");
}

/** how many step lists one lane is run for: a stage that wrote nothing new must not loop */
const STEP_ROUNDS = 24;

/**
 * Run one lane's landing stage: ask the fold for the next steps, run them in order, and ask again where the answer
 * says the ledger is read anew. A helper's answer is handed back under the fact the step named, so the fold reads
 * what the helper answered (C-202-3).
 */
export async function driveLandSteps(
  mode: LandMode,
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: LandObserver,
  run: LandRun,
): Promise<void> {
  let rows = events;
  const memory: Record<string, unknown> = {};
  for (let round = 0; round < STEP_ROUNDS; round += 1) {
    const answer = await askLand(mode, rows, { ...facts, ...memory }, observer, memory);
    const steps = answer.steps ?? [];
    if (!steps.length) return;
    let again = false;
    let reload = false;
    for (const step of steps) {
      if (step.do === "write") {
        await run.write(String(step.event), step.attrs ?? {});
        continue;
      }
      if (step.do === "result") {
        run.result(step);
        continue;
      }
      if (step.do === "end") return;
      // a call: the fold reads its answer, and the lane is asked again
      try {
        memory[String(step.fact)] = { result: await run.call(step), keep: step.keep ?? {} };
      } catch (err) {
        if (step.fatal) throw err;
        memory[`err|${step.helper}|${step.site}`] = {
          error: String((err as Error).message ?? err),
          lockRefused: run.lockRefused(err),
        };
      }
      again = true;
      if (step.reread) reload = true;
    }
    if (!again) return;
    if (reload) rows = run.reload();
  }
  throw new Error("取り込みの一歩が終わりませんでした");
}
