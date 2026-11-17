/**
 * Whether the element that has focus is a place the user writes text. The screen reads this at the moment of a
 * key press, not at render, so a key is judged against the focus it actually has: a re-render may not have
 * happened since focus moved, and a value captured earlier would let the card move while the user is writing.
 * The shape is structural so the rule can be checked without a browser.
 */
export interface FocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

export function isTextEntry(target: FocusTarget | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable === true;
}
