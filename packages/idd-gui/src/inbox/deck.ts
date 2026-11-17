import type { InboxItem } from "../engine/contract";
import { inboxView, snoozeKey } from "../engine/contract";

/** a card's identity: the same key the engine's snooze uses, so a card that comes again is a new key */
export function itemKey(item: InboxItem): string {
  return snoozeKey(item);
}

/**
 * The card a URL named by id: the one the engine's state holds for that lane or draft, among the cards still in the
 * front of the deck. Null when there is none (the card is decided, put off or not there yet).
 */
export function cardNamed(front: readonly InboxItem[], id: string): InboxItem | null {
  return front.find((item) => "iddId" in item && item.iddId === id) ?? null;
}

export interface Deck {
  /** the cards in the deck, front first; a locally skipped card is behind the rest */
  front: InboxItem[];
  /** put off with the engine's snooze */
  later: InboxItem[];
  /** put to sleep; they never come back by themselves */
  sleeping: InboxItem[];
  /** sleeping cards whose ask has come */
  due: InboxItem[];
  /** the badge: the front plus the asks that came */
  count: number;
}

/**
 * The deck as the inbox shows it, from the engine's own split (so a card reads the same here and in the current
 * GUI). Every card the engine returns is drawn, from its own judgment and operations, so none is moved aside as one
 * the screen cannot handle (C-265-3). `hidden` holds the keys the screen has already decided on, so a stale state response cannot bring one back.
 */
export function deck(items: InboxItem[], now: number, hidden: readonly string[] = [], focused: string | null = null): Deck {
  const view = inboxView(items, now);
  const gone = new Set(hidden);
  const front = view.front.filter((item) => !gone.has(itemKey(item)));
  const later = view.later.filter((item) => !gone.has(itemKey(item)));
  const sleeping = view.sleeping.filter((item) => !gone.has(itemKey(item)));
  const due = view.due.filter((item) => !gone.has(itemKey(item)));
  const ordered = front;
  // the card the person picked from the sidebar comes first; the rest keep the engine's order behind it
  const at = focused === null ? -1 : ordered.findIndex((item) => itemKey(item) === focused);
  const shown = at > 0 ? [ordered[at], ...ordered.slice(0, at), ...ordered.slice(at + 1)] : ordered;
  return { front: shown, later, sleeping, due, count: shown.length + due.length };
}

/**
 * The invariant the deck must never break: every card the state returned is somewhere in the deck or in the left
 * sidebar (the put-off and sleeping ones, or a decided one). A card that is in none of them is lost.
 */
export function everyCardShown(items: InboxItem[], now: number): boolean {
  const view = inboxView(items, now);
  return view.front.length + view.later.length + view.sleeping.length === items.length;
}
