/**
 * The find field's own keys, kept out of the components so they can be checked without a browser. ⌘K (or Ctrl+K)
 * opens the field from any screen; while it is open the arrows and Enter belong to the field and Esc closes it.
 * The Inbox's card keys are installed by a different branch of the screen's one listener, so while the field is
 * open no press can become a card's decision (the field is over the card).
 */

export interface SearchKeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** the press that opens the field: ⌘K or Ctrl+K, never a repeat and never during an IME conversion */
export function isSearchOpenPress(press: SearchKeyLike): boolean {
  if (press.repeat === true || press.isComposing === true) return false;
  if (press.altKey === true) return false;
  if (press.metaKey !== true && press.ctrlKey !== true) return false;
  return press.key === "k" || press.key === "K";
}

export type SearchKeyAction = "close" | "body" | "select" | "next" | "prev";

/**
 * What a press means while the field is open. `stage.body` says the full-text results are on screen and
 * `stage.rows` how many rows the title stage offers. Enter picks the chosen row; only when the title stage
 * offers nothing does it ask the search door for the body (C-173-1). Every other key belongs to the input.
 */
export function searchKeyAction(press: SearchKeyLike, stage: { body: boolean; rows: number }): SearchKeyAction | null {
  if (press.repeat === true || press.isComposing === true) return null;
  if (press.key === "Escape") return "close";
  if (press.key === "Enter") return stage.body || stage.rows > 0 ? "select" : "body";
  if (press.key === "ArrowDown") return "next";
  if (press.key === "ArrowUp") return "prev";
  return null;
}
