/**
 * Every operation the Work screen can take, as a value. A component turns a key or a click into one of these and
 * hands it to the screen, so what a press means is testable without rendering (the Inbox's `keymap.ts` shape).
 * None of these is a decision card: Work looks, and the one way to act is to go to the Inbox (DEC-103-4).
 */
export type WorkIntent =
  | { kind: "select_lane"; lane: string }
  | { kind: "clear_selection" }
  | { kind: "select_and_close"; lane: string }
  | { kind: "open_all" }
  | { kind: "close_all" }
  | { kind: "select_repo"; repo: string | null }
  | { kind: "open_inbox"; lane: string }
  | { kind: "select_tab"; tab: string }
  | { kind: "toggle_done" };

export interface WorkKeyContext {
  selection: string | null;
  all: boolean;
}

/** pressing a lane row: the selected row pressed again lets it go, any other row selects it (AC-027) */
export function laneIntent(lane: string, selection: string | null): WorkIntent {
  return selection === lane ? { kind: "clear_selection" } : { kind: "select_lane", lane };
}

/** the minimap and the "すべて" control open the same full band (AC-018) */
export function allIntent(): WorkIntent {
  return { kind: "open_all" };
}

/** a row of the full band is pressed: it selects that lane and the band closes (AC-020) */
export function timelineRowIntent(lane: string): WorkIntent {
  return { kind: "select_and_close", lane };
}

/** Esc closes the full band (AC-020) */
export function escapeIntent(): WorkIntent {
  return { kind: "close_all" };
}

/** a repo row: "すべて" is null, and any other row selects that repo (AC-016) */
export function repoIntent(repo: string | null): WorkIntent {
  return { kind: "select_repo", repo };
}

/** the way from a lane at a person's turn to its Inbox card (AC-035) */
export function inboxIntent(lane: string): WorkIntent {
  return { kind: "open_inbox", lane };
}

/** the keys the full band answers while it is open */
export function workIntentForKey(key: string, ctx: WorkKeyContext): WorkIntent | null {
  if (key === "Escape" && ctx.all) return escapeIntent();
  return null;
}
