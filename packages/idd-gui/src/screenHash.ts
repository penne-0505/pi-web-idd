import type { ViewName } from "./view";

/** the screen, lane and conversation a URL hash names */
export interface ScreenHashState {
  view: ViewName;
  lane: string | null;
  all: boolean;
  chat: string | null;
}

/**
 * The hash the screen opens with. `#work…` names Work, `#chat` and `#chat/<id>` name the conversation screen and,
 * when it carries one, the selected conversation; anything else is the Inbox, so an old or misspelled hash never
 * opens a state it does not describe. Pure: the caller reads the hash once on open.
 */
export function screenStateFromHash(hash: string): ScreenHashState {
  const h = (hash ?? "").replace(/^#/, "");
  if (h === "work") return { view: "work", lane: null, all: false, chat: null };
  if (h === "work/all") return { view: "work", lane: null, all: true, chat: null };
  if (h.startsWith("work/")) {
    const lane = decodeURIComponent(h.slice("work/".length));
    return { view: "work", lane: lane || null, all: false, chat: null };
  }
  if (h === "chat") return { view: "chat", lane: null, all: false, chat: null };
  if (h.startsWith("chat/")) {
    const chat = decodeURIComponent(h.slice("chat/".length));
    return { view: "chat", lane: null, all: false, chat: chat || null };
  }
  return { view: "inbox", lane: null, all: false, chat: null };
}

/**
 * The screen a `?view=` names, or null when the value is not one we know. The port's own `lanes` spelling is
 * accepted and means the same screen as `work`: the query and the hash must not disagree about the name.
 */
export function viewFromQuery(search: string): ViewName | null {
  const v = new URLSearchParams(search).get("view");
  if (v === "inbox" || v === "work" || v === "chat") return v;
  if (v === "lanes") return "work";
  return null;
}

/**
 * The Inbox card a `?card=` names, by the id the CLI's answer carries (`inboxCardUrl`): a lane's `IDD-n` or a
 * draft's `OUT-…`. Null when there is none. The id is only a name to look for; the screen brings that card to the
 * front when the engine's state has it, and opens the Inbox as it is when it does not.
 */
export function cardFromQuery(search: string): string | null {
  const c = new URLSearchParams(search).get("card")?.trim();
  return c ? c : null;
}

/**
 * The state the screen opens with: the query picks the screen and the hash refines it. An unknown `?view=` falls
 * back to the hash, and a hash that names no screen leaves the Inbox, so a misspelled value never opens a screen
 * nobody asked for.
 */
export function initialScreen(search: string, hash: string): ScreenHashState {
  const fromHash = screenStateFromHash(hash);
  const view = viewFromQuery(search) ?? fromHash.view;
  return {
    view,
    lane: view === "work" ? fromHash.lane : null,
    all: view === "work" ? fromHash.all : false,
    chat: view === "chat" ? fromHash.chat : null,
  };
}

/** the hash that names a screen state, so a selection can be written back into the URL */
export function hashOfScreen(state: { view: ViewName; lane: string | null; all: boolean; chat: string | null }): string {
  if (state.view === "work") {
    if (state.all) return "#work/all";
    if (state.lane) return `#work/${encodeURIComponent(state.lane)}`;
    return "#work";
  }
  if (state.view === "chat") return state.chat ? `#chat/${encodeURIComponent(state.chat)}` : "#chat";
  return "#inbox";
}

/** the hash that names a conversation state, so a selection can be written back into the URL */
export function hashOfChat(id: string | null): string {
  return id ? `#chat/${encodeURIComponent(id)}` : "#chat";
}
