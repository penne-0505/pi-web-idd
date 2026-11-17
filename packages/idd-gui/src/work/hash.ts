import type { ViewName } from "../view";

/** the screen, lane and full-band state a URL hash names */
export interface WorkHashState {
  view: ViewName;
  lane: string | null;
  all: boolean;
}

/**
 * The hash as the screen opens: `#work`, `#work/<lane id>`, `#work/all`. Anything else is the Inbox, so an old or
 * misspelled hash never opens a Work state it does not describe. Pure: the caller reads the hash once on open.
 */
export function workStateFromHash(hash: string): WorkHashState {
  const h = (hash ?? "").replace(/^#/, "");
  if (h === "work") return { view: "work", lane: null, all: false };
  if (h === "work/all") return { view: "work", lane: null, all: true };
  if (h.startsWith("work/")) {
    const lane = decodeURIComponent(h.slice("work/".length));
    return lane ? { view: "work", lane, all: false } : { view: "work", lane: null, all: false };
  }
  return { view: "inbox", lane: null, all: false };
}

/** the hash that names a Work state, so an operation can write it back */
export function hashOfWork(state: { lane: string | null; all: boolean }): string {
  if (state.all) return "#work/all";
  if (state.lane) return `#work/${encodeURIComponent(state.lane)}`;
  return "#work";
}
