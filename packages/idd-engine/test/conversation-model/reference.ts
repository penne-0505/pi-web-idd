/**
 * The reference model: the abstract state machine (`_meta/models/conversation-state-machine.py`) with the
 * handling IDD-062's transition table decided on top. It has the abstract model's six states and never reads
 * the implementation's transition function or its types. The events pi reports are received apart from the
 * moment an item is handed over, so a stop, an interrupt or an edit that lands inside that window gets the
 * right answer.
 */

/** the six states the abstract model agreed on */
export type RefPhase = "Closed" | "Opening" | "Idle" | "Running" | "Stopping" | "Closing";

export interface RefItem {
  id: string;
  text: string;
  model?: string;
  effort?: string;
}

/** the reduced item shape the reference compares against; images are not modelled */
export interface RefPatch {
  text?: string;
  model?: string | null;
  effort?: string | null;
}

export type RefEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "send"; text: string; model?: string; effort?: string }
  | { type: "steer"; text: string }
  | { type: "stop" }
  | { type: "model"; model: string | null; effort: string | null }
  | { type: "edit"; id: string; patch: RefPatch }
  | { type: "cancel"; id: string }
  | { type: "spawned"; generation: number }
  | { type: "spawnFailed"; generation: number }
  | { type: "promptSettled"; generation: number; itemId: string; disposition: "started" | "handled" | "queued" | "failed" }
  | { type: "modelSettled"; generation: number; step: "model" | "effort"; ok: boolean }
  | { type: "runStarted"; generation: number }
  | { type: "runEnded"; generation: number; stopReason: string | null }
  | { type: "exited"; generation: number };

interface RefSwitch {
  /** the item whose model / effort is being applied before its prompt; null for a change the person asked for */
  item: RefItem | null;
  want: { model?: string; effort?: string };
  awaiting: "model" | "effort";
  /** a send or steer landed while the switch was in flight */
  asked: boolean;
  /** the deferred values the send met; they are spent when the prompt goes out */
  deferredBefore: { model?: string; effort?: string };
}

/** the reference's whole memory; only `phase` is one of the six abstract states */
export interface RefMachine {
  phase: RefPhase;
  generation: number;
  queue: RefItem[];
  /** the item handed to pi whose prompt answer has not arrived; it is shown in the visible queue */
  inFlight: RefItem | null;
  /** every prompt handed to pi, in order, for the passed-item comparison */
  passed: RefItem[];
  /** interrupts waiting on a prompt that is on its way */
  held: string[];
  deferred: { model?: string; effort?: string };
  switch: RefSwitch | null;
  /** the queue does not run until a person speaks again */
  paused: boolean;
  /** a run end that arrived before the prompt's answer; it is not an outcome yet */
  pendingRunEnd: { stopReason: string | null } | null;
  outcomes: ("completed" | "stopped" | "failed")[];
  abortSent: boolean;
  itemSeq: number;
  /** a send or steer arrived after the open request and before pi was up */
  openingAsked: boolean;
  /** an open request landed while the conversation was closing */
  pendingOpen: boolean;
}

export function emptyRefMachine(): RefMachine {
  return {
    phase: "Closed",
    generation: 0,
    queue: [],
    inFlight: null,
    passed: [],
    held: [],
    deferred: {},
    switch: null,
    paused: false,
    pendingRunEnd: null,
    outcomes: [],
    abortSent: false,
    itemSeq: 0,
    openingAsked: false,
    pendingOpen: false,
  };
}

function clone(m: RefMachine): RefMachine {
  return {
    ...m,
    queue: m.queue.map((item) => ({ ...item })),
    inFlight: m.inFlight ? { ...m.inFlight } : null,
    passed: m.passed.map((item) => ({ ...item })),
    held: [...m.held],
    deferred: { ...m.deferred },
    switch: m.switch ? { ...m.switch, want: { ...m.switch.want }, deferredBefore: { ...m.switch.deferredBefore } } : null,
    pendingRunEnd: m.pendingRunEnd ? { ...m.pendingRunEnd } : null,
    outcomes: [...m.outcomes],
  };
}

function newItem(m: RefMachine, text: string, model?: string, effort?: string): RefItem {
  m.itemSeq += 1;
  return { id: `q${m.itemSeq}`, text, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** the deferred values a send met are spent once its prompt goes out */
function spendDeferred(m: RefMachine, before: { model?: string; effort?: string }): void {
  if (m.deferred.model === before.model) delete m.deferred.model;
  if (m.deferred.effort === before.effort) delete m.deferred.effort;
}

/** hand the queue's head to pi now; the run it starts is reported as `started` later */
function passItem(m: RefMachine, item: RefItem, before: { model?: string; effort?: string }): void {
  m.inFlight = { ...item };
  m.passed.push({ ...item });
  m.phase = "Running";
  m.pendingRunEnd = null;
  spendDeferred(m, before);
}

/** start a model / effort switch for the head item, or pass it when it needs none */
function beginSend(m: RefMachine, item: RefItem): void {
  const before = { ...m.deferred };
  const model = item.model ?? before.model;
  const effort = item.effort ?? before.effort;
  if (model || effort) {
    m.switch = { item, want: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, awaiting: model ? "model" : "effort", asked: false, deferredBefore: before };
    return;
  }
  m.queue.shift();
  passItem(m, item, before);
}

/** fill pi with the queue's head when nothing holds it back; the one place a prompt leaves */
function drain(m: RefMachine): void {
  if (m.phase !== "Idle" || m.switch !== null || m.paused || !m.queue.length) return;
  beginSend(m, m.queue[0]);
}

/** finish the run the prompt answer reported; a switch still owed keeps its waiters */
function finishRun(m: RefMachine, stopReason: string | null): void {
  const natural = stopReason === "stop" || stopReason === "length";
  const reason: "completed" | "stopped" | "failed" = natural ? "completed" : stopReason === "aborted" ? "stopped" : "failed";
  m.outcomes.push(reason);
  if (m.switch) {
    if (natural) m.switch.asked = true;
    m.phase = "Idle";
    m.inFlight = null;
    return;
  }
  m.phase = "Idle";
  m.inFlight = null;
  if (!natural) m.paused = true;
  if (natural) drain(m);
}

/** the item a refused prompt goes back to the head for; the deferred values it met join it */
function refuseItem(m: RefMachine): void {
  const item = m.inFlight;
  m.inFlight = null;
  if (item) m.queue.unshift({ ...item });
  for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
  m.phase = "Idle";
  m.switch = null;
  m.paused = true;
}

/** the queue items a promotion would drop: everything not yet handed to pi */
export function refDroppedQueue(m: RefMachine): RefItem[] {
  return m.queue.map((item) => ({ ...item }));
}

/** the queue a reader sees: the item whose prompt answer is pending rides at the head */
export function refVisibleQueue(m: RefMachine): RefItem[] {
  return m.inFlight ? [{ ...m.inFlight }, ...m.queue.map((item) => ({ ...item }))] : m.queue.map((item) => ({ ...item }));
}

/** the one transition; it never waits and never reads the implementation */
export function reduceRef(machine: RefMachine, event: RefEvent): RefMachine {
  const m = clone(machine);
  const phase = m.phase;
  switch (event.type) {
    case "open": {
      if (phase === "Closed") {
        m.generation += 1;
        m.phase = "Opening";
        m.openingAsked = false;
      } else if (phase === "Closing") {
        m.pendingOpen = true;
      }
      break;
    }
    case "close": {
      if (phase === "Closed") break;
      if (phase === "Closing") break;
      // the close discards the item whose prompt answer is pending and one still waiting for its switch;
      // the plain queue items stay in memory until pi is really gone
      if (m.switch?.item) {
        const at = m.queue.findIndex((entry) => entry.id === m.switch?.item?.id);
        if (at >= 0) m.queue.splice(at, 1);
      }
      m.inFlight = null;
      m.switch = null;
      m.held = [];
      m.phase = "Closing";
      // the queue stays in memory but a reopened pi must not run it without a person speaking
      m.paused = true;
      break;
    }
    case "send": {
      if (phase === "Closing") break;
      const item = newItem(m, event.text, event.model, event.effort);
      m.queue.push(item);
      m.paused = false;
      if (phase === "Closed") {
        m.generation += 1;
        m.phase = "Opening";
        m.openingAsked = true;
      } else if (phase === "Opening") {
        m.openingAsked = true;
      } else if (phase === "Idle") {
        if (m.switch) m.switch.asked = true;
        else drain(m);
      }
      break;
    }
    case "steer": {
      if (phase === "Closing") break;
      if (phase === "Running" && !m.inFlight) break; // the run is going: delivered to pi straight away
      if (phase === "Running" && m.inFlight) {
        // the prompt's answer has not landed: the interrupt waits, then steers in once the run starts
        m.held.push(event.text);
        break;
      }
      if (phase === "Stopping") {
        m.held.push(event.text);
        break;
      }
      const item = newItem(m, event.text);
      m.queue.push(item);
      m.paused = false;
      if (phase === "Closed") {
        m.generation += 1;
        m.phase = "Opening";
        m.openingAsked = true;
      } else if (phase === "Opening") {
        m.openingAsked = true;
      } else if (phase === "Idle") {
        if (m.switch) m.switch.asked = true;
        else drain(m);
      }
      break;
    }
    case "stop": {
      if (phase === "Closing") break;
      if (phase === "Running") {
        if (m.switch) m.switch = null;
        m.phase = "Stopping";
        m.abortSent = true;
        break;
      }
      if (phase === "Idle" && m.switch) {
        // an item waiting for its switch is not handed over; a change the person asked for still gets answered
        if (m.switch.item) m.switch = null;
        else m.switch.asked = false;
        m.paused = true;
        break;
      }
      break;
    }
    case "model": {
      if (phase === "Closing") break;
      const want: { model?: string; effort?: string } = {};
      if (event.model) want.model = event.model;
      if (event.effort) want.effort = event.effort;
      if (phase === "Idle" && m.switch === null && (want.model || want.effort)) {
        m.switch = { item: null, want, awaiting: want.model ? "model" : "effort", asked: false, deferredBefore: { ...m.deferred } };
        break;
      }
      if (want.model) m.deferred.model = want.model;
      if (want.effort) m.deferred.effort = want.effort;
      break;
    }
    case "edit": {
      if (phase === "Closing") break;
      const item = m.queue.find((entry) => entry.id === event.id);
      if (!item) break;
      if (event.patch.text !== undefined) item.text = event.patch.text;
      if (event.patch.model === null) delete item.model;
      else if (typeof event.patch.model === "string") item.model = event.patch.model;
      if (event.patch.effort === null) delete item.effort;
      else if (typeof event.patch.effort === "string") item.effort = event.patch.effort;
      break;
    }
    case "cancel": {
      if (phase === "Closing") break;
      const at = m.queue.findIndex((entry) => entry.id === event.id);
      if (at >= 0) m.queue.splice(at, 1);
      break;
    }
    case "spawned": {
      if (event.generation !== m.generation || phase !== "Opening") break;
      m.phase = "Idle";
      if (m.openingAsked) drain(m);
      break;
    }
    case "spawnFailed": {
      if (event.generation !== m.generation || phase !== "Opening") break;
      m.phase = "Closed";
      break;
    }
    case "promptSettled": {
      if (event.generation !== m.generation) break;
      if (phase === "Running" && m.inFlight) {
        if (event.disposition === "started" || event.disposition === "queued") {
          const pending = m.pendingRunEnd;
          m.pendingRunEnd = null;
          m.inFlight = null;
          if (pending) {
            for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
            finishRun(m, pending.stopReason);
          } else if (m.held.length) {
            // an interrupt met the run: pi steers it in, the queue does not wait
            m.held = [];
            m.phase = "Running";
          } else {
            m.phase = "Running";
          }
        } else if (event.disposition === "handled") {
          m.inFlight = null;
          m.phase = "Idle";
          for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
          drain(m);
        } else {
          refuseItem(m);
        }
        break;
      }
      if (phase === "Stopping") {
        if (event.disposition === "started" || event.disposition === "queued") {
          const pending = m.pendingRunEnd;
          m.pendingRunEnd = null;
          if (pending) {
            // the run the person stopped had already ended: end as stopped without waiting for an abort
            m.inFlight = null;
            m.phase = "Idle";
            m.abortSent = false;
            m.paused = true;
            m.outcomes.push("stopped");
            for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
          } else {
            m.inFlight = null;
            m.abortSent = true;
            m.phase = "Stopping";
            for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
          }
        } else if (event.disposition === "handled") {
          m.inFlight = null;
          m.phase = "Idle";
          m.paused = true;
          for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
        } else {
          refuseItem(m);
        }
        break;
      }
      break;
    }
    case "modelSettled": {
      if (event.generation !== m.generation) break;
      if (m.switch && m.switch.awaiting === event.step && (phase === "Idle" || phase === "Running")) {
        const sw = m.switch;
        if (!event.ok) {
          if (sw.item) {
            // the item's own switch was refused: the item stays at the head and the queue waits
            for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
            m.switch = null;
            m.paused = true;
          } else {
            m.switch = null;
            if (phase === "Idle" && sw.asked) drain(m);
          }
          break;
        }
        if (event.step === "model" && sw.want.effort) {
          sw.awaiting = "effort";
          break;
        }
        m.switch = null;
        if (sw.item) {
          // the item's own switch settled: hand it to pi now
          const at = m.queue.findIndex((entry) => entry.id === sw.item?.id);
          if (at >= 0) m.queue.splice(at, 1);
          passItem(m, sw.item, sw.deferredBefore);
        } else if (phase === "Idle" && sw.asked) {
          drain(m);
        }
        break;
      }
      break;
    }
    case "runStarted": {
      if (event.generation !== m.generation) break;
      // an item waiting for its switch has not been handed over, so no run of its own can be running;
      // a change the person asked for keeps the run and its waiters
      if (phase === "Idle" && !(m.switch && m.switch.item)) m.phase = "Running";
      break;
    }
    case "runEnded": {
      if (event.generation !== m.generation) break;
      if (phase === "Running" && m.inFlight) {
        // the prompt's answer has not landed: remember the end and let the answer apply it
        m.pendingRunEnd = { stopReason: event.stopReason };
        break;
      }
      if (phase === "Running") {
        finishRun(m, event.stopReason);
        break;
      }
      if (phase === "Stopping") {
        m.inFlight = null;
        m.phase = "Idle";
        m.paused = true;
        for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
        m.outcomes.push("stopped");
        break;
      }
      break;
    }
    case "exited": {
      if (event.generation !== m.generation) break;
      m.pendingRunEnd = null;
      if (phase === "Closed" || phase === "Closing") {
        if (phase === "Closing") {
          if (m.pendingOpen) {
            m.generation += 1;
            m.phase = "Opening";
            m.openingAsked = false;
            m.pendingOpen = false;
          } else {
            m.phase = "Closed";
            m.queue = [];
          }
        }
        break;
      }
      if (phase === "Opening") {
        m.phase = "Closed";
        break;
      }
      if (phase === "Idle") {
        m.switch = null;
        m.phase = "Closed";
        break;
      }
      if (phase === "Running") {
        if (m.inFlight) {
          // the prompt never got its answer: the item goes back to the head, nothing ended
          m.queue.unshift({ ...m.inFlight });
          m.inFlight = null;
        } else {
          m.outcomes.push("failed");
        }
        m.switch = null;
        m.phase = "Closed";
        m.paused = true;
        break;
      }
      if (phase === "Stopping") {
        m.inFlight = null;
        m.phase = "Closed";
        m.paused = true;
        if (m.abortSent) m.outcomes.push("stopped");
        for (const text of m.held.splice(0)) m.queue.push(newItem(m, text));
        break;
      }
      break;
    }
  }
  return m;
}
