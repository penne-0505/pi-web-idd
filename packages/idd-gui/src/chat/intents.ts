/**
 * The list row's operations as values, so what a press means can be fixed without a browser. The delete is the one
 * that matters: one press only opens the confirm, and only a second press on the same row calls the engine. That is
 * what stands between a slipped menu press and a record file that never comes back.
 */

export interface DeleteState {
  /** the row whose delete is waiting for a second press, or null */
  confirming: string | null;
}

export type DeletePress =
  | { kind: "remove"; id: string }
  | { kind: "cancel" }
  | { kind: "elsewhere" }
  | { kind: "escape" };

export interface DeleteDecision {
  next: DeleteState;
  /** the id whose delete door may now be called, or null */
  remove: string | null;
}

export function deleteIntent(state: DeleteState, press: DeletePress): DeleteDecision {
  if (press.kind === "remove") {
    if (state.confirming === press.id) return { next: { confirming: null }, remove: press.id };
    return { next: { confirming: press.id }, remove: null };
  }
  return { next: { confirming: null }, remove: null };
}

/** the list's open menu and waiting delete, so every press can be a value a test drives */
export interface ListUiState {
  /** the row whose menu is open, or null */
  menu: string | null;
  /** the row whose delete waits for a second press, or null */
  confirming: string | null;
}

export type ListPress =
  | { kind: "select"; id: string }
  | { kind: "menu"; id: string }
  | { kind: "mark"; id: string }
  | { kind: "archive" }
  | { kind: "workspace" }
  | { kind: "new-chat" }
  | { kind: "delete"; id: string }
  | { kind: "escape" }
  | { kind: "elsewhere" };

export interface ListDecision {
  next: ListUiState;
  /** the id whose delete door may now be called, or null */
  remove: string | null;
}

/**
 * One place for the list's presses. The delete confirm belongs to a row: any other press on the list — another
 * row, a menu, anywhere — drops it, so a slipped press cannot remove a record that no longer shows a confirm.
 * Only the second press on the same row carries the id the delete door may be called with (DEC-116-7).
 */
export function listIntent(state: ListUiState, press: ListPress): ListDecision {
  if (press.kind === "delete") {
    const decision = deleteIntent({ confirming: state.confirming }, { kind: "remove", id: press.id });
    return {
      next: { menu: decision.remove ? null : state.menu, confirming: decision.next.confirming },
      remove: decision.remove,
    };
  }
  if (press.kind === "menu") {
    return { next: { menu: state.menu === press.id ? null : press.id, confirming: null }, remove: null };
  }
  if (press.kind === "escape") return { next: { menu: null, confirming: null }, remove: null };
  // every other press leaves the menu where it is and drops the waiting delete
  return { next: { menu: state.menu, confirming: null }, remove: null };
}

/** the mark a row's menu item toggles, in the shape the marks door takes */
export interface MarkToggle {
  id: string;
  patch: { pinned?: boolean; archived?: boolean; bookmarks?: string[] };
}

/** pin / archive toggle: the value flips from what the row currently shows */
export function togglePinned(id: string, pinned: boolean): MarkToggle {
  return { id, patch: { pinned: !pinned } };
}

export function toggleArchived(id: string, archived: boolean): MarkToggle {
  return { id, patch: { archived: !archived } };
}

/** a bookmark toggle: the kind joins or leaves the row's list, and the whole list is sent */
export function toggleBookmark(id: string, bookmarks: string[], kind: string): MarkToggle {
  const next = bookmarks.includes(kind) ? bookmarks.filter((entry) => entry !== kind) : [...bookmarks, kind];
  return { id, patch: { bookmarks: next } };
}
