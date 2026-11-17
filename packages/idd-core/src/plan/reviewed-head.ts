import { filteredTree } from "../overlay/git.ts";
import { readManifest } from "../overlay/manifest.ts";
import { laneAnswer } from "../intent/moonbit-fold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * The head the current submit was last looked at, folded by the MoonBit fold: the head the loop's last review looked
 * at, or the head the submit was opened at. A lane from before R2 was removed (2026-10-22) whose S3 ran an R2 reads the
 * head that R2 reviewed, so its past events still answer as they did. What the head is compared with stays here, because it is the repository's state
 * rather than the column's (C-195-2).
 */
function reviewedHead(evs: LifecycleRecord[]): { commit: string; by: string } | null {
  return laneAnswer<{ commit: string; by: string } | null>("reviewed_head", evs);
}

/**
 * Why the lane's head is not got ready for the card by the tick: its public side (overlay excluded, so the records'
 * own commits do not count) differs from what the review looked at. A commit that moved no stage (made in the
 * worktree, or by the executor after the review) has not been reviewed.
 */
export function unreviewedChange(evs: LifecycleRecord[], worktree: string, head: string): { reason: string; seen: string } | null {
  const seen = reviewedHead(evs);
  if (!seen || seen.commit === head) return null;
  let same = false;
  try {
    const paths = readManifest(worktree).paths;
    same = filteredTree(worktree, seen.commit, paths) === filteredTree(worktree, head, paths);
  } catch {
    // the reviewed commit cannot be read: not taken as the same
  }
  if (same) return null;
  return {
    seen: seen.commit,
    reason: `${seen.by} ${seen.commit.slice(0, 7)} の後に、レビューを経ていない公開側の変更があります（今の head ${head.slice(0, 7)}）。tick は push の準備をしません。差し戻してレビューを通すか、差分を確かめてから提出前確認のカードで検査し直してください`,
  };
}
