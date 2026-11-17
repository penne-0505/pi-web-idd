import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { FactNeed } from "../ledger/review-loop.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The push's next step: the record the tick writes for one lane at the submit card, the helper it calls, and where
 * it reads the ledger again.
 *
 * The step is decided by the MoonBit fold (`packages/idd-fold/submit_step.mbt`), from the lane's rows and the
 * observations the caller gathered (C-202-1). The caller runs the steps in the order they come; it never decides
 * which one is next (C-202-2). A fold that cannot be read is a failure the caller sees, never a second reading in
 * TypeScript.
 *
 * A step that is not one of the five is not a step: the closed type on the other side of the boundary is what the
 * answer can be.
 */

/** one step of the push stage, as the fold answers it */
export interface SubmitStep {
  do: "write" | "call" | "result" | "again" | "end";
  /** the record to write, and its attrs */
  event?: string;
  attrs?: Record<string, unknown>;
  /** the helper to call, the site it is called from, and the fact its answer is kept under */
  helper?: string;
  site?: string;
  fact?: string;
  keep?: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** a call whose failure ends this lane's steps: it is thrown out of the driver, and the caller records it for that lane alone (C-202-1) */
  fatal?: boolean;
  /** the ledger is read again after this call: the record it wrote is what the rest of the answer reads */
  reread?: boolean;
  /** the result list, the lane, and the failure's text */
  field?: "ready" | "recorded" | "held" | "merged" | "errors";
  id?: string;
  error?: string;
}

/** the fold's answer: the steps, or the observations it still wants */
export interface SubmitAnswer {
  steps?: SubmitStep[];
  needs?: FactNeed[];
}

/** where the observations the fold asks for come from: the caller's readings, never a decision */
export type SubmitObserver = (need: FactNeed, memory: Record<string, unknown>) => unknown;

/** what the caller does with a step */
export interface SubmitRun {
  /** write the record the step names */
  write(event: string, attrs: Record<string, unknown>): Promise<void>;
  /** call the helper the step names, and answer what it answered */
  call(step: SubmitStep): Promise<unknown>;
  /** put the lane into one of the stage's result lists */
  result(field: NonNullable<SubmitStep["field"]>, id: string, error?: string): void;
  /** the lane's rows, as the ledger has them now */
  reload(): LifecycleRecord[];
  /** whether a failure is the repo's lock refusing: a wait, not an error (DEC-2328) */
  lockRefused(err: unknown): boolean;
}

/**
 * The facts one lane's push stage is asked about, read and re-asked until the fold has every observation it needs.
 * A fact the caller cannot read is answered as null: the fold reads it as one more missing value, never as a
 * decision somebody else took.
 */
const ASK_ROUNDS = 24;

async function askSubmit(
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: SubmitObserver,
  memory: Record<string, unknown>,
): Promise<SubmitAnswer> {
  for (let round = 0; round < ASK_ROUNDS; round += 1) {
    const answer = laneAnswer<SubmitAnswer>("submit_step", events, { facts });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (need.id in facts) continue;
      facts[need.id] = observer(need, memory) ?? null;
    }
  }
  throw new Error("MoonBit の畳み（submit_step）が答えを返しませんでした");
}

/** how many steps one lane is run for: a stage that wrote nothing new must not loop */
const STEP_ROUNDS = 24;

/**
 * Run one lane's push stage: ask the fold for the next steps, run them in order, and ask again where the answer
 * says the ledger is read anew. A helper's answer is handed back under the fact the step named, so the fold reads
 * what the helper answered (C-202-3).
 */
export async function driveSubmitSteps(
  events: LifecycleRecord[],
  facts: Record<string, unknown>,
  observer: SubmitObserver,
  run: SubmitRun,
): Promise<void> {
  let rows = events;
  const memory: Record<string, unknown> = {};
  for (let round = 0; round < STEP_ROUNDS; round += 1) {
    const answer = await askSubmit(rows, { ...facts, ...memory }, observer, memory);
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
        run.result(step.field ?? "errors", String(step.id), step.error);
        continue;
      }
      if (step.do === "end") return;
      if (step.do === "again") {
        again = true;
        reload = true;
        continue;
      }
      // a call: the fold reads its answer, and the stage asks again at once (the rows are re-read where the answer
      // says so, never by the caller's own judgement)
      try {
        const result = await run.call(step);
        memory[String(step.fact)] = { result, keep: step.keep ?? {} };
      } catch (err) {
        if (step.fatal) throw err;
        memory[`err|${step.helper}|${step.site}`] = {
          error: String((err as Error).message ?? err),
          lockRefused: run.lockRefused(err),
        };
      }
      // the fold reads the answer next; only a step that says so reads the ledger anew first
      if (step.do === "call") {
        again = true;
        if (step.reread) reload = true;
      }
    }
    if (!again) return;
    if (reload) rows = run.reload();
  }
  throw new Error("提出の一歩が終わりませんでした");
}
