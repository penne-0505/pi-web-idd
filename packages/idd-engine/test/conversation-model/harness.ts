/**
 * The matching harness: it feeds the same events through the implementation's transition function and the
 * reference model and compares what pi received, the queue, the outcomes and the state after every step.
 * The stand-in for pi lives in the same process: it records the prompts the implementation handed over and
 * keeps the reports it has not delivered yet, so a report can arrive at any order pi could produce.
 */
import {
  droppedQueue, reduceConversation,
  type ConversationDirective, type ConversationMachine, type ConversationMailEvent, type QueueItem,
} from "../../src/server/conversations.ts";
import { mapImplementation } from "./mapping.ts";
import {
  emptyRefMachine, reduceRef, refDroppedQueue, refVisibleQueue,
  type RefEvent, type RefItem, type RefMachine,
} from "./reference.ts";

export type Disposition = "started" | "handled" | "queued" | "failed";

export type Step =
  | { t: "open" }
  | { t: "close" }
  | { t: "send"; text: string; model?: string; effort?: string }
  | { t: "steer"; text: string }
  | { t: "stop" }
  | { t: "model"; model: string | null; effort: string | null }
  | { t: "edit"; id: string; text: string }
  | { t: "cancel"; id: string }
  | { t: "promote" }
  | { t: "spawned"; g: number }
  | { t: "spawnFailed"; g: number }
  | { t: "promptSettled"; g: number; itemId: string; disposition: Disposition }
  | { t: "modelSettled"; g: number; step: "model" | "effort"; ok: boolean }
  | { t: "runStarted"; g: number }
  | { t: "runEnded"; g: number; stopReason: string | null }
  | { t: "exited"; g: number };

export interface Rng {
  (): number;
  int(maxExclusive: number): number;
  pick<T>(values: readonly T[]): T;
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  rng.pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  rng.chance = (p: number) => next() < p;
  return rng;
}

/** marks a request as answered when the implementation resolves or rejects its reply */
export class ReplyTracker {
  private open = 0;
  wrap<T extends { resolve: (...args: never[]) => void; reject: (err: unknown) => void }>(reply: T): T {
    this.open += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.open -= 1; } };
    return { ...reply, resolve: (...args: never[]) => { settle(); reply.resolve(...args); }, reject: (err: unknown) => { settle(); reply.reject(err); } };
  }
  get unsettled(): number {
    return this.open;
  }
}

export interface Standin {
  /** every prompt the implementation handed to pi, in order */
  passed: QueueItem[];
  /** reports the stand-in has not delivered yet */
  pending: Step[];
  generation: number;
}

export interface Session {
  impl: ConversationMachine;
  ref: RefMachine;
  standin: Standin;
  /** the last `queue` event the implementation emitted, as the person sees it */
  lastQueue: QueueItem[];
  /** the `end` reasons the implementation reported */
  outcomes: string[];
  tracker: ReplyTracker;
  /** the transition function, so a test can wrap it with one broken value */
  reduce: (machine: ConversationMachine, event: ConversationMailEvent) => { machine: ConversationMachine; directives: ConversationDirective[] };
  /** set when a run's end was delivered before the prompt's answer, for the coverage check */
  sawRunEndBeforeAnswer: boolean;
}

export function newSession(reduce: Session["reduce"] = reduceConversation): Session {
  return {
    impl: { state: { phase: "closed" }, deferred: {}, queue: [], itemSeq: 0, generation: 0, wantType: null, history: null, instruction: null, paused: false },
    ref: emptyRefMachine(),
    standin: { passed: [], pending: [], generation: 0 },
    lastQueue: [],
    outcomes: [],
    tracker: new ReplyTracker(),
    reduce,
    sawRunEndBeforeAnswer: false,
  };
}

const noop = (): void => {};

function implEvent(step: Step, session: Session): ConversationMailEvent | null {
  switch (step.t) {
    case "open":
      return { type: "open", reply: session.tracker.wrap({ resolve: noop, reject: noop }) };
    case "close":
      return { type: "close", graceMs: 100, reply: session.tracker.wrap({ resolve: noop }) };
    case "send":
      return { type: "send", text: step.text, ...(step.model ? { model: step.model } : {}), ...(step.effort ? { effort: step.effort } : {}), result: {} };
    case "steer":
      return { type: "steer", text: step.text, reply: session.tracker.wrap({ resolve: noop, reject: noop }) };
    case "stop":
      return { type: "stop", reply: session.tracker.wrap({ resolve: noop, reject: noop }) };
    case "model":
      return { type: "model", model: step.model, effort: step.effort, reply: session.tracker.wrap({ resolve: noop, reject: noop }) };
    case "edit":
      return { type: "edit", id: step.id, patch: { text: step.text }, result: {} };
    case "cancel":
      return { type: "cancel", id: step.id, result: {} };
    case "spawned":
      return { type: "spawned", generation: step.g };
    case "spawnFailed":
      return { type: "spawnFailed", generation: step.g };
    case "promptSettled":
      return { type: "promptSettled", generation: step.g, itemId: step.itemId, disposition: step.disposition };
    case "modelSettled":
      return { type: "modelSettled", generation: step.g, step: step.step, ok: step.ok };
    case "runStarted":
      return { type: "runStarted", generation: step.g };
    case "runEnded":
      return { type: "runEnded", generation: step.g, stopReason: step.stopReason };
    case "exited":
      return { type: "exited", generation: step.g };
    case "promote":
      // the promotion reads what it would drop (handled in applyStep) and then closes
      return { type: "close", graceMs: 100, reply: session.tracker.wrap({ resolve: noop }) };
  }
}

function refEvent(step: Step): RefEvent | null {
  switch (step.t) {
    case "open": return { type: "open" };
    case "close": return { type: "close" };
    case "send": return { type: "send", text: step.text, ...(step.model ? { model: step.model } : {}), ...(step.effort ? { effort: step.effort } : {}) };
    case "steer": return { type: "steer", text: step.text };
    case "stop": return { type: "stop" };
    case "model": return { type: "model", model: step.model, effort: step.effort };
    case "edit": return { type: "edit", id: step.id, patch: { text: step.text } };
    case "cancel": return { type: "cancel", id: step.id };
    case "spawned": return { type: "spawned", generation: step.g };
    case "spawnFailed": return { type: "spawnFailed", generation: step.g };
    case "promptSettled": return { type: "promptSettled", generation: step.g, itemId: step.itemId, disposition: step.disposition };
    case "modelSettled": return { type: "modelSettled", generation: step.g, step: step.step, ok: step.ok };
    case "runStarted": return { type: "runStarted", generation: step.g };
    case "runEnded": return { type: "runEnded", generation: step.g, stopReason: step.stopReason };
    case "exited": return { type: "exited", generation: step.g };
    case "promote": return { type: "close" };
  }
}

/** the reports the stand-in would produce for the instructions the implementation just gave pi */

function itemsEqual(a: { id: string; text: string; model?: string; effort?: string }[], b: { id: string; text: string; model?: string; effort?: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.text !== y.text || (x.model ?? "") !== (y.model ?? "") || (x.effort ?? "") !== (y.effort ?? "")) return false;
  }
  return true;
}

function visibleEqual(a: QueueItem[], b: RefItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.text !== y.text || (x.model ?? "") !== (y.model ?? "") || (x.effort ?? "") !== (y.effort ?? "")) return false;
  }
  return true;
}

export interface Mismatch {
  field: "state" | "queue" | "passed" | "outcomes" | "visible-queue" | "dropped-queue" | "request";
  detail: string;
}

function compare(session: Session): Mismatch | null {
  const proj = mapImplementation(session.impl);
  if (proj.phase !== session.ref.phase) {
    return { field: "state", detail: `実装 ${proj.phase} / 参照 ${session.ref.phase}` };
  }
  if (!itemsEqual(proj.queue, session.ref.queue)) {
    return { field: "queue", detail: `実装 [${proj.queue.map((i) => i.text).join(",")}] / 参照 [${session.ref.queue.map((i) => i.text).join(",")}]` };
  }
  if (!itemsEqual(session.standin.passed, session.ref.passed)) {
    return { field: "passed", detail: `実装 [${session.standin.passed.map((i) => i.text).join(",")}] / 参照 [${session.ref.passed.map((i) => i.text).join(",")}]` };
  }
  if (session.outcomes.join(",") !== session.ref.outcomes.join(",")) {
    return { field: "outcomes", detail: `実装 [${session.outcomes.join(",")}] / 参照 [${session.ref.outcomes.join(",")}]` };
  }
  if (!visibleEqual(session.lastQueue, refVisibleQueue(session.ref))) {
    return { field: "visible-queue", detail: `event [${session.lastQueue.map((i) => i.text).join(",")}] / 参照 [${refVisibleQueue(session.ref).map((i) => i.text).join(",")}]` };
  }
  return null;
}

export function finalCheck(session: Session): Mismatch | null {
  if (session.tracker.unsettled > 0) return { field: "request", detail: `${session.tracker.unsettled} 件の要求が答えを受けていません` };
  return null;
}

// ---- applying one step ----

/**
 * The differences the generator keeps away from. Removing one makes the generator ask for the operation and
 * the matching fails, so each listed difference is load-bearing.
 */
export const ENFORCED_DIFFERENCES: readonly string[] = Object.freeze([
  "切替を待つ項目の編集と取り消し",
  "切替の応答待ちの Idle の割り込み",
]);

export function approvedDifferenceOf(step: Step, session: Session): string | null {
  const state = session.impl.state;
  if (step.t === "edit" || step.t === "cancel") {
    if (state.phase === "sending" && (state.awaiting === "model" || state.awaiting === "effort") && state.item.id === step.id) {
      return "切替を待つ項目の編集と取り消し";
    }
    if (state.phase === "stopping" && (state.awaiting === "model" || state.awaiting === "effort") && state.item?.id === step.id) {
      return "切替を待つ項目の編集と取り消し";
    }
    return null;
  }
  if (step.t === "steer") {
    // the implementation waits out an item whose switch is still owed, while the mapped Idle queues the
    // interrupt; the DEC-2283 table decided both
    if (state.phase === "sending" && (state.awaiting === "model" || state.awaiting === "effort")) return "切替の応答待ちの Idle の割り込み";
    if (state.phase === "stopping" && (state.awaiting === "model" || state.awaiting === "effort")) return "切替の応答待ちの Idle の割り込み";
    return null;
  }
  return null;
}

export interface ApplyResult {
  applied: boolean;
  mismatch?: Mismatch;
}

/** apply one step to both sides; a step the active differences keep away from is not applied */
export function applyStep(session: Session, step: Step, rng: Rng, activeDifferences: ReadonlySet<string> = new Set(ENFORCED_DIFFERENCES)): ApplyResult {
  const difference = approvedDifferenceOf(step, session);
  if (difference && activeDifferences.has(difference)) return { applied: false };

  // a report for a prompt that was never written is not one pi could produce at this point: a shrunk
  // sequence can leave one behind, and the implementation would process it while the reference would not
  if (step.t === "promptSettled") {
    const st = session.impl.state;
    if ((st.phase === "sending" || st.phase === "stopping") && (st.awaiting === "model" || st.awaiting === "effort")) return { applied: false };
  }

  // a promotion reads what it would drop, then closes, exactly as the door does
  if (step.t === "promote") {
    const implDropped = droppedQueue(session.impl);
    const refDropped = refDroppedQueue(session.ref);
    if (!itemsEqual(implDropped, refDropped)) {
      return { applied: true, mismatch: { field: "dropped-queue", detail: `実装 [${implDropped.map((i) => i.text).join(",")}] / 参照 [${refDropped.map((i) => i.text).join(",")}]` } };
    }
  }

  const event = implEvent(step, session);
  if (event) {
    if (step.t === "runEnded" && session.impl.state.phase === "sending" && session.impl.state.awaiting === "prompt") session.sawRunEndBeforeAnswer = true;
    const { machine, directives } = session.reduce(session.impl, event);
    session.impl = machine;
    for (const directive of directives) {
      if (directive.kind === "emit") {
        if (directive.eventType === "queue") session.lastQueue = (directive.fields.queue as QueueItem[]).map((item) => ({ ...item }));
        if (directive.eventType === "end" && typeof directive.fields.reason === "string") session.outcomes.push(directive.fields.reason);
        continue;
      }
      if (directive.kind === "prompt") {
        session.standin.passed.push({ ...directive.item });
        session.standin.pending.push(...promptReports(directive.item.id, directive.generation, rng));
        continue;
      }
      if (directive.kind === "spawn") {
        session.standin.generation = directive.generation;
        const failed = !rng.chance(0.85);
        session.standin.pending.push(failed ? { t: "spawnFailed", g: directive.generation } : { t: "spawned", g: directive.generation });
        // pi may start a run of its own (an extension did it) without a prompt from the queue
        if (!failed && rng.chance(0.4)) session.standin.pending.push({ t: "runStarted", g: directive.generation });
        continue;
      }
      if (directive.kind === "setModel" || directive.kind === "setEffort") {
        const reported: "model" | "effort" = directive.kind === "setModel" ? "model" : "effort";
        session.standin.pending.push({ t: "modelSettled", g: directive.generation, step: reported, ok: rng.chance(0.85) });
        continue;
      }
      if (directive.kind === "abort") {
        session.standin.pending.push({ t: "runEnded", g: directive.generation, stopReason: rng.pick(["aborted", "stop", "error", "length"] as const) });
        continue;
      }
      if (directive.kind === "kill") {
        session.standin.pending.push({ t: "exited", g: directive.generation });
        continue;
      }
      if (directive.kind === "steer") {
        directive.reply.resolve();
        continue;
      }
      // typePrompt and retire do not happen in the random sequences
    }
  }

  const refEv = refEvent(step);
  if (refEv) session.ref = reduceRef(session.ref, refEv);

  const mismatch = compare(session);
  if (mismatch) return { applied: true, mismatch };
  return { applied: true };
}

/** the prompt's answer and the run's end, in either order pi may write them */
function promptReports(itemId: string, generation: number, rng: Rng): Step[] {
  const disposition: Disposition = rng.chance(0.8) ? "started" : rng.chance(0.6) ? "handled" : "failed";
  const reports: Step[] = [{ t: "promptSettled", g: generation, itemId, disposition }];
  if (disposition === "started") {
    reports.push({ t: "runEnded", g: generation, stopReason: rng.pick(["stop", "length", "aborted", "error"] as const) });
    if (rng.chance(0.35)) reports.reverse(); // the run's end can land before the prompt's answer
  }
  return reports;
}
