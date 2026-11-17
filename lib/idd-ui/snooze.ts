import type { InboxItem } from "./types";

/** how long "あとで" keeps a card out of the front of the inbox */
export const SNOOZE_DEFAULT_MINUTES = 360;

/**
 * "寝かせる": the days until the inbox asks whether to bring a sleeping card back. The first ask comes a day after
 * it was put to sleep; each "まだ寝かせる" moves to the next interval, and after the last it asks no more.
 */
export const SLEEP_NOTICE_DAYS = [1, 3, 7] as const;

/** the days until the next ask after the card was kept asleep `step` times, or null when it asks no more */
export function sleepNoticeDays(step: number): number | null {
  return SLEEP_NOTICE_DAYS[step] ?? null;
}

/**
 * Which card a snooze belongs to. A question batch, or the time the lane came to the decision, is part of the key so
 * a new batch or a card that comes again on the same lane is a new decision and comes to the front on its own.
 */
export function snoozeKey(item: InboxItem): string {
  if (item.kind === "question") return `${item.kind}:${item.iddId}:${item.batchId}`;
  // a proposal's key is its own id (with its repo): two of one lane's proposals are two cards (INV-112-6)
  if (item.kind === "proposal") return `${item.kind}:${item.repo}:${item.proposalId}`;
  // the low-space card is tied to no lane: its key is the kind alone
  if (item.kind === "storage") return item.kind;
  // a conflict is the same decision while its values change, so a put-off holds until it closes
  if (item.kind === "sync_conflict") return `${item.kind}:${item.conflictId}`;
  return item.appearedAt ? `${item.kind}:${item.iddId}:${item.appearedAt}` : `${item.kind}:${item.iddId}`;
}

/** the decks the page keeps open: one left with no card closes, so the next card put there does not open it by itself */
export function openDecksAfter(open: { laterOpen: boolean; sleepOpen: boolean }, view: { later: InboxItem[]; sleeping: InboxItem[] }): { laterOpen: boolean; sleepOpen: boolean } {
  return { laterOpen: open.laterOpen && view.later.length > 0, sleepOpen: open.sleepOpen && view.sleeping.length > 0 };
}

/** put to sleep: out of both decks until penne brings it back */
export function isSleeping(item: InboxItem): boolean {
  return item.sleptAt !== undefined;
}

/** a sleeping card whose ask has come */
export function sleepDue(item: InboxItem, now: number): boolean {
  return isSleeping(item) && item.sleepNoticeAt !== undefined && Date.parse(item.sleepNoticeAt) <= now;
}

export function isSnoozed(item: InboxItem, now: number): boolean {
  return !isSleeping(item) && item.snoozedUntil !== undefined && Date.parse(item.snoozedUntil) > now;
}

/** the front of the inbox and the cards put off until later, in their original order (sleeping cards are in neither) */
export function splitSnoozed(items: InboxItem[], now: number): { front: InboxItem[]; later: InboxItem[] } {
  const front: InboxItem[] = [];
  const later: InboxItem[] = [];
  for (const item of items) {
    if (isSleeping(item)) continue;
    (isSnoozed(item, now) ? later : front).push(item);
  }
  return { front, later };
}

/**
 * What the inbox shows: the deck, the cards put off, the sleeping cards and those whose ask has come, and the count
 * on the tab (the deck and the asks).
 */
export function inboxView(items: InboxItem[], now: number): { front: InboxItem[]; later: InboxItem[]; sleeping: InboxItem[]; due: InboxItem[]; count: number } {
  const { front, later } = splitSnoozed(items, now);
  const sleeping = items.filter(isSleeping);
  const due = sleeping.filter((i) => sleepDue(i, now));
  return { front, later, sleeping, due, count: front.length + due.length };
}

/** ms until the earliest put-off card comes back or sleeping card asks, or null when none is waiting */
export function nextWake(items: InboxItem[], now: number): number | null {
  let soonest: number | null = null;
  const consider = (at: number) => { if (soonest === null || at < soonest) soonest = at; };
  for (const item of items) {
    if (isSnoozed(item, now)) consider(Date.parse(item.snoozedUntil as string));
    else if (isSleeping(item) && item.sleepNoticeAt !== undefined && !sleepDue(item, now)) consider(Date.parse(item.sleepNoticeAt));
  }
  return soonest === null ? null : (soonest as number) - now;
}

export type SnoozeMove = "later" | "wake" | "sleep" | "keep";

/** what the page shows for a card right after a move went through, before the next read of the state */
export function afterSnoozeMove(item: InboxItem, move: SnoozeMove, now: number, until?: string): InboxItem {
  const rest: InboxItem = { ...item };
  delete rest.snoozedUntil;
  delete rest.sleptAt;
  delete rest.sleepNoticeAt;
  delete rest.sleepStep;
  const noticeAt = (step: number) => {
    const days = sleepNoticeDays(step);
    return days === null ? {} : { sleepNoticeAt: new Date(now + days * 86_400_000).toISOString() };
  };
  if (move === "wake") return rest;
  if (move === "later") return { ...rest, ...(until ? { snoozedUntil: until } : {}) };
  if (move === "sleep") return { ...rest, sleptAt: new Date(now).toISOString(), sleepStep: 0, ...noticeAt(0) };
  const step = (item.sleepStep ?? 0) + 1;
  return { ...rest, sleptAt: item.sleptAt ?? new Date(now).toISOString(), sleepStep: step, ...noticeAt(step) };
}

/** "15:30", or "9/25 15:30" when it is not today */
export function wakeLabel(until: string, now: number): string {
  const at = new Date(until);
  const today = new Date(now);
  const hm = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  return at.toDateString() === today.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}
