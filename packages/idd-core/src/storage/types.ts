import type { StoragePlace } from "./config.ts";

/** every place the sweep knows about: the six configurable ones, the list-only ones, and the places other code sweeps */
export type PlaceName =
  | StoragePlace
  | "review_run_copies"
  | "review_lane_copies"
  | "manual_copies"
  | "lane_worktrees"
  | "check_copies"
  | "tmp_dirs"
  | "overlay_worktrees"
  | "consult_copies";

/** how the sweep removes one candidate; the place decides */
export type Removal = "git-worktree" | "dir" | "file" | "contents-then-evidence";

/** what a candidate's record is, and how the sweep treats it after the contents are gone */
export type Evidence =
  | { kind: "review-run"; path: string }
  | { kind: "lane-json"; path: string }
  | { kind: "sidecar"; path: string }
  | { kind: "ledger" }
  | { kind: "none" };

export interface Candidate {
  place: PlaceName;
  /** the candidate's own path (a resolved path under a place's root) */
  path: string;
  bytes: number;
  /** when the item came to be used up (the lane's close, the run's end) */
  usedUpAt: string;
  /** when the sweep may delete it (usedUpAt + the place's keep period) */
  dueAt: string;
  /** the lane the item belongs to, when the record names one */
  lane?: string;
  removal: Removal;
  /** for `git-worktree` removals: the clone git is run from */
  clone?: string;
  evidence: Evidence;
}

export interface Kept {
  place: PlaceName;
  path: string;
  reason: string;
  lane?: string;
}

export interface PlaceUsage {
  place: PlaceName;
  /** the place's name in a person's words */
  label: string;
  bytes: number;
  count: number;
  /** whether this place is swept (the settings); null for the places other code owns */
  cleanup: boolean | null;
  /** whether a candidate of this place can be swept at all (a declaration is present, the runner can tell sessions apart) */
  sweepable?: boolean;
  note?: string;
}

export interface Judgement {
  places: PlaceUsage[];
  candidates: Candidate[];
  kept: Kept[];
}

/** the free space of a filesystem the state lives on */
export interface FsSpace {
  mount: string;
  freeBytes: number;
  totalBytes: number;
  belowThreshold: boolean;
}
