import { runClose, type CloseOptions, type CloseResult } from "../plan/close.ts";
import { readLifecycle } from "../ledger/read.ts";
import { blockingCount, blockingSummary } from "./gate.ts";
import { git, lockRefusal } from "./git.ts";
import { cancelImport, conflictResolved, importUpstream, markImportedNoop, proposeImport, renewReceipt, reviewImport } from "./import.ts";

export interface SyncResult {
  ok: boolean;
  error?: string;
  /** null when the public branch had nothing new */
  imported: { from: string; to: string; files: number } | null;
  /** lanes whose merged PR is now taken in, their records reclaimed and the lane closed */
  closed: string[];
  recovery?: string;
  /** where the receive stopped: the public branch conflicts, a required check fails, or it could not go on (the error says why) */
  stop?: "conflict" | "checks" | "import";
  /** the overlay lock was held by someone else: nothing was tried, and the next pass looks again */
  lockRefused?: true;
  /** the public branch moved while the receive was checked: nothing is recorded, and the next pass cuts the receive again from the new tip */
  retry?: true;
  /** the close pass's answer for each lane it looked at, when the receive went through */
  close?: CloseResult[];
}

function stopped(error: string, rest: Partial<SyncResult> = {}): SyncResult {
  const refused = lockRefusal(error);
  return { ok: false, error, imported: null, closed: [], ...(refused ? { lockRefused: true as const } : { stop: "import" as const }), ...rest };
}

function moved(error: string): SyncResult {
  return { ok: false, error: `${error}（次の受け入れが新しい先端から読み直します）`, imported: null, closed: [], retry: true };
}

function dropRecovery(work: string, recovery: string): void {
  try { git(work, ["worktree", "remove", "--force", recovery]); } catch { /* already gone */ }
}

/**
 * Take the public branch into the work branch and close the lanes whose PR it merged, in one go.
 * The import has no side effect outside this machine, so it needs no approval; a conflict or a
 * failing required check stops before anything changes and leaves the receipt for a person. A receipt that
 * stopped on a conflict is read again here: once the recovery holds a commit resolving it, the import goes on to
 * the checks, so the tick and the CLI take a resolution in through this one place (the person types nothing).
 * A saved receipt the public branch has moved past (nobody worked in its recovery) is cut again first, and one whose only
 * difference is the settings takes the present ones (`renewReceipt`).
 * `close` is handed to the close pass (the tick's stage names the lanes it may try again).
 */
export async function syncArea(area: string, close: CloseOptions = {}): Promise<SyncResult> {
  renewReceipt(area);
  const view = proposeImport(area);
  if ("error" in view) return stopped(view.error);
  if (view.conflict && !conflictResolved(area)) return { ok: false, error: `公開先と衝突しています。解消用の作業場所で衝突を直して commit してください（次の受け入れが読み直します）: ${view.recovery}`, imported: null, closed: [], stop: "conflict", recovery: view.recovery };

  let imported: SyncResult["imported"] = null;
  if (!view.commits.length && !view.apply.length) {
    // nothing to take in: the work branch holds the tip, and the close pass needs the mark to see it. A tip not shown
    // to be in is a stop (a card), not a pass that does the same again
    const marked = markImportedNoop(area);
    if (!marked.ok) return marked.stale ? moved(marked.error!) : stopped(marked.error!, { recovery: view.recovery });
    cancelImport(area);
    dropRecovery(view.work, view.recovery);
  } else {
    const reviewed = await reviewImport(area);
    if ("error" in reviewed) return stopped(reviewed.error, { recovery: view.recovery });
    if (blockingCount(reviewed.checks)) return { ok: false, error: `必須の検査が通りません: ${blockingSummary(reviewed.checks)}`, imported: null, closed: [], stop: "checks", recovery: reviewed.recovery };
    const done = importUpstream(area, reviewed.token!);
    if (!done.ok) return done.stale ? moved(done.error!) : stopped(done.error!, { recovery: view.recovery });
    imported = { from: done.from!, to: done.to!, files: done.files ?? 0 };
    dropRecovery(view.work, view.recovery);
  }

  const before = new Set(readLifecycle().filter((e) => e.event === "lane_close").map((e) => e.idd_id));
  const results = await runClose(close);
  const closed = readLifecycle().filter((e) => e.event === "lane_close" && !before.has(e.idd_id)).map((e) => e.idd_id);
  return { ok: true, imported, closed, close: results };
}
