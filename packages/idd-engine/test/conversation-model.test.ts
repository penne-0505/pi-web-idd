/**
 * The matching test: the reference model runs the abstract model's scenarios, and a large number of random
 * sequences is fed through the implementation's transition function and the reference model at the same time.
 * A mismatch fails with the seed and the shrunk reproduction.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CONVERSATION_PHASES, emptyConversationMachine, reduceConversation,
  type ConversationDirective, type ConversationMachine,
} from "../src/server/conversations.ts";
import { APPROVED_DIFFERENCES, mapImplementation } from "./conversation-model/mapping.ts";
import { emptyRefMachine, reduceRef, type RefEvent, type RefMachine } from "./conversation-model/reference.ts";
import { ENFORCED_DIFFERENCES, type Session } from "./conversation-model/harness.ts";
import { MismatchError, formatSteps, generateRun, replay, stepKind } from "./conversation-model/sequence.ts";

const RUNS = Number(process.env.IDD_CONVERSATION_MODEL_RUNS) || 2000;
const BASE_SEED = Number(process.env.IDD_CONVERSATION_MODEL_SEED) || 20261005;
const LENGTH = 40;
const ACTIVE = new Set(ENFORCED_DIFFERENCES);

const here = (name: string): string => fileURLToPath(new URL(`./conversation-model/${name}`, import.meta.url));

// ---- AC-001: the reference model against the abstract model ----

/** pi answers every prompt with `started` at once, the premise the abstract model was written under */
function settle(m: RefMachine): RefMachine {
  for (let i = 0; i < 20; i += 1) {
    if (m.switch) { m = reduceRef(m, { type: "modelSettled", generation: m.generation, step: m.switch.awaiting, ok: true }); continue; }
    if (m.phase === "Running" && m.inFlight) { m = reduceRef(m, { type: "promptSettled", generation: m.generation, itemId: m.inFlight.id, disposition: "started" }); continue; }
    break;
  }
  return m;
}

function drive(events: RefEvent[]): RefMachine {
  let m = emptyRefMachine();
  for (const event of events) {
    m = reduceRef(m, event);
    m = settle(m);
  }
  return m;
}

const gen1 = 1;

describe("the reference model", () => {
  test("AC-001: the abstract model's scenarios pass with six states", () => {
    const texts = (m: RefMachine): string[] => m.passed.map((p) => p.text);

    const queue = drive([
      { type: "open" }, { type: "spawned", generation: gen1 },
      { type: "send", text: "a" }, { type: "send", text: "b", model: "m2" },
      { type: "runEnded", generation: gen1, stopReason: "stop" }, { type: "runEnded", generation: gen1, stopReason: "stop" },
    ]);
    expect(texts(queue)).toEqual(["a", "b"]);
    expect(queue.passed[1].model).toBe("m2");
    expect(queue.phase).toBe("Idle");
    expect(queue.queue).toEqual([]);

    const stopped = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" }, { type: "send", text: "b" },
      { type: "stop" }, { type: "runEnded", generation: gen1, stopReason: "error" },
    ]);
    expect(stopped.outcomes).toEqual(["stopped"]);
    expect(stopped.queue.map((i) => i.text)).toEqual(["b"]);
    expect(stopped.phase).toBe("Idle");
    const resumed = reduceRef(stopped, { type: "send", text: "c" });
    expect(texts(resumed)).toEqual(["a", "b"]);

    const failed = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" }, { type: "send", text: "b" },
      { type: "runEnded", generation: gen1, stopReason: "error" },
    ]);
    expect(failed.outcomes).toEqual(["failed"]);
    expect(failed.queue.map((i) => i.text)).toEqual(["b"]);

    const steered = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" }, { type: "send", text: "b" },
      { type: "steer", text: "wait!" },
    ]);
    expect(steered.queue.map((i) => i.text)).toEqual(["b"]);

    const edited = reduceRef(drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" }, { type: "send", text: "b" },
    ]), { type: "edit", id: "q2", patch: { text: "B" } });
    expect(edited.queue.map((i) => i.text)).toEqual(["B"]);
    expect(edited.passed.map((i) => i.text)).toEqual(["a"]);

    const closing = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" },
      { type: "close" }, { type: "open" }, { type: "open" },
    ]);
    expect(closing.phase).toBe("Closing");
    expect(reduceRef(closing, { type: "exited", generation: gen1 }).phase).toBe("Opening");

    const race = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" },
      { type: "stop" }, { type: "runEnded", generation: gen1, stopReason: "stop" },
    ]);
    expect(race.outcomes).toEqual(["stopped"]);

    const crash = drive([
      { type: "open" }, { type: "spawned", generation: gen1 }, { type: "send", text: "a" }, { type: "exited", generation: gen1 },
    ]);
    expect(crash.phase).toBe("Closed");
    expect(crash.outcomes).toEqual(["failed"]);

    expect(CONVERSATION_PHASES).toHaveLength(8);
    expect(readFileSync(here("reference.ts"), "utf8")).not.toContain("conversations");
  });

  test("AC-002: the projection is one function with the table's rows", () => {
    const base: ConversationMachine = { ...emptyConversationMachine(), generation: 1 };
    const item = { id: "q1", text: "one", model: "m" };
    const tail = { id: "q2", text: "two" };
    const rows: { machine: ConversationMachine; phase: string; queue: string[] }[] = [
      { machine: { ...base, state: { phase: "closed" }, queue: [tail] }, phase: "Closed", queue: ["two"] },
      { machine: { ...base, state: { phase: "opening", asked: false, waiters: [] }, queue: [tail] }, phase: "Opening", queue: ["two"] },
      { machine: { ...base, state: { phase: "idle", switching: null }, queue: [tail] }, phase: "Idle", queue: ["two"] },
      { machine: { ...base, state: { phase: "delivering", instruction: { type: "idea", kind: "full" }, waiters: [] }, queue: [tail] }, phase: "Idle", queue: ["two"] },
      { machine: { ...base, state: { phase: "sending", item, held: [], awaiting: "model", deferredBefore: {}, pendingRunEnd: null }, queue: [tail] }, phase: "Idle", queue: ["one", "two"] },
      { machine: { ...base, state: { phase: "sending", item, held: [], awaiting: "prompt", deferredBefore: {}, pendingRunEnd: null }, queue: [tail] }, phase: "Running", queue: ["two"] },
      { machine: { ...base, state: { phase: "running", switching: null }, queue: [tail] }, phase: "Running", queue: ["two"] },
      { machine: { ...base, state: { phase: "stopping", item, held: [], awaiting: "model", abortSent: false, deferredBefore: {}, pendingRunEnd: null }, queue: [tail] }, phase: "Idle", queue: ["one", "two"] },
      { machine: { ...base, state: { phase: "stopping", item, held: [], awaiting: "prompt", abortSent: false, deferredBefore: {}, pendingRunEnd: null }, queue: [tail] }, phase: "Stopping", queue: ["two"] },
      { machine: { ...base, state: { phase: "closing", graceMs: 1, forced: false, pendingOpen: false, openWaiters: [], closeWaiters: [] }, queue: [tail] }, phase: "Closing", queue: ["two"] },
    ];
    for (const row of rows) {
      const mapped = mapImplementation(row.machine);
      expect(mapped.phase).toBe(row.phase);
      expect(mapped.queue.map((i) => i.text)).toEqual(row.queue);
    }
    const broken = { ...base, state: { phase: "nope" } } as unknown as ConversationMachine;
    expect(() => mapImplementation(broken)).toThrow();
  });

  test("AC-003: the approved differences are named with their DEC", () => {
    expect(APPROVED_DIFFERENCES.map((d) => d.name)).toEqual([
      "切替を待つ項目の編集と取り消し",
      "切替の応答待ちの Idle の割り込み",
    ]);
    for (const difference of APPROVED_DIFFERENCES) {
      expect(difference.reference).toMatch(/^IDD-062 の DEC-\d+$/);
      expect(difference.description.length).toBeGreaterThan(0);
    }
  });

  test("AC-003: removing one difference from the guards makes the matching fail", () => {
    const withoutFirst = new Set(ENFORCED_DIFFERENCES.filter((name) => name !== APPROVED_DIFFERENCES[0].name));
    let failed = 0;
    for (let i = 0; i < 200 && failed === 0; i += 1) {
      try {
        generateRun(BASE_SEED + i, LENGTH, withoutFirst);
      } catch (err) {
        if (err instanceof MismatchError) failed += 1;
        else throw err;
      }
    }
    expect(failed).toBeGreaterThan(0);
  });
});

describe("determinism and coverage", () => {
  test("AC-004: the same seed gives the same sequence and the same verdict", () => {
    const a = generateRun(4242, LENGTH, ACTIVE);
    const b = generateRun(4242, LENGTH, ACTIVE);
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    expect(a.steps.length).toBeGreaterThan(0);
    expect(replay(a.steps, 4242, ACTIVE).ok).toBe(true);
    for (const name of ["harness.ts", "sequence.ts", "reference.ts", "mapping.ts"]) {
      const source = readFileSync(here(name), "utf8");
      expect(source.includes("Math.random"), name).toBe(false);
      expect(source.includes("Date.now"), name).toBe(false);
    }
  });

  test("AC-005: the default runs cover every operation and pi report", () => {
    const kinds = new Set<string>();
    let runEndBeforeAnswer = false;
    for (let i = 0; i < RUNS; i += 1) {
      const { steps, session } = generateRun(BASE_SEED + i, LENGTH, ACTIVE);
      for (const step of steps) kinds.add(stepKind(step));
      runEndBeforeAnswer = runEndBeforeAnswer || session.sawRunEndBeforeAnswer;
    }
    const required = [
      "send", "steer", "stop", "edit", "cancel", "open", "close", "model", "effort", "promote",
      "spawned", "spawnFailed",
      "prompt-started", "prompt-handled", "prompt-failed",
      "settle-model-ok", "settle-model-no", "settle-effort-ok", "settle-effort-no",
      "runStarted",
      "runEnded-stop", "runEnded-length", "runEnded-aborted", "runEnded-error",
      "exited",
    ];
    for (const kind of required) expect([...kinds], kind).toContain(kind);
    expect(runEndBeforeAnswer).toBe(true);
    expect([...kinds].filter((k) => k.includes("type"))).toEqual([]);
  });

  test("AC-008: the default runs finish inside ten seconds", () => {
    const started = performance.now();
    for (let i = 0; i < RUNS; i += 1) generateRun(BASE_SEED + i, LENGTH, ACTIVE);
    const elapsed = performance.now() - started;
    expect(process.env.IDD_CONVERSATION_MODEL_RUNS !== undefined || RUNS >= 2000).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
    const fewer = generateRun(1, 5, ACTIVE);
    const other = generateRun(2, 5, ACTIVE);
    expect(JSON.stringify(fewer.steps)).not.toBe(JSON.stringify(other.steps));
  });
});

describe("the matching", () => {
  test("AC-015: the fixed transition function matches over the default runs", () => {
    for (let i = 0; i < RUNS; i += 1) generateRun(BASE_SEED + i, LENGTH, ACTIVE);
  });

  test("AC-006: a fake implementation with one broken value fails", () => {
    const broken: { name: string; reduce: Session["reduce"] }[] = [
      { name: "passes an item twice", reduce: doublePrompt },
      { name: "drops an item's model", reduce: dropModel },
      { name: "swaps the queue", reduce: swapQueue },
      { name: "always ends as completed", reduce: completeAlways },
      { name: "drops a queue event", reduce: dropQueueEvent },
      { name: "never answers a held interrupt", reduce: dropHeld },
    ];
    for (const fake of broken) {
      let threw = false;
      for (let i = 0; i < 400 && !threw; i += 1) {
        try {
          generateRun(BASE_SEED + i, LENGTH, ACTIVE, fake.reduce);
        } catch (err) {
          if (err instanceof MismatchError) threw = true;
          else throw err;
        }
      }
      expect(threw, fake.name).toBe(true);
    }
  });

  test("AC-007: a failure carries the seed and a minimal reproduction", () => {
    let err: MismatchError | null = null;
    for (let i = 0; i < 400 && !err; i += 1) {
      try { generateRun(BASE_SEED + i, LENGTH, ACTIVE, doublePrompt); }
      catch (e) { if (e instanceof MismatchError) err = e; else throw e; }
    }
    expect(err).not.toBeNull();
    const failure = err as MismatchError;
    expect(failure.message).toContain("seed:");
    expect(failure.message).toContain("縮めた列");
    expect(failure.shrunk.length).toBeLessThanOrEqual(failure.steps.length);
    expect(replay(failure.shrunk, failure.seed, ACTIVE, doublePrompt).ok).toBe(false);
    for (let i = 0; i < failure.shrunk.length; i += 1) {
      const less = failure.shrunk.slice(0, i).concat(failure.shrunk.slice(i + 1));
      expect(replay(less, failure.seed, ACTIVE, doublePrompt).ok, `step ${i}`).toBe(true);
    }
    expect(formatSteps(failure.shrunk)).toContain("//");
  });
});

// ---- the six fake implementations, each breaking exactly one value ----

function wrap(transform: (out: { machine: ConversationMachine; directives: ConversationDirective[] }) => void): Session["reduce"] {
  return (machine, event) => {
    const out = reduceConversation(machine, event);
    const copy = { machine: out.machine, directives: [...out.directives] };
    transform(copy);
    return copy;
  };
}

const doublePrompt = wrap((out) => {
  for (const extra of out.directives.filter((d) => d.kind === "prompt")) out.directives.push({ ...extra });
});

const dropModel = wrap((out) => {
  out.directives = out.directives.map((d) => (d.kind === "prompt" ? { kind: "prompt", generation: d.generation, item: { id: d.item.id, text: d.item.text } } : d));
});

const swapQueue = wrap((out) => {
  const queue = out.machine.queue;
  if (queue.length >= 2) out.machine = { ...out.machine, queue: [queue[1], queue[0], ...queue.slice(2)] };
});

const completeAlways = wrap((out) => {
  out.directives = out.directives.map((d) => (d.kind === "emit" && d.eventType === "end" ? { kind: "emit", eventType: "end", fields: { ...d.fields, reason: "completed" } } : d));
});

const dropQueueEvent = wrap((out) => {
  out.directives = out.directives.filter((d) => !(d.kind === "emit" && d.eventType === "queue"));
});

const dropHeld = wrap((out) => {
  const state = out.machine.state;
  if (state.phase === "sending" || state.phase === "stopping") out.machine = { ...out.machine, state: { ...state, held: [] } };
});

