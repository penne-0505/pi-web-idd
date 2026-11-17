import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { deriveStage } from "../ledger/derive.ts";
import { stagePick } from "../ledger/pick.ts";
import { applyDecision } from "../ledger/write.ts";
import { goBlockedReason } from "../ledger/blockers.ts";
import { foldRows, intentColumnPath, laneStates, raisedByLane, readRows, type ChoiceView, type IntentRow, type PurposeView } from "../intent/store.ts";
import { routingInFlight } from "../agent/question-routing.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import type { Depth } from "./depth.ts";
import { laneDepth } from "./depth-read.ts";
import { laneDepthFromEvents } from "./depth.ts";

/**
 * The engine's automatic GO for a shallow lane. A lane whose plan is small, touches no dangerous path and asks no
 * judgement of a person should not wait for one: the engine records the GO itself, through the same door and the
 * same gate a person's GO uses, with `at_by: auto` and the reason. Anything the engine can read that points at a
 * judgement a person should make sends the lane back to the human GO; so does an answer the engine cannot read.
 */

export interface AutoGoInput {
  lane: string;
  events: LifecycleRecord[];
  depth: Depth;
  purposes: PurposeView[];
  choices: ChoiceView[];
  rows: IntentRow[];
  /** a blocker not landed holds the GO for the engine as for a person */
  blocked?: boolean;
  /** the judge still holds a batch of this lane's questions: they are not yet on record, so the lane is not one with none */
  routing?: boolean;
}

export interface AutoGoDecision {
  auto: boolean;
  /** why the lane was left to a person (shown on the GO card); absent when the engine records the GO itself */
  reason?: string;
}

/**
 * Whether the engine may record this lane's GO. The conditions are the three marks of a plan a person should see
 * (a question, an unconfirmed Purpose the lane raised, a root/dir Choice it would supersede) plus the plan the lane
 * now shows having a review that finished: an unreviewed plan has no reader but the person. The decision is
 * folded by the MoonBit module, so the tick's automatic GO and the card's answer cannot disagree (C-199-1).
 */
export function autoGoDecision(input: AutoGoInput): AutoGoDecision {
  // a question held by the judge is on no record yet: passing the lane now would send its answer to a person after the GO
  if (input.routing) return { auto: false, reason: ROUTING_HOLD_REASON };
  const answer = stagePick("auto_go", input.events, {
    lane: input.lane,
    depth: input.depth,
    blocked: input.blocked ?? false,
    purposes: input.purposes.map((p) => ({ status: p.status, raisedBy: raisedByLane(p.raised.by) })),
    choices: input.choices.map((c) => ({ id: c.id, places: c.place })),
    laneRows: input.rows
      .filter((r) => (r.event === "choice_raised" || r.event === "choice_superseded") && raisedByLane(r.by) === input.lane)
      .map((r) => ({ supersedes: (Array.isArray(r.supersedes) ? (r.supersedes as { id?: string }[]) : []).map((s) => s.id ?? "").filter(Boolean) })),
  });
  if (answer.pick) return { auto: true };
  return { auto: false, reason: answer.reason ?? "GO は人が押す" };
}

/** why a lane is not passed while the judge reads its questions */
export const ROUTING_HOLD_REASON = "計画役の質問を振り分けている最中なので、結果が出てから GO を判断する";

export interface AutoGoResult {
  recorded: string[];
  errors: { iddId: string; error: string }[];
}

/** the plain reason an automatically recorded GO carries */
export const AUTO_GO_REASON = "深さが浅く、質問・未確認の Purpose の案・root か dir の Supersede が無く、計画の査読が済んでいる";

/**
 * Record the automatic GO for every shallow lane waiting at GO whose conditions allow it. The GO goes through
 * `applyDecision`, so the same gate a person's GO passes checks the lane's stage; a lane whose records cannot be
 * read (an exception anywhere in the reading) is left to the person.
 */
export async function runAutoGo(): Promise<AutoGoResult> {
  const result: AutoGoResult = { recorded: [], errors: [] };
  const all = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of all) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  const states = laneStates(all);
  for (const rec of readBacklog()) {
    const evs = byLane.get(rec.idd_id) ?? [];
    try {
      // the stage asks its own question, at the moment it asks it (C-199-2). The stage's answer is read first, so
      // the depths and the intent column are only read for the lanes that wait at the GO.
      if (deriveStage(evs).decision !== "go") continue;
      // a blocker not landed holds the GO for the engine as for a person: the write side would refuse, and the card
      // shows the wait, so the lane is left without an error line on every tick
      const blocked = Boolean(goBlockedReason(rec.idd_id));
      const worktree = readSessions("planner").filter((s) => s.idd_id === rec.idd_id).pop()?.worktree_path;
      const depth = worktree ? laneDepth(rec, worktree) : laneDepthFromEvents(evs);
      const rows = readRows(intentColumnPath(rec.area));
      // the lane's own side: its own raised rows are visible under its viewer, the same window the GO's write side
      // and the card use to list the Purpose proposals it must confirm (DEC-113-6)
      const folded = foldRows(rows, rec.idd_id, states);
      const decision = autoGoDecision({ lane: rec.idd_id, events: evs, depth, purposes: folded.purposes, choices: folded.choices, rows, blocked, routing: routingInFlight(rec.idd_id) });
      if (!decision.auto) continue;
      const written = await applyDecision("s1_go", { iddId: rec.idd_id, atBy: "auto", reason: AUTO_GO_REASON });
      if (!written.ok) {
        result.errors.push({ iddId: rec.idd_id, error: written.error ?? "GO を記録できません" });
        continue;
      }
      result.recorded.push(rec.idd_id);
    } catch (err) {
      // a condition the engine cannot read is handed to the person, never read as "clear"
      result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err) });
    }
  }
  return result;
}
