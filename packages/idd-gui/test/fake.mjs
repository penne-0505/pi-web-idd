/** a fetch stand-in: every call is parked until the test answers it, so the order of responses is the test's */
export function fakeFetch() {
  const calls = [];
  const fetchFn = (path, init) => {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const call = { path, init, body: init?.body ? JSON.parse(init.body) : null, promise };
    call.respond = (status, body, headers = {}) =>
      settle({
        status,
        ok: status >= 200 && status < 300,
        // the answer's headers, lower-cased like a Response's: the state door numbers its answer in `x-idd-seq`
        headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
        json: async () => {
          if (body === undefined) throw new Error("no json");
          return body;
        },
      });
    call.reject = (error) => settle(Promise.reject(error ?? new Error("network")));
    calls.push(call);
    return promise;
  };
  return {
    fetchFn,
    calls,
    of: (path) => calls.filter((call) => call.path === path),
    last: () => calls[calls.length - 1],
  };
}

import { createJiti } from "jiti";

const { decisionOf } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("../../idd-engine/src/server/card-decision.ts");

/** a state answer: every card carries the engine's answer (`decision`), the way the engine's state does */
export function snapshot(items, extra = {}) {
  // the answer is made again from the card's final fields, so a card copied from another never carries that one's answer
  const answered = items.map((item) => ({ ...item, decision: decisionOf(item) }));
  return { source: "state", stateDir: "/tmp", cron: null, sections: [], lanes: [], items: answered, undelivered: { total: 0, failed: 0 }, ignores: [], holds: [], ...extra };
}

/** let the store's promise chains run to a resting point */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A stand-in for the conversation stream: every open is recorded with the path and starting number, and the test
 * emits events, a reset or a gone signal on the handle it wants. The store takes the opener itself, so a test does
 * not need a browser.
 */
export function fakeStreams() {
  const opened = [];
  const open = (path, lastEventId, onEvent, onGone, onId) => {
    let seq = 0;
    const handle = {
      path,
      lastEventId,
      events: [],
      closed: false,
      emit(event) {
        this.events.push(event);
        if (this.closed) return;
        if (typeof event.seq === "number") seq = event.seq;
        else seq += 1;
        onEvent({ seq, ...event });
      },
      /** an `id:`-only frame: no event, but the number the reconnect should resume from */
      idOnly(id) {
        if (!this.closed) onId?.(id);
      },
      reset() {
        if (!this.closed) onEvent({ type: "reset" });
      },
      gone() {
        if (!this.closed) onGone();
      },
      close() {
        this.closed = true;
      },
    };
    opened.push(handle);
    return handle;
  };
  return { open, calls: opened, last: () => opened[opened.length - 1] };
}

/** the group list one conversation falls into, in the shape the list door returns */
export function chatGroups(conversations, label = "今日") {
  return [{ key: "today", label, conversations }];
}

/** one conversation summary with the fields the list and a row read */
export function conversation(id, extra = {}) {
  return {
    id,
    mode: "chat",
    cwd: "/tmp/chat",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T01:00:00Z",
    cost: 0,
    open: false,
    running: false,
    tools: [],
    pinned: false,
    archived: false,
    bookmarks: [],
    workdir: "",
    ...extra,
  };
}
