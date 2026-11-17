/**
 * What the composer's keys mean, apart from the DOM. Enter sends, Shift + Enter writes a line, and an Enter that
 * belongs to an IME composition does nothing at all: converting Japanese ends with Enter, and sending on it would
 * hand an unfinished sentence to pi with nothing left to take it back.
 */

export type ComposerKey = "send" | "newline" | "none";

export interface KeyPress {
  key: string;
  shift?: boolean;
  /** the browser says a composition is in flight */
  isComposing?: boolean;
  /** the older signal for the same thing: 229 is the composition Enter */
  keyCode?: number;
}

/**
 * What one change of the composer's draft means. The text is exactly what was typed — a character the user wrote is
 * never taken back out, so an address or a handle written with `@` reaches the send with its `@` — and a `@` typed
 * at the start of a word opens the picker. A `@` inside a word opens nothing, because it is not pointing at a lane.
 */
export interface DraftChange {
  draft: string;
  openPicker: boolean;
}

export function composerDraftChange(prev: string, next: string): DraftChange {
  const typedAt = next === `${prev}@`;
  const before = prev.slice(-1);
  return { draft: next, openPicker: typedAt && (before === "" || /\s/.test(before)) };
}

export function composerKey(press: KeyPress): ComposerKey {
  if (press.key !== "Enter") return "none";
  if (press.isComposing === true || press.keyCode === 229) return "none";
  if (press.shift === true) return "newline";
  return "send";
}
