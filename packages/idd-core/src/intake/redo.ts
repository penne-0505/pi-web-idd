import { stopLaneWork, type StopWorkResult } from "../agent/stop.ts";
import { laneHasEnded } from "../ledger/ends.ts";
import { withLaneGate } from "../ledger/gate.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { appendLifecycle, transition } from "../ledger/write.ts";
import { issueKeyOf, sameKey } from "./ignore.ts";
import { closedLaneIds, issueRefOfUrl, laneHoldingIssue, nextIddId, openLaneForIssue, readNamedIssue, type LinearIntakeDeps } from "./run.ts";

export interface RedoResult {
  ok: boolean;
  /** the lane that was taken out */
  from?: string;
  /** the lane opened in its place */
  iddId?: string;
  /** the lifecycle paths of the close and the new lane's open */
  wrote?: string[];
  /** the sessions and runs of the old lane stopped right here */
  stopped?: StopWorkResult;
  error?: string;
}

/**
 * `lane redo`: take a lane out and open a new one from the same Issue. The Issue is read again by name first, so a
 * closed, moved or ignored Issue (and a read that fails) leaves the lane as it was: penne can fix the Issue and
 * press again, and a lane is never closed with nothing to start in its place. Only then, inside one hold of the
 * lane gate, the old lane is closed (`lane_close`, outcome `redone`, `redo_to` the new lane) and the new lane's
 * backlog row and `lane_open` are written with `redo_of`, so the new lane goes to prep without the re-take card.
 * Another lane still holding the Issue stops the redo before that close, as a redo has nothing to add then. The
 * list is not touched (`idd unignore` is the way off it), and the old lane's sessions and runs are stopped after
 * the writes, outside the gate. The Issue is read and the runtime waited on outside the gate: neither holds other
 * lanes' writes.
 */
export async function redoLane(iddId: string, deps: LinearIntakeDeps = {}): Promise<RedoResult> {
  const rec = readBacklog().find((b) => b.idd_id === iddId);
  if (!rec) return { ok: false, error: `lane がありません: ${iddId}` };
  if (laneHasEnded(iddId, readLifecycle())) return { ok: false, error: `${iddId} は既に閉じています（同じ起票から始め直すには、起票を取り込み直してください）` };
  const key = issueKeyOf(rec);
  if (!key) return { ok: false, error: `${iddId} は起票の無い lane なので、始めからやり直せません` };
  const ref = issueRefOfUrl(key.url);
  if (!ref) return { ok: false, error: `起票の参照を読めません: ${key.url}` };

  const read = await readNamedIssue(ref, deps);
  if (!read.issue) return { ok: false, error: `起票を読み直せません: ${read.reason}` };
  const issue = read.issue;
  if (!sameKey(key, { url: issue.url, ...(issue.linearId ? { linearId: issue.linearId } : {}) })) {
    return { ok: false, error: `起票が別のものになっています（${key.url} → ${issue.url}）` };
  }

  const made = await withLaneGate(async (): Promise<
    { kind: "held"; id: string }
    | { kind: "refused"; reason: string }
    | { kind: "duplicate"; id: string }
    | { kind: "failed"; wrote: string[]; reason: string }
    | { kind: "opened"; iddId: string; wrote: string[] }
  > => {
    // another lane already holds the Issue: refuse before the close, so no lane is closed with nothing to open
    const held = laneHoldingIssue(issue, readBacklog(), closedLaneIds(), iddId);
    if (held) return { kind: "held", id: held.idd_id };
    const newId = `IDD-${String(nextIddId(readBacklog())).padStart(3, "0")}`;
    const closed = await transition(iddId, "lane_close", { outcome: "redone", redo_to: newId, at_by: "user" });
    if (!closed.ok) return { kind: "refused", reason: closed.reason };
    let opened: Awaited<ReturnType<typeof openLaneForIssue>>;
    try {
      opened = await openLaneForIssue(issue, { iddId, kind: "redo" });
    } catch (err) {
      // The close stands: taking it back would leave a lane a tick may already have taken for ended. The failure
      // is kept on the lane and told to the caller with the way out (taking the Issue in again opens a lane).
      const reason = String((err as Error)?.message ?? err).slice(0, 300);
      await appendLifecycle("lane_redo_failed", iddId, { redo_to: newId, reason }).catch(() => {});
      return { kind: "failed", wrote: [closed.path], reason };
    }
    if ("duplicate" in opened) return { kind: "duplicate", id: opened.duplicate };
    return { kind: "opened", iddId: opened.added, wrote: [closed.path, opened.wrote] };
  });
  if (made.kind === "held" || made.kind === "duplicate") return { ok: false, error: `同じ起票の lane が既に開いています: ${made.id}` };
  if (made.kind === "refused") return { ok: false, error: made.reason };

  // the lane is closed either way: what still runs for it stops, and the caller is told how to recover from a
  // failure that left no new lane (the tick catches the same up when this is not run)
  const stopped = await stopLaneWork(iddId, { via: "redo" }).catch((): StopWorkResult => ({ sessions: [], runs: [], failed: [] }));
  if (made.kind === "failed") {
    return {
      ok: false,
      from: iddId,
      wrote: made.wrote,
      stopped,
      error: `lane は閉じましたが、新しい lane を開けませんでした（${made.reason}）。同じ起票から始め直すには、その起票を取り込み直してください（取り込み直しのカードが出ます）`,
    };
  }
  return { ok: true, from: iddId, iddId: made.iddId, wrote: made.wrote, stopped };
}
