import { readdirSync } from "node:fs";
import { join } from "node:path";

import { readSessions } from "../ledger/read.ts";
import { dir, read, recordPath, save } from "../overlay/git.ts";

/** the branch a lane's worktree was cut on, written when it is cut (before any session is spawned in it) */
interface CutRecord { idd_id: string; branch: string; at: string }
const CUTS = "lane-branches";

export function recordLaneCut(iddId: string, branch: string): void {
  const path = recordPath(CUTS, iddId);
  if (read<CutRecord>(path)?.branch === branch) return;
  save(path, { idd_id: iddId, branch, at: new Date().toISOString() } satisfies CutRecord);
}

function cutRecords(): CutRecord[] {
  const root = dir(CUTS);
  return readdirSync(root).filter((f) => f.endsWith(".json")).flatMap((f) => {
    const rec = read<CutRecord>(join(root, f));
    return rec?.idd_id && rec.branch ? [rec] : [];
  });
}

/**
 * The branch a lane was made on: as recorded when its worktree was cut, else as its planner or executor session
 * recorded it (lanes cut before the cut was recorded). A lane keeps it when the repo's rule changes later (lanes made
 * as idd/IDD-n stay there). None until the lane's worktree is cut, whether a session was spawned in it or not.
 */
export function recordedLaneBranch(iddId: string): string | undefined {
  const cut = read<CutRecord>(recordPath(CUTS, iddId))?.branch;
  if (cut) return cut;
  for (const kind of ["executor", "planner"] as const) {
    const branch = readSessions(kind).filter((r) => r.idd_id === iddId && r.branch).pop()?.branch;
    if (branch) return branch;
  }
  return undefined;
}

/** another IDD lane that was cut on this branch (by its cut's record, or its session's) */
export function laneRecording(branch: string, iddId: string): string | undefined {
  const cut = cutRecords().find((r) => r.branch === branch && r.idd_id !== iddId);
  if (cut) return cut.idd_id;
  for (const kind of ["executor", "planner"] as const) {
    const other = readSessions(kind).find((r) => r.branch === branch && r.idd_id !== iddId);
    if (other) return other.idd_id;
  }
  return undefined;
}
