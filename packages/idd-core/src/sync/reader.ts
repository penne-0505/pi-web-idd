import type { ExtSnapshot, Tracker } from "./types.ts";

/**
 * An outside tracker as the sync sees it: a way to read, and nothing else. The sync has no other door to the outside,
 * so a reader is also the whole of what a sync can do to it.
 */
export interface TrackerReader {
  tracker: Tracker;
  /** whether an Issue ref belongs to the tracker this reader reads (the others are no business of this sync) */
  owns(ref: string): boolean;
  /** the outside's Projects and Issues; `refs` are the Issues propter's Projects hold, which are read by name when no listed Project holds them */
  read(refs: readonly string[]): Promise<ExtSnapshot>;
}
