/**
 * The random sequence: user operations and the stand-in's undelivered reports, in an order decided only by
 * the seed. A mismatch is shrunk to a small reproduction that can be pasted into a test.
 */
import { applyStep, finalCheck, makeRng, newSession, type Mismatch, type Rng, type Session, type Step } from "./harness.ts";

export class MismatchError extends Error {
  readonly seed: number;
  readonly steps: Step[];
  readonly mismatch: Mismatch;
  readonly stepIndex: number;
  readonly shrunk: Step[];

  constructor(seed: number, steps: Step[], mismatch: Mismatch, stepIndex: number, shrunk: Step[]) {
    super(formatFailure(seed, shrunk, mismatch, stepIndex));
    this.name = "MismatchError";
    this.seed = seed;
    this.steps = steps;
    this.mismatch = mismatch;
    this.stepIndex = stepIndex;
    this.shrunk = shrunk;
  }
}

const TEXTS = ["a", "b", "c", "d", "e", "f"] as const;
const MODELS = ["openrouter/z-ai/glm-5.4", "openrouter/z-ai/glm-5.5"] as const;
const EFFORTS = ["low", "high"] as const;

function describe(step: Step): string {
  switch (step.t) {
    case "send": return `send(${step.text}${step.model ? `,${step.model}` : ""}${step.effort ? `,${step.effort}` : ""})`;
    case "steer": return `steer(${step.text})`;
    case "model": return `model(${step.model ?? "-"},${step.effort ?? "-"})`;
    case "edit": return `edit(${step.id}=${step.text})`;
    case "cancel": return `cancel(${step.id})`;
    case "promptSettled": return `promptSettled(${step.itemId},${step.disposition})`;
    case "modelSettled": return `modelSettled(${step.step},${step.ok})`;
    case "runEnded": return `runEnded(${step.stopReason})`;
    default: return step.t;
  }
}

export function formatSteps(steps: Step[]): string {
  return `[\n${steps.map((s) => `  ${JSON.stringify(s)},  // ${describe(s)}`).join("\n")}\n]`;
}

function formatFailure(seed: number, steps: Step[], mismatch: Mismatch, stepIndex: number): string {
  return [
    `会話の突き合わせが食い違いました`,
    `seed: ${seed}`,
    `最初に食い違った手: ${stepIndex} (${stepIndex >= 0 && stepIndex < steps.length ? describe(steps[stepIndex]) : "drain"})`,
    `食い違った値: ${mismatch.field} — ${mismatch.detail}`,
    `縮めた列: ${formatSteps(steps)}`,
  ].join("\n");
}

export interface GenerateResult {
  steps: Step[];
  session: Session;
}

/** build one run: pick operations and reports, apply them, and stop at the first mismatch */
export function generateRun(seed: number, length: number, activeDifferences: ReadonlySet<string>, reduce?: Session["reduce"]): GenerateResult {
  const rng = makeRng(seed);
  const session = newSession(reduce);
  const steps: Step[] = [];
  let guard = 0;
  while (steps.length < length && guard < length * 4) {
    guard += 1;
    const chosen = chooseStep(session, rng);
    if (!chosen) break;
    const result = applyStep(session, chosen.step, rng, activeDifferences);
    if (!result.applied) continue;
    if (chosen.pendingAt !== null) session.standin.pending.splice(chosen.pendingAt, 1);
    steps.push(chosen.step);
    if (result.mismatch) throw fail(seed, steps, result.mismatch, activeDifferences, reduce);
  }
  // deliver whatever is still owed so every accepted request is answered before the final comparison
  let drainGuard = 0;
  while ((session.standin.pending.length || session.tracker.unsettled) && drainGuard < 200) {
    drainGuard += 1;
    const at = session.standin.pending.length ? 0 : -1;
    if (at < 0) break;
    const step = session.standin.pending[at];
    session.standin.pending.splice(at, 1);
    const result = applyStep(session, step, rng, activeDifferences);
    if (!result.applied) continue;
    steps.push(step);
    if (result.mismatch) throw fail(seed, steps, result.mismatch, activeDifferences, reduce);
  }
  const final = finalCheck(session);
  if (final) throw fail(seed, steps, final, activeDifferences, reduce);
  return { steps, session };
}

function fail(seed: number, steps: Step[], mismatch: Mismatch, activeDifferences: ReadonlySet<string>, reduce?: Session["reduce"]): MismatchError {
  const shrunk = shrink(steps, seed, activeDifferences, mismatch.field, reduce);
  const reproduces = replay(shrunk, seed, activeDifferences, reduce);
  const actual = reproduces.ok ? mismatch : reproduces.mismatch;
  return new MismatchError(seed, steps, actual, steps.length - 1, shrunk);
}

interface Chosen {
  step: Step;
  pendingAt: number | null;
}

function chooseStep(session: Session, rng: Rng): Chosen | null {
  const pending = session.standin.pending;
  const preferReport = pending.length > 0 && rng.chance(0.55);
  if (preferReport) {
    const at = rng.int(pending.length);
    return { step: pending[at], pendingAt: at };
  }
  const candidates = userCandidates(session, rng);
  if (!candidates.length) {
    if (!pending.length) return null;
    const at = rng.int(pending.length);
    return { step: pending[at], pendingAt: at };
  }
  return { step: rng.pick(candidates), pendingAt: null };
}

function text(rng: Rng, seq: number): string {
  return `${rng.pick(TEXTS)}${seq}`;
}

function userCandidates(session: Session, rng: Rng): Step[] {
  const out: Step[] = [];
  const state = session.impl.state;
  out.push({ t: "send", text: text(rng, rng.int(1000)), ...(rng.chance(0.4) ? { model: rng.pick(MODELS) } : {}), ...(rng.chance(0.2) ? { effort: rng.pick(EFFORTS) } : {}) });
  out.push({ t: "steer", text: text(rng, rng.int(1000)) });
  out.push({ t: "stop" });
  out.push({ t: "model", model: rng.chance(0.5) ? rng.pick(MODELS) : null, effort: rng.chance(0.5) ? rng.pick(EFFORTS) : null });
  out.push({ t: "open" });
  out.push({ t: "close" });
  out.push({ t: "promote" });
  const items = [...session.impl.queue.map((i) => i.id)];
  if (state.phase === "sending" || state.phase === "stopping") {
    if (state.item) items.push(state.item.id);
  }
  if (items.length) {
    const id = rng.pick(items);
    out.push({ t: "edit", id, text: text(rng, rng.int(1000)) });
    out.push({ t: "cancel", id });
  }
  return out;
}

/** remove steps while the same mismatch still reproduces; the result is one step from minimal */
export function shrink(steps: Step[], seed: number, activeDifferences: ReadonlySet<string>, field: Mismatch["field"], reduce?: Session["reduce"]): Step[] {
  let current = steps.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1));
      const result = replay(candidate, seed, activeDifferences, reduce);
      if (!result.ok && result.mismatch.field === field) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

export type ReplayResult = { ok: true } | { ok: false; mismatch: Mismatch; stepIndex: number };

/** replay a concrete sequence; the reports carry their own contents, no generator decides anything */
export function replay(steps: Step[], seed: number, activeDifferences: ReadonlySet<string>, reduce?: Session["reduce"]): ReplayResult {
  const rng = makeRng(seed);
  const session = newSession(reduce);
  for (let i = 0; i < steps.length; i += 1) {
    const result = applyStep(session, steps[i], rng, activeDifferences);
    if (!result.applied) continue;
    if (result.mismatch) return { ok: false, mismatch: result.mismatch, stepIndex: i };
  }
  const final = finalCheck(session);
  if (final) return { ok: false, mismatch: final, stepIndex: steps.length };
  return { ok: true };
}

/** the step kinds a run used, for the coverage check */
export function stepKind(step: Step): string {
  switch (step.t) {
    case "send": return step.model ? "send-model" : step.effort ? "send-effort" : "send";
    case "steer": return "steer";
    case "model": return step.model && step.effort ? "model+effort" : step.model ? "model" : step.effort ? "effort" : "model-none";
    case "edit": return "edit";
    case "cancel": return "cancel";
    case "promptSettled": return `prompt-${step.disposition}`;
    case "modelSettled": return `settle-${step.step}-${step.ok ? "ok" : "no"}`;
    case "runEnded": return `runEnded-${step.stopReason}`;
    default: return step.t;
  }
}
