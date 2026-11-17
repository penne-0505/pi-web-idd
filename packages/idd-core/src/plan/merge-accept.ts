import { readAreas } from "../config/areas.ts";
import { withoutNotes } from "../ledger/derive.ts";
import { readLifecycle } from "../ledger/read.ts";
import { transition } from "../ledger/write.ts";
import { laneLocations } from "../overlay/export.ts";
import { clean, git, sha } from "../overlay/git.ts";
import { COMMAND_GRACE_SECONDS, DEFAULT_CHECK_MINUTES, SETUP_MINUTES } from "../overlay/gate.ts";
import { importStand, importedCurrent } from "../overlay/import.ts";
import { syncArea, type SyncResult } from "../overlay/sync.ts";
import { lanesAwaitingMerge, runClose, type CloseResult } from "./close.ts";
import { MERGE_ACCEPT_SOURCE, acceptHold, answerMark } from "./merge-hold.ts";
import type { LifecycleRecord } from "../schema/records.ts";

/**
 * How far into a tick's run (from its lock) the acceptance may still start the checks of a receive. The timer's
 * unit is cut at 20 minutes (`TimeoutStartSec` in install/units.ts), and a cut tick leaves the overlay lock held by a
 * process that is gone, which stops every later overlay step of the repo. The stage starts a receive only when the
 * longest its commands can run (each one's limit and the grace past it) ends inside this. It is the unit's 20 minutes
 * less 2, which the receive spends outside the commands: cutting the copy, reading the result and releasing the lock.
 */
export const ACCEPT_UNTIL_MINUTES = 18;

/**
 * The longest one receive may run at all. A repo whose commands can run longer than this is never started by the tick
 * (a card sends it to `idd sync`); this is the 17 minutes the contract names, not the deadline above: a receive of
 * exactly this long still starts, but only in the first minute of a tick's run.
 */
export const ACCEPT_WORST_MINUTES = 17;

/** the stage name the halt record and the card show */
const STAGE = "本流の受け入れ・記録回収";

export interface AcceptResult {
  /** repos whose receive was tried on this pass */
  tried: string[];
  /** lanes this pass closed */
  closed: string[];
  /** lanes a card was raised for (a stop whose card shows the same reason is not raised again) */
  stopped: { iddId: string; reason: string }[];
  /** repos left for a later pass: the overlay was busy, or the pass had no time left for their checks */
  waiting: string[];
  errors: number;
}

/** the longest one command can run: its limit rounded up to the second as the run does, and the grace past it */
function commandWorstMinutes(limit: number): number {
  return (Math.max(1, Math.ceil(limit * 60)) + COMMAND_GRACE_SECONDS) / 60;
}

/** the longest the commands of a receive in this repo can run (each setup command and each check, with its grace), in minutes */
export function acceptWorstMinutes(area: string): number {
  const file = readAreas();
  const prep = file.checkPrep?.[area];
  const checks = (file.areas[area]?.checks ?? []).filter((c) => c.applicable !== false && c.command?.length);
  const setup = (prep?.setup ?? []).reduce((n) => n + commandWorstMinutes(SETUP_MINUTES), 0);
  return checks.reduce((n, c) => n + commandWorstMinutes(prep?.timeouts[c.name] ?? DEFAULT_CHECK_MINUTES), 0) + setup;
}

/** where the lane's own checkout stands (its records are reclaimed from there), as a line of the stop's stand */
function laneStand(iddId: string): string {
  try {
    const loc = laneLocations(iddId);
    if (!loc) return "lane=none";
    return `lane=${sha(loc.work)} lane-clean=${clean(loc.work)}`;
  } catch {
    return "lane=?";
  }
}

/** which step a stop was raised by: the receive (and what it checks) or the close pass (the records and the work branch) */
type StopKind = "accept" | "close";

/**
 * where the receive and the lane stand now, led by the kind of the stop it is read for: a stopped lane is tried again
 * when this differs from the stand it stopped at. The public tip is not in it: a commit there is not a sign that the
 * cause was cleared. The work branch's tip is in it only for a stop of the close pass, whose way out is to put the
 * records into the work branch; a stop of the receive is cleared in the recovery, the settings or the checkout, and
 * another lane's receive moving the tip would run the same failing checks again and add the same stop.
 */
function standOf(area: string, iddId: string, kind: StopKind): string {
  return `${kind} ${importStand(area, { work: kind === "close" })} ${laneStand(iddId)}`;
}

/** whether the stop up for the lane has been cleared: its stand, read the way it was written, differs. A stand with no kind (written before the kinds) differs once */
function standMoved(area: string, iddId: string, held: string): boolean {
  const kind = held.split(" ", 1)[0];
  if (kind !== "accept" && kind !== "close") return true;
  return held !== standOf(area, iddId, kind);
}

/** the merge of the lane's PR is on record and the lane has not closed */
function mergeRecorded(events: LifecycleRecord[]): boolean {
  const names = events.map((e) => e.event);
  return names.lastIndexOf("s4_merged") > names.lastIndexOf("s4_pr_created");
}

function stopReason(area: string, result: SyncResult): string {
  const cfg = readAreas().areas[area];
  if (result.stop === "conflict") return `公開本流の受け入れが衝突しています。直す場所: ${result.recovery ?? cfg?.local_path}（衝突を解いて commit すると、次の巡が読み直して受け入れます）`;
  if (result.stop === "checks") return `公開本流の受け入れの必須の検査が通りません: ${result.error?.replace(/^必須の検査が通りません: /, "")}。直す場所: ${result.recovery ?? cfg?.local_path}（直して commit するか、card の「やり直す」で読み直させてください）`;
  // a receipt with a person's work in its recovery (a resolution, a fix) is not cut again when the public branch moves past it: a person decides
  if (result.error?.includes("公開先が再更新されました")) return `公開本流を受け入れられません: ${result.error}。直す場所: ${cfg?.local_path}（受け入れ準備に人の変更（衝突の解消や検査の修正）が入っているので、自動では作り直しません。idd cancel-import ${area} で捨てて、新しい先端からやり直してください）`;
  return `公開本流を受け入れられません: ${result.error}。直す場所: ${cfg?.local_path}`;
}

/** the places a failed reclaim without a recovery can be waiting on: the work branch (not on its branch, or not clean) and the lane's own checkout (not clean) */
function reclaimPlaces(iddId: string): string[] {
  try {
    const loc = laneLocations(iddId);
    if (!loc) return [];
    const main = loc.config.local_path;
    const places: string[] = [];
    if (main && (git(main, ["branch", "--show-current"]).trim() !== loc.config.work_base || !clean(main))) places.push(`作業本流 ${main}`);
    if (!clean(loc.work)) places.push(`lane の作業ツリー ${loc.work}`);
    // a cause that is in neither (the manifest, the lock) is not told apart here: both places are named
    return places.length ? places : [...(main ? [`作業本流 ${main}`] : []), `lane の作業ツリー ${loc.work}`];
  } catch {
    return [];
  }
}

/**
 * Why a lane that is merged cannot close, from the close pass: the records or the work branch or the lane's own checkout need a hand.
 * A records conflict is resolved in the recovery worktree the reclaim cut. A reclaim that stopped before cutting one
 * is waiting on the work branch, the lane's checkout or both, and the card names the one that is the cause.
 */
function closeStopReason(iddId: string, stop: CloseResult): string {
  if (stop.recovery) return `${stop.stopped}。直す場所: ${stop.recovery}（記録の衝突を解く worktree です。統合した内容を作業本流に入れると、次の巡が読み直します）`;
  const places = reclaimPlaces(iddId);
  return `${stop.stopped}。直す場所: ${places.length ? places.join("、") : "作業本流と lane の作業ツリー"}`;
}

/**
 * Raise the card for a merged lane that cannot go on: a halt record on the lane, which the fold reads as the stop the
 * Inbox shows. Written through the lane's gate, and only if penne has not answered the lane since `mark` (the pass
 * read the lane before its slow work): her answer and the engine's try are never both written on one read.
 * A stop already up with the same reason and the same stand writes nothing, so the card stays one.
 */
async function raise(area: string, iddId: string, kind: StopKind, reason: string, mark: number, result: AcceptResult): Promise<void> {
  const events = readLifecycle().filter((e) => e.idd_id === iddId);
  const stand = standOf(area, iddId, kind);
  const hold = acceptHold(events);
  if (hold && hold.reason === reason && hold.stand === stand) return;
  const last = withoutNotes(events).at(-1);
  const previous = hold ? events[events.map((e) => e.event).lastIndexOf("lane_stall_detected")] : undefined;
  const since = hold && hold.reason === reason ? String(previous?.attrs?.since ?? "") : "";
  const written = await transition(iddId, "lane_stall_detected", {
    source: MERGE_ACCEPT_SOURCE,
    stage: STAGE,
    since: since || new Date().toISOString(),
    last_event: { event: last?.event ?? "", at: last?.at ?? "" },
    reason,
    causes: [],
    can_send_back: false,
    stand,
  }, {
    require: (lane) => (answerMark(lane) === mark ? null : "penne が lane に答えたので、次の巡で読み直します"),
  });
  if (written.ok) result.stopped.push({ iddId, reason });
}

/**
 * The stage after the close pass: a lane whose PR was merged waits for the public branch to be received into the
 * work branch, its records reclaimed and the lane closed. A person used to type `idd sync` for that; here the tick does
 * it, for the repos that have such a lane and for no other (the receive moves the work branch, so a repo that waits
 * for nothing is left alone). The receive is the same `syncArea` the CLI runs, so a resolved conflict is read again in
 * one place. A stop (a conflict, a failing required check, an unclean work branch, records that cannot be reclaimed)
 * leaves the lane open and raises its card; the lane is not tried again under the card until its stand differs from
 * the one it stopped at (the cause was cleared by hand) or penne answers the card.
 * `closed` is what the tick's own close pass returned this pass; `tickStartedAt` is when the tick took its lock.
 */
export async function runMergeAccept(closed: CloseResult[] = [], tickStartedAt = Date.now()): Promise<AcceptResult> {
  const result: AcceptResult = { tried: [], closed: [], stopped: [], waiting: [], errors: 0 };
  const events = readLifecycle();
  const lanes = new Map<string, { iddId: string; mark: number; events: LifecycleRecord[] }[]>();
  for (const { rec } of lanesAwaitingMerge()) {
    const own = events.filter((e) => e.idd_id === rec.idd_id);
    if (!mergeRecorded(own)) continue;
    lanes.set(rec.area, [...(lanes.get(rec.area) ?? []), { iddId: rec.idd_id, mark: answerMark(own), events: own }]);
  }
  const lastClose = new Map(closed.map((c) => [c.iddId, c]));

  for (const [area, waiting] of lanes) {
    try {
      // a lane under its card is tried again only when something it stopped on has changed
      const due = waiting.filter((l) => {
        const hold = acceptHold(l.events);
        return !hold || standMoved(area, l.iddId, hold.stand);
      });
      if (!due.length) continue;
      const retry = new Set(due.filter((l) => acceptHold(l.events)).map((l) => l.iddId));
      const options = { keepHeld: true as const, retry };

      if (!importedCurrent(area)) {
        const worst = acceptWorstMinutes(area);
        const spent = (Date.now() - tickStartedAt) / 60_000;
        if (worst > ACCEPT_WORST_MINUTES) {
          // it can never fit under the tick: a person receives it (the card says where and how)
          const reason = `公開本流の受け入れの検査が最長 ${Math.ceil(worst)} 分かかり、tick の 1 巡に収まりません。直す場所: ${readAreas().areas[area]?.local_path} で idd sync ${area} を回してください`;
          for (const l of due) await raise(area, l.iddId, "accept", reason, l.mark, result);
          continue;
        }
        if (spent + worst > ACCEPT_UNTIL_MINUTES) {
          result.waiting.push(area);
          continue;
        }
        result.tried.push(area);
        const synced = await syncArea(area, options);
        if (synced.lockRefused || synced.retry) {
          result.waiting.push(area);
          continue;
        }
        if (!synced.ok) {
          const reason = stopReason(area, synced);
          for (const l of due) await raise(area, l.iddId, "accept", reason, l.mark, result);
          continue;
        }
        for (const c of synced.close ?? []) lastClose.set(c.iddId, c);
      } else if (retry.size) {
        result.tried.push(area);
        for (const c of await runClose(options)) lastClose.set(c.iddId, c);
      }

      const now = readLifecycle();
      for (const l of due) {
        if (now.some((e) => e.idd_id === l.iddId && e.event === "lane_close")) {
          result.closed.push(l.iddId);
          continue;
        }
        const stop = lastClose.get(l.iddId);
        if (stop?.stopped) await raise(area, l.iddId, "close", closeStopReason(l.iddId, stop), l.mark, result);
      }
    } catch (err) {
      result.errors += 1;
      console.warn(`[merge-accept] ${area} の受け入れを進められませんでした: ${String(err).slice(0, 400)}`);
    }
  }
  return result;
}
