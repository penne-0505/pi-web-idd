
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { headCommit } from "../worktree/ensure.ts";
import { followupsOf, type FollowupItem } from "../ledger/review-loop.ts";
import { buildSubmit, submitOpenMessage, tryOpenSubmit } from "./ship.ts";
import { archiveLanePlan } from "./plan-archive.ts";
import type { CommitGate } from "./commit-gate.ts";
import type { FollowupEntry } from "./followups.ts";
import type { BacklogRecord } from "../schema/records.ts";
import { readProposal } from "../overlay/export.ts";
import { isLockRefusal, lock, remoteTip } from "../overlay/git.ts";
import { deriveStage } from "../ledger/derive.ts";
import { stagePick } from "../ledger/pick.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { recordPlaceFindings } from "./place-findings.ts";

export interface SubmitPrepResult {
  submitted: string[];
  errors: { iddId: string; error: string }[];
}

function idx(events: LifecycleRecord[], name: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === name) return i;
  return -1;
}

/** why a record is not made on a lane whose submit was pushed and waits for its PR */
const PUSHED = "提出が push まで進んでいます。lane の branch に commit を足すと、承認した内容と食い違って提出の再試行が止まるので、記録しません";

/**
 * Whether the lane's submit went out: its record says pushed, or it is still prepared but the commit it was to
 * push is already the tip of the public branch (a push whose record was not written back). A prepared submit
 * with a commit to push whose remote cannot be asked (the network, the remote) is "unknown": the push may
 * have reached the server while the client saw an error.
 */
export function submitPushed(iddId: string): "yes" | "no" | "unknown" {
  const p = readProposal(iddId);
  // a push of an earlier round (waiting for its PR) does not stop a record on a newer head: the next submit supersedes it
  if (p?.status === "pushed") {
    const now = p.work ? headCommit(p.work) : null;
    return now && now !== p.head ? "no" : "yes";
  }
  if (p?.status !== "prepared" || !p.outputCommit) return "no";
  if (!p.upstream || !p.branch) return "unknown";
  try {
    return remoteTip(p.upstream, p.branch) === p.outputCommit ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/** why a record is not made while it cannot be told whether the submit's push reached the remote */
const PUSH_UNKNOWN = "提出の push が公開側に届いたかを確かめられないので、記録しません（届いていれば、branch に commit を足すと提出の再試行が止まる）";

/** the events that say what the harness did about a lane's plan references after the last S3 passed */
const REF_WORK_EVENTS = ["s3_plan_archived", "s3_plan_refs_fixed", "s3_plan_archive_failed"];

/**
 * Note on the lane that the plan could not be archived (or its references could not be fixed) with this reason.
 * The tick tries the lane again on every pass, so a failure that stays the same is not written again; a success
 * after it, a different reason, or no earlier word about it is.
 */
async function noteArchiveFailure(iddId: string, evs: LifecycleRecord[], reason: string): Promise<void> {
  const ready = idx(evs, "s3_ready");
  let last: LifecycleRecord | undefined;
  for (let i = ready + 1; i < evs.length; i += 1) if (REF_WORK_EVENTS.includes(evs[i].event)) last = evs[i];
  if (last?.event === "s3_plan_archive_failed" && String(last.attrs?.reason ?? "") === reason) return;
  await appendLifecycle("s3_plan_archive_failed", iddId, { reason });
}

const submitKey = (iddId: string) => {
  const p = readProposal(iddId);
  return p ? `${p.status}:${p.token}` : "";
};

/**
 * The gate a record's commit takes: the repo's overlay lock, the pushed check, and the submit not moving under it.
 * The check runs outside it; the commit holds it only while writing the branch.
 */
function recordGate(iddId: string, worktree: string, seen: string): CommitGate {
  let release: () => void;
  try {
    release = lock(worktree);
  } catch (err) {
    const message = String((err as Error).message ?? err);
    // any overlay lock refusal (the checks running included) is a wait: the record is made later (DEC-2328)
    return isLockRefusal(err)
      ? { refuse: `repo の overlay の lock が取られているので commit していません: ${message}`, later: true }
      : { refuse: `repo の overlay の lock を取れないので commit していません: ${message}`, later: false };
  }
  // held from here: anything that throws lets it go
  try {
    const now = submitPushed(iddId);
    if (now !== "no") {
      release();
      return now === "yes" ? { refuse: PUSHED, later: false } : { refuse: PUSH_UNKNOWN, later: true };
    }
    if (submitKey(iddId) !== seen) {
      release();
      return { refuse: "記録の検査の間に提出の確認が動いたので commit していません（次の機会に記録し直す）", later: true };
    }
  } catch (err) {
    release();
    return { refuse: `提出の記録を読めないので commit していません: ${String((err as Error).message ?? err).slice(0, 300)}`, later: false };
  }
  return { release };
}

/** the follow-up keys a lane has already written, read from its lifecycle records */
function writtenFollowupKeys(evs: LifecycleRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const e of evs) {
    if (e.event !== "s3_followups_written") continue;
    const entries = Array.isArray(e.attrs?.entries) ? (e.attrs!.entries as { claim?: unknown; path?: unknown }[]) : [];
    for (const x of entries) keys.add(`${String(x.path ?? "")}|${String(x.claim ?? "")}`);
  }
  return keys;
}

/**
 * The follow-ups still to record: this pass's, and every item an earlier record left unwritten, minus what was
 * recorded. An earlier failure is carried into a later record, so it never disappears.
 */
function pendingFollowups(evs: LifecycleRecord[]): FollowupItem[] {
  const written = writtenFollowupKeys(evs);
  const out: FollowupItem[] = [];
  const seen = new Set<string>();
  const push = (i: FollowupItem) => {
    const k = `${i.path ?? ""}|${i.claim}`;
    if (written.has(k) || seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  for (const e of evs) {
    if (e.event !== "s3_followups_not_written") continue;
    const entries = Array.isArray(e.attrs?.entries) ? (e.attrs!.entries as { severity?: unknown; judgedSeverity?: unknown; claim?: unknown; path?: unknown; source?: unknown }[]) : [];
    for (const x of entries) {
      if (typeof x.claim !== "string" || !x.claim) continue;
      const source = x.source === "unsent" || x.source === "r2" ? { source: x.source as FollowupItem["source"] } : {};
      push({ severity: String(x.severity ?? "should") || "should", ...(typeof x.judgedSeverity === "string" && x.judgedSeverity ? { judgedSeverity: x.judgedSeverity } : {}), claim: x.claim, ...(x.path ? { path: String(x.path) } : {}), ...source });
    }
  }
  for (const i of followupsOf(evs)) push(i);
  return out;
}

/**
 * Record the follow-ups on the lane's own records, before the submit card opens. Nothing goes into a TODO and
 * nothing is committed on the lane's branch: the follow-ups live on the lifecycle, and the submit card and the
 * conflict scope list read them from there. It never holds the submit: a record that cannot be made leaves the
 * lane as it was and reports it, and items already recorded are skipped.
 */
async function recordFollowups(rec: BacklogRecord, evs: LifecycleRecord[], extra: Record<string, unknown> = {}): Promise<{ written: boolean; entries: FollowupEntry[]; reason?: string }> {
  const items = pendingFollowups(evs);
  if (!items.length) return { written: false, entries: [] };
  // the place findings are recorded before the follow-up record and apart from its success: a broken column never
  // costs the lane the finding, and a follow-up record that cannot be made never holds the submit
  try {
    const placed = await recordPlaceFindings({ repo: rec.area, lane: rec.idd_id, events: evs, followups: items });
    if (!placed.ok) console.warn(`[submit-prep] ${rec.idd_id} の指摘を記録できませんでした: ${placed.error}`);
  } catch (err) {
    console.warn(`[submit-prep] ${rec.idd_id} の指摘を記録できませんでした: ${String(err).slice(0, 300)}`);
  }
  const entries: FollowupEntry[] = items.map((i) => ({ severity: i.severity, ...(i.judgedSeverity ? { judgedSeverity: i.judgedSeverity } : {}), claim: i.claim, ...(i.path ? { path: i.path } : {}), ...(i.source ? { source: i.source } : {}) }));
  try {
    await appendLifecycle("s3_followups_written", rec.idd_id, { entries, ...extra });
  } catch (err) {
    const reason = String((err as Error).message ?? err).slice(0, 300);
    console.warn(`[submit-prep] ${rec.idd_id} の follow-up を記録できませんでした: ${reason}`);
    return { written: false, entries, reason };
  }
  return { written: true, entries };
}

/**
 * penne's second try at a follow-up record that did not go in: the same record as the tick's, for a lane at the
 * submit card. It goes on the lifecycle marked `retry`, whether it goes in or stops again. Items already recorded
 * are left as they are, and nothing is committed on the branch.
 */
export async function rerecordFollowups(iddId: string): Promise<RerecordResult> {
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return { ok: false, error: `lane ${iddId} がありません` };
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  if (evs.some((e) => ["lane_close", "s1_defer", "s3_defer"].includes(e.event))) return { ok: false, error: "終了した lane です" };
  if (deriveStage(evs).decision !== "ship") return { ok: false, error: "提出前確認の段にある lane だけ記録し直せます" };
  // a follow-up of this pass, or one an earlier pass recorded as not written: otherwise there is nothing to rewrite
  if (followupsOf(evs).length === 0 && !evs.some((e) => e.event === "s3_followups_not_written")) return { ok: false, error: "follow-up にした指摘がありません" };
  const pushed = submitPushed(iddId);
  if (pushed !== "no") return { ok: false, error: pushed === "yes" ? PUSHED : PUSH_UNKNOWN };
  const out = await recordFollowups(rec, evs, { retry: true, at_by: "user" });
  if (!out.entries.length) return { ok: true, already: true, files: [], commit: "" };
  if (!out.written) return { ok: false, error: out.reason ?? "follow-up を記録できませんでした" };
  return { ok: true, files: [], commit: "" };
}

export type RerecordResult =
  | { ok: true; files: string[]; commit: string; already?: true }
  | { ok: false; error: string; detail?: string };

/**
 * Open the submit card of a lane that passed S3, from the tick. It never throws: a lane whose card did not open is
 * put on the tick's failures with its reason, and the tick goes on with its other lanes and stages. A reason other
 * than a busy gate is also recorded on the lane, once while it stays the same: the tick tries the lane again on every
 * pass, and the same failure is not written again for the same pass of S3.
 */
async function openSubmitFromTick(iddId: string, result: SubmitPrepResult): Promise<void> {
  const opened = await tryOpenSubmit(iddId);
  if (!("error" in opened)) {
    result.submitted.push(iddId);
    return;
  }
  result.errors.push({ iddId, error: submitOpenMessage("提出前確認を開けませんでした", opened) });
  // a busy gate clears by itself: the lane's record is not filled with it
  if (opened.kind === "busy") return;
  try {
    const evs = readLifecycle().filter((e) => e.idd_id === iddId);
    const last = [...evs].reverse().find((e) => e.event === "s4_submit_open_failed");
    const said = last && evs.indexOf(last) > idx(evs, "s3_ok") && last.attrs?.reason === opened.error;
    if (!said) await appendLifecycle("s4_submit_open_failed", iddId, { reason: opened.error, kind: opened.kind });
  } catch (err) {
    // the record is only a note: a fault that keeps it from being written is said on the tick's failures already
    console.warn(`[submit-prep] ${iddId} の提出前確認の失敗を記録できませんでした: ${String(err).slice(0, 300)}`);
  }
}

/**
 * S3 for lanes that went through the S2 review loop: there is no diff card. After the conflict check, move the
 * work instruction to the archive, record the follow-ups, then record S3 as passed and open the submit card, which
 * carries the loop's outcome, the device check and conflicts for penne to judge in one place.
 */
export async function runSubmitPrep(): Promise<SubmitPrepResult> {
  const result: SubmitPrepResult = { submitted: [], errors: [] };
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of readLifecycle()) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  for (const rec of inStartOrder(readBacklog())) {
    const evs = byLane.get(rec.idd_id) ?? [];
    // a lane that passed S3 whose submit card did not open (its start found the lane gate busy, or failed): open it
    // now, whoever passed it. This stage passes a loop lane; penne passes the others on the S3 card, whose decision
    // opens the card only once and says on the screen when it could not
    // the stage asks its own question, at the moment it asks it (C-199-2)
    const answer = stagePick("submit_prep", evs);
    if (answer.branch === "reopen") {
      await openSubmitFromTick(rec.idd_id, result);
      continue;
    }
    if (!answer.pick) continue;
    try {
      // the work instruction leaves the permanent records before the submit (DEC-2646): a move that does not go
      // through holds the lane, so the plan never reaches the mainline beside the records
      const laneWorktree = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop()?.worktree_path;
      if (laneWorktree) {
        const archived = archiveLanePlan(rec, laneWorktree, { beforeCommit: () => recordGate(rec.idd_id, laneWorktree, submitKey(rec.idd_id)) });
        if ("error" in archived) {
          result.errors.push({ iddId: rec.idd_id, error: archived.error });
          // a lock refusal is a wait: the lane's record is not filled with it
          if (!archived.later) {
            try {
              await noteArchiveFailure(rec.idd_id, evs, archived.error);
            } catch (err) {
              // the note is only a note: a fault that keeps it from being written is said on the tick's failures already
              console.warn(`[submit-prep] ${rec.idd_id} の archive の失敗を記録できませんでした: ${String(err).slice(0, 300)}`);
            }
          }
          continue;
        }
        if ("moved" in archived && archived.moved) await appendLifecycle("s3_plan_archived", rec.idd_id, { from: archived.from, to: archived.to, commit: archived.commit, files: archived.files });
        else if ("repaired" in archived) await appendLifecycle("s3_plan_refs_fixed", rec.idd_id, { files: archived.files, commit: archived.commit });
      }
      // the follow-ups are recorded on the lane's own records before the card opens; a record that cannot be made
      // never holds the submit
      await recordFollowups(rec, readLifecycle().filter((e) => e.idd_id === rec.idd_id));
      // S3 is recorded as passed only once the submit card can actually be built; otherwise retry next tick
      if (!buildSubmit(rec.idd_id)) {
        result.errors.push({ iddId: rec.idd_id, error: "提出前確認を組み立てられません（executor の worktree を確認）" });
        continue;
      }
      await appendLifecycle("s3_ok", rec.idd_id, { at_by: "auto", reason: "S2 のレビューが収束し、差分確認は提出前確認に統合" });
      await openSubmitFromTick(rec.idd_id, result);
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String(err) });
    }
  }
  return result;
}
