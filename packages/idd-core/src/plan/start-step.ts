import { laneAnswer } from "../intent/moonbit-fold.ts";
import { readLifecycle } from "../ledger/read.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The startup stages' next step: whether a lane's planner, executor or plan review starts, waits or is left, and the
 * records and helpers that go with it.
 *
 * The decision is the MoonBit fold's (`packages/idd-fold/start_steps.mbt`), from the ledger's rows and the facts the
 * caller read. The caller keeps the readings of the outside world (the runner, the worktree, git, the intent column)
 * and the effects themselves: the spawn, the brief, the writes. What it does not do is decide which lane starts, which
 * waits for a slot, and why a lane is skipped.
 *
 * A fold that cannot be read is a failure the caller sees, never a second reading in TypeScript.
 */

/** one step of a startup stage, as the fold answers it */
export interface StartStep {
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
  /** a call whose failure the caller reports rather than keeps (the step around it throws as it did) */
  fatal?: boolean;
  /** the step's action: what the stage does with the lane, and why */
  action?: string;
  reason?: string;
  error?: string;
  /** the stage is waiting (room, the cap, a replacement), not failing: it says so, the reason's words are not read */
  wait?: boolean;
}

/** the fold's answer: the steps to run in order, or the observations it still wants */
export interface StartAnswer {
  steps?: StartStep[];
  needs?: { id: string; kind: string }[];
}

/** what the caller does with a step */
export interface StartRun {
  /** write the record the step names; the row it wrote is handed to the fold next */
  write(event: string, attrs: Record<string, unknown>): Promise<void>;
  /** call the helper the step names; its answer comes back under the step's `fact` */
  call(step: StartStep): Promise<unknown>;
}

/** the action a stage's steps ended at, as the caller reports it */
export interface StartOutcome {
  action: string;
  reason?: string;
  error?: string;
  wait?: boolean;
}

/** the lane a stage left, as the tick reports it: the stage's own reason, and its own answer that it waits */
export function skippedOf(iddId: string, outcome: StartOutcome): { iddId: string; reason: string; wait?: boolean } {
  return { iddId, reason: outcome.reason ?? "", ...(outcome.wait ? { wait: true } : {}) };
}

/** how many times one answer may be asked for before the fold's needs stop moving */
const ASK_ROUNDS = 24;

/**
 * How many sessions still hold a slot of the stage, as the fold counts them: a lane's session holds its slot until the
 * lane's own rows end it (C-205-2). The screens and the start read the same count, so neither can wait on a lane the
 * other would start.
 */
export function startRunning(stage: "planner" | "executor", sessions: { idd_id: string; kind?: string }[]): number {
  const answer = laneAnswer<{ running: number }>("start_counts", readLifecycle(), { facts: { stage, sessions } });
  return answer.running;
}
/** how many step lists one lane is run for */
const STEP_ROUNDS = 24;

/**
 * Ask the fold until it has every observation it needs. The startup stages read their readings before they ask, so a
 * need is only the ones a later stage grows; it is answered as null when the caller cannot read it.
 */
function askStart(
  op: string,
  rows: LifecycleRecord[],
  facts: Record<string, unknown>,
  memory: Record<string, unknown>,
): StartAnswer {
  for (let round = 0; round < ASK_ROUNDS; round += 1) {
    const answer = laneAnswer<StartAnswer>(op, rows, { facts: { ...facts, ...memory } });
    const needs = answer.needs ?? [];
    if (!needs.length) return answer;
    for (const need of needs) {
      if (need.id in facts || need.id in memory) continue;
      memory[need.id] = null;
    }
  }
  throw new Error(`MoonBit の畳み（${op}）が答えを返しませんでした`);
}

/**
 * Run one lane's startup stage: ask the fold for the steps, run them in order, and answer the action they ended at.
 * A helper's answer is kept under the fact the step named, so the rest of the answer reads what it answered; a write
 * joins the rows at once, so the next answer reads the ledger as it is now.
 */
export async function driveStartSteps(
  op: string,
  rows: LifecycleRecord[],
  facts: Record<string, unknown>,
  run: StartRun,
): Promise<StartOutcome> {
  const read = [...rows];
  const memory: Record<string, unknown> = {};
  for (let round = 0; round < STEP_ROUNDS; round += 1) {
    const answer = askStart(op, read, facts, memory);
    const steps = answer.steps ?? [];
    if (!steps.length) return { action: "none" };
    for (const step of steps) {
      if (step.do === "write") {
        const event = String(step.event);
        const attrs = step.attrs ?? {};
        await run.write(event, attrs);
        read.push({ idd_id: String(facts.lane ?? ""), event, attrs, at: new Date().toISOString() } as unknown as LifecycleRecord);
        continue;
      }
      if (step.do === "action") {
        return {
          action: String(step.action ?? "none"),
          ...(step.reason ? { reason: step.reason } : {}),
          ...(step.error ? { error: step.error } : {}),
          ...(step.wait ? { wait: true } : {}),
        };
      }
      const fact = String(step.fact);
      try {
        const result = await run.call(step);
        memory[fact] = { result, keep: step.keep ?? {} };
      } catch (err) {
        if (step.fatal) throw err;
        memory[fact] = { result: { error: String((err as Error).message ?? err) }, keep: step.keep ?? {} };
      }
    }
  }
  throw new Error("起動の一歩が終わりませんでした");
}
