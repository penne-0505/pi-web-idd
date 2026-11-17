import type { RiskRoute } from "../agent/port.ts";
import { DEFAULT_MAX_SHOULD_FIX } from "../config/review-defaults.ts";
import { DEPTH_TABLE_REFERENCE, isDepthReference, type Depth } from "../plan/depth-reference.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { returnsToPlan } from "./replan-view.ts";

/**
 * The S2 review loop, read from the lifecycle alone. After the executor's result:
 * blind (parallel) → triage → fix → executor → confirm → (triage → fix …) → final blind → triage →
 * converged → device check → S3. It stops only on stagnation (or the round cap), never on a fixed count.
 * A repo that runs its checks before the loop converges (`checks_before_converge`) runs its required public checks at
 * the head before the convergence is written (s2_checks_*): a check the lane made fail goes to the fix as a must and
 * the loop goes on to its next round; one that cannot be compared stops for penne.
 * Accepted nits are never a reason for another round: they stay on record for the submit card.
 * A final blind of the head a whole-diff blind already saw, judged within the limit, is skipped (converged);
 * under `high_risk_when: last` a High lane skips only a tree its High-risk role read to the end.
 * Feedback on the lane's PR (S4) re-enters it at the triage: feedback → fix → confirm → final blind → S3.
 * In that pass every accepted request is fixed and confirmed by its ref, nits included.
 * A blind round of a large diff may begin with a map of the routes a value passes through (s2_map_*), which only shapes its blinds.
 * A pass may close on accepted musts alone and cap its fix rounds, as its first blind recorded them (`passPolicy`);
 * whatever it accepted and no fix carried is then a follow-up (`followupsOf`).
 */

/**
 * The record a round that read nothing is written under: the head since the last round is only the mainline merged in,
 * so no line of it is unreviewed. A name of its own, because `s2_review_skipped` is a blind nobody was there to run
 * (no `s2_review_started` at all), and a reader of rounds and stages has to tell a lane whose review never ran from a
 * lane whose review closed and then took the mainline in.
 */
export const MERGE_ONLY_SKIP_EVENT = "s2_review_merged_skipped";

export const REVIEW_EVENTS = [
  "s2_review_started", "s2_review_findings", "s2_triage_started", "s2_triage_done", "s2_fix_sent",
  "s2_confirm_started", "s2_confirm_done", "s2_review_converged", "s2_review_escalated", "s2_review_resumed",
  "s2_review_skipped", MERGE_ONLY_SKIP_EVENT, "s2_device_started", "s2_device_done", "s2_device_skipped", "s4_review_comment_received",
  "s2_map_started", "s2_map_done", "s2_map_dropped",
  // the routes were drawn at a head the lane has left: they are dropped and drawn again at the new head
  "s2_map_head_moved",
  // the hand turn: penne takes the code and the lane waits, then says it is done and one review round runs
  "s2_hand_fixed",
  // the first review's mainline merge conflicted and the executor was asked to resolve it
  "s2_review_base_conflict",
  // the order check before the first review: waiting on the lanes ahead, and the ways it ends
  "s2_order_waiting", "s2_order_passed", "s2_order_released", "s2_order_limit", "s2_order_unknown",
  // the records check between the review's convergence and S3: its own verdict, its send-back to the executor,
  // and the round reopened when the executor changed code outside the records place
  "s2_intent_checked", "s2_records_conflict", "s2_records_instructed", "s2_records_reopened",
  // the repo's required checks at the head before the loop converges (`checks_before_converge`): the run, and what it found
  "s2_checks_started", "s2_checks_done",
] as const;

/** accepted should at or below this ends the loop (one nit-like should is tolerated); an accepted must never is */
export const ACCEPTED_LIMIT = 1;
/** consecutive failures to start a stage before the loop asks penne */
export const START_FAILURE_LIMIT = 3;
/**
 * How long a lane whose stage could not start waits before the next try. Ticks now come on every finished stage,
 * seconds apart, and without a gap a passing failure (a full disk, a network blip) would use up the limit at once.
 */
export const START_RETRY_MS = 5 * 60 * 1000;
/** safety cap on fix rounds; reaching it escalates instead of looping on */
export const MAX_FIX_ROUNDS = 8;

export type ReviewKind = "blind" | "final" | "device" | "kept";
/** what a triage judges: a review's findings, a confirm's leftovers, or feedback on the PR */
export type TriageKind = ReviewKind | "confirm" | "feedback";

export type ReviewLoopState =
  | { state: "idle" }
  /** map: the round's map is done (its routes, none when it failed or found nothing); absent before one ran. `head` is
   * the lane head the routes were drawn at, so a blind can tell when the diff moved out from under them */
  | { state: "start_blind"; kind: ReviewKind; round: number; map?: { routes: RiskRoute[]; head?: string }; /** penne let the High role's fallback run this final (a continue on a window wait) */ allowHighFallback?: boolean }
  | { state: "running_map"; kind: "blind" | "final"; round: number; runId: string; /** the lane head the map was started at */ head?: string }
  | { state: "running_blind"; kind: ReviewKind; round: number; runIds: string[] }
  | { state: "start_triage"; kind: TriageKind; round: number; inputs: string[] }
  | { state: "running_triage"; kind: TriageKind; round: number; runId: string }
  | { state: "send_fix"; round: number }
  | { state: "fixing"; round: number }
  | { state: "start_confirm"; round: number }
  | { state: "running_confirm"; round: number; runId: string }
  | { state: "start_device"; round: number }
  | { state: "running_device"; round: number; runId: string }
  | { state: "converge" }
  /** the repo's required checks run at `head` before the loop converges (a run of its own, `runId`) */
  | { state: "running_checks"; runId: string; head: string }
  /** penne took the code of a round whose fix budget ran out: the lane waits for `s2_hand_fixed`, then one review round runs */
  | { state: "awaiting_hand_fix"; round: number }
  /** the records check sent the lane back to fix its records: the lane waits for the executor's next result */
  | { state: "awaiting_records_fix"; round: number }
  /** the executor answered the records send-back: the records check runs again, and code changes reopen the review */
  | { state: "recheck_intent"; round: number }
  /** the mainline the first review would read was merged into the lane and conflicted: the executor was asked to resolve it */
  | { state: "awaiting_merge"; round: number }
  /** the lane waits for the lanes ahead of it to land before its first review (the trial merge conflicts) */
  | { state: "awaiting_order"; round: number; opponents: OrderOpponent[] }
  | { state: "escalated"; reason: string; retry?: ReviewLoopState; /** the stop is a High role held for Claude's windows: the loop tries the final again each tick (DEC-2766) */ quotaWait?: { role?: string; resetsAt?: number; reason: string } }
  | { state: "done" };

type Attrs = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export interface AcceptedItem { ref: string; severity: string; claim: string; path?: string; line?: number | null; fix?: string; impact?: string; action?: string; /** accept: why it is handled this way (followup / skip: the reason to answer the reviewer with) */ reason?: string; /** accept should, Issue lane: the harm the judgement gave for a recommended fix */ fix_basis?: string; /** the action the judgement wrote before the `triage` value read a fix without a basis back as a follow-up */ claimed_action?: string; /** the reviewer reports the finding was written in (their directory names), as the judgement named them */ from?: string[]; /** the weight the reviewer gave it, written by the harness from the report (empty when it could not be found) */ reported_severity?: string; /** the correction of penne's this finding repeats, as the judgement named it */ correction_ref?: string; /** read with penne's correction in place of the judgement's weight and handling */ corrected?: boolean; correction_reason?: string; /** the weight the judgement gave, kept beside the one penne set (only a corrected finding has it) */ judged_severity?: string }

/** a lane the order check waits on: its head at the check, and the files the trial merge could not take */
export interface OrderOpponent { lane: string; head?: string; files: string[] }

const HARM_KINDS: RiskRoute["harms"] = ["authority", "irreversible", "shown_vs_sent"];

/**
 * The routes of a map as a record holds them. The attrs are an untyped append-only log (a hand edit, a future
 * writer), so every field is checked: a route without a file or a question is left out, the rest defaulted.
 */
export function routesOf(v: unknown): RiskRoute[] {
  if (!Array.isArray(v)) return [];
  const out: RiskRoute[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const paths = Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
    if (!paths.length || typeof o.question !== "string" || !o.question) continue;
    const harms = Array.isArray(o.harms) ? o.harms.filter((h): h is RiskRoute["harms"][number] => HARM_KINDS.includes(h as RiskRoute["harms"][number])) : [];
    out.push({ id: typeof o.id === "string" && o.id ? o.id : `R-${out.length + 1}`, paths, question: o.question, harms });
  }
  return out;
}

export function acceptedOf(attrs: Attrs | undefined): AcceptedItem[] {
  return Array.isArray(attrs?.accepted) ? (attrs.accepted as AcceptedItem[]) : [];
}

/** the round and kind a finding came from: the judgement that accepted it, as its ref carries it (`1-blind/F-1`) */
export interface RefScope { round: number; kind: string }

/**
 * The key a ref is compared under. A judgement may cite a ref with its round-and-kind scope (`2-final/F-1`) or write
 * the bare name (`F-1`); both name the same finding. A bare name takes the scope it is read under, so the same bare
 * number in two rounds is never taken for the same finding. Without a scope the key is the bare name, as a round that
 * carries no depth reads every ref.
 */
export function refKey(ref: string, scope?: RefScope): string {
  const slash = ref.lastIndexOf("/");
  if (slash >= 0) return scope ? ref : ref.slice(slash + 1);
  return scope ? `${scope.round}-${scope.kind}/${ref}` : ref;
}

/** penne's correction of one accepted finding: the weight and the handling she set on the stuck card */
export interface Correction { ref: string; severity: "must" | "should" | "nit"; action: "fix" | "followup" | "skip"; reason: string }

/**
 * The corrections a `s2_review_resumed` recorded. An entry that names no ref, a weight or a handling the loop does not
 * know, or a must put off is skipped, not trusted: a must is the weight of what is fixed now.
 */
export function correctionsOf(attrs: Attrs | undefined): Correction[] {
  if (!Array.isArray(attrs?.corrections)) return [];
  return (attrs.corrections as unknown[]).flatMap((c) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return [];
    const r = c as Record<string, unknown>;
    const severity = r.severity;
    const action = r.action;
    if (severity !== "must" && severity !== "should" && severity !== "nit") return [];
    if (action !== "fix" && action !== "followup" && action !== "skip") return [];
    if (severity === "must" && action !== "fix") return [];
    if (typeof r.ref !== "string" || !r.ref) return [];
    return [{ ref: r.ref, severity, action, reason: typeof r.reason === "string" ? r.reason : "" }];
  });
}

/** the judgement a `s2_review_resumed` at `r` answered: the last judgement recorded before it */
function judgementBefore(events: LifecycleRecord[], r: number): number {
  for (let j = r - 1; j >= 0; j -= 1) if (events[j].event === "s2_triage_done" && !events[j].attrs?.failed) return j;
  return -1;
}

/** whether penne corrected a finding to one that is not fixed now and not followed up either: set aside */
export function isSetAside(x: AcceptedItem): boolean {
  return x.corrected === true && !fixesNow(x);
}

/**
 * What a judgement accepted, with penne's corrections read in place of its own weight and handling.
 *
 * A correction reaches a finding two ways. The judgement the stuck card was about is corrected by the ref the card
 * showed. A later judgement names the correction a finding repeats (`correction_ref`, which it writes when the
 * finding has the same nature as one penne decided), and reads that correction. What an earlier round sent to the fix
 * is not added back: a fix that did not hold is found again by a later blind, from the diff. The review-loop counts,
 * the fix scope and the leftovers all read the judgement through this one function.
 */
export function acceptedAt(events: LifecycleRecord[], i: number): AcceptedItem[] {
  const a = events[i]?.attrs ?? {};
  const base = acceptedOf(a);
  // a depth-bearing round scopes every ref by its round and kind; the legacy confirm path keeps the bare name
  const here: RefScope | undefined = passPolicy(events, i).depth !== undefined
    ? { round: num(a.round), kind: String(a.kind ?? "blind") }
    : undefined;
  const scoped = here ? base.map((x) => ({ ...x, ref: refKey(x.ref, here) })) : base;
  // the corrections of every answer, in the order they were given: a later one on the same ref wins
  const answers: { target: number; at: number; correction: Correction }[] = [];
  for (let r = 0; r < events.length; r += 1) {
    if (events[r].event !== "s2_review_resumed") continue;
    const target = judgementBefore(events, r);
    for (const correction of correctionsOf(events[r].attrs)) answers.push({ target, at: r, correction });
  }
  if (!answers.length) return scoped;
  return scoped.map((x) => {
    const cited = typeof x.correction_ref === "string" ? x.correction_ref : "";
    let hit: Correction | undefined;
    for (const answer of answers) {
      const direct = answer.target === i && answer.correction.ref === x.ref;
      const repeats = cited !== "" && answer.at < i && answer.correction.ref === cited;
      if (direct || repeats) hit = answer.correction;
    }
    if (!hit) return x;
    return { ...x, judged_severity: x.severity, severity: hit.severity, action: hit.action, corrected: true, ...(hit.reason ? { correction_reason: hit.reason } : {}) };
  });
}

/** the weight the judgement gave, as a field, when penne set another */
function judgedWeight(x: AcceptedItem): { judgedSeverity?: string } {
  return x.judged_severity && x.judged_severity !== x.severity ? { judgedSeverity: x.judged_severity } : {};
}

/** the opponents an order wait recorded, as the record holds them (a malformed entry is skipped, not trusted) */
export function orderOpponentsOf(attrs: Attrs | undefined): OrderOpponent[] {
  if (!Array.isArray(attrs?.opponents)) return [];
  return (attrs.opponents as unknown[]).flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    if (typeof r.lane !== "string" || !r.lane) return [];
    return [{ lane: r.lane, ...(typeof r.head === "string" && r.head ? { head: r.head } : {}), files: strs(r.files) }];
  });
}

/** a lane's order position: when it first came to the order judgement, and the id that breaks a tie */
export interface LaneOrder { at: number; lane: string }

/** the events that record a lane's position when the check ends without a wait */
const ORDER_RECORDED = ["s2_order_passed", "s2_order_released", "s2_order_limit", "s2_order_unknown"] as const;

/** the number of an id like `IDD-086`: its trailing digits, or undefined when it has none */
function laneNumberOf(lane: string): number | undefined {
  const m = /(\d+)\s*$/.exec(lane);
  return m ? Number(m[1]) : undefined;
}

/**
 * The position a lane took when it first came to the order judgement: the first wait's clock, a determined
 * record's time (in ms when the writer left one, else the record's second-resolution time), or the first
 * review's time for a lane that never had the check. Undefined while the lane is still implementing, so a lane
 * with no position is not an opponent. The position is kept once taken, so a rewritten or released wait and a
 * changed opponent do not move the lane.
 */
export function orderPositionOf(events: LifecycleRecord[]): LaneOrder | undefined {
  const lane = events[0]?.idd_id ?? "";
  for (const e of events) {
    let at: number;
    if (e.event === "s2_order_waiting") at = Date.parse(String(e.attrs?.since ?? e.at));
    else if ((ORDER_RECORDED as readonly string[]).includes(e.event)) {
      const raw = e.attrs?.order_at;
      at = typeof raw === "number" ? raw : Date.parse(String(raw ?? e.at));
    } else if (e.event === "s2_review_started" || e.event === "s2_map_started") at = Date.parse(e.at);
    else continue;
    if (Number.isFinite(at)) return { at, lane };
  }
  return undefined;
}

/** the total order of positions: the earlier time first, and the smaller lane number when two arrive at once */
export function compareOrder(a: LaneOrder, b: LaneOrder): number {
  if (a.at !== b.at) return a.at - b.at;
  const an = laneNumberOf(a.lane);
  const bn = laneNumberOf(b.lane);
  if (an !== undefined && bn !== undefined && an !== bn) return an - bn;
  return a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0;
}

/** the lanes a lane recorded in its last wait: the edge the rank walks */
function lastOpponents(events: LifecycleRecord[]): string[] {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === "s2_order_waiting") return orderOpponentsOf(events[i].attrs).map((o) => o.lane);
  return [];
}

/**
 * The place this lane holds among the lanes it collides with: one plus the lanes still waiting that its opponents
 * (and their opponents) lead to. A lane already in review is not counted, a wait outside the chain is not
 * reached, and a cycle in the records (a hand edit) is walked once.
 */
export function orderRankOf(iddId: string, byLane: Map<string, LifecycleRecord[]>): number {
  const seen = new Set<string>([iddId]);
  const queue = lastOpponents(byLane.get(iddId) ?? []);
  let waiting = 0;
  while (queue.length) {
    const lane = queue.shift()!;
    if (seen.has(lane)) continue;
    seen.add(lane);
    const evs = byLane.get(lane) ?? [];
    if (reviewLoopState(evs).state === "awaiting_order") waiting += 1;
    queue.push(...lastOpponents(evs));
  }
  return waiting + 1;
}

/** a judgement's rejected items, as the record holds them */
export interface RejectedItem { ref?: string; severity?: string; claim: string; reason?: string; followup?: boolean; no_request?: boolean }

export function rejectedOf(attrs: Attrs | undefined): RejectedItem[] {
  return Array.isArray(attrs?.rejected) ? (attrs.rejected as RejectedItem[]).filter((r) => r && typeof r.claim === "string") : [];
}

/** a finding the triage found undoing an earlier round's fix: not fixed, but put to penne as a boundary to decide */
export interface OscillationItem { ref: string; severity: string; claim: string; path?: string; reason?: string; prior_ref: string; prior: string; current: string }

/** the reversals a triage recorded; a malformed entry (a hand-edited record) is skipped, not trusted */
export function oscillationsOf(attrs: Attrs | undefined): OscillationItem[] {
  if (!Array.isArray(attrs?.oscillations)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (attrs.oscillations as unknown[]).flatMap((o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return [];
    const r = o as Record<string, unknown>;
    return [{
      ref: str(r.ref), severity: str(r.severity), claim: str(r.claim), prior_ref: str(r.prior_ref), prior: str(r.prior), current: str(r.current),
      ...(str(r.path) ? { path: str(r.path) } : {}), ...(str(r.reason) ? { reason: str(r.reason) } : {}),
    }];
  });
}

/** penne's decision on a reversal, recorded with the continue: which position, and the boundary in words */
export interface BoundaryDecision { ref: string; choice: "prior" | "current" | "custom"; text: string }

export function boundariesOf(attrs: Attrs | undefined): BoundaryDecision[] {
  if (!Array.isArray(attrs?.boundaries)) return [];
  return (attrs.boundaries as unknown[]).flatMap((b) => {
    if (!b || typeof b !== "object") return [];
    const r = b as Record<string, unknown>;
    const choice = r.choice === "prior" || r.choice === "current" || r.choice === "custom" ? r.choice : undefined;
    return choice && typeof r.ref === "string" ? [{ ref: r.ref, choice, text: typeof r.text === "string" ? r.text : "" }] : [];
  });
}

export function blocking(items: { severity: string }[]): number {
  return items.filter((i) => i.severity === "must" || i.severity === "should").length;
}

/**
 * Whether this change's fix takes the item: a must always does, and so does anything whose recommended handling
 * is `fix` or is not readable at all. A follow-up or a skipped item is not counted against the loop's limits.
 */
export function fixesNow(i: { severity: string; action?: unknown }): boolean {
  if (i.severity === "must") return true;
  return i.action !== "followup" && i.action !== "skip";
}

/**
 * A finding the judgement left for a follow-up: the recommended handling says so and this change's fix does not take
 * it. An accepted must is fixed whatever its action says, so it is never a follow-up: the two decisions agree.
 */
export function isFollowup(i: { severity: string; action?: unknown }): boolean {
  return i.action === "followup" && !fixesNow(i);
}

/**
 * Whether a fix not made for an S4 pass takes the item: what this change's fix takes, but a nit only when penne
 * corrected it to fix. A nit the judgement left is never sent; one penne chose to fix is.
 */
export function inFixScope(i: { severity: string; action?: unknown; corrected?: boolean }): boolean {
  return fixesNow(i) && (i.severity !== "nit" || i.corrected === true);
}

/**
 * the accepted must / should counts the loop's close condition reads: only what the judgement sent to this change's
 * fix. A nit penne corrected to fix counts as a must: what a person chose to have fixed is not left to a close.
 */
export function fixCounts(items: { severity: string; action?: unknown; corrected?: boolean }[]): { must: number; should: number } {
  return counts(items.filter(fixesNow).map((i) => (i.severity === "nit" && i.corrected === true ? { severity: "must" } : i)));
}

/** the loop may close: no accepted must at all, and at most ACCEPTED_LIMIT accepted should */
export function withinLimit(must: number, should: number): boolean {
  return must === 0 && should <= ACCEPTED_LIMIT;
}

/**
 * How the pass that holds event `i` closes and how many fix rounds it may send, as its first blind recorded them
 * (`s2_review_started` attrs `close_on` and `max_fix_rounds`, written from roles.yaml when the pass began). A pass
 * that began before these were recorded, a pass on PR feedback (S4) and a pass whose blind was skipped read as the
 * loop always did: at most ACCEPTED_LIMIT should tolerated, and only the lane-wide MAX_FIX_ROUNDS.
 */
export function passPolicy(events: LifecycleRecord[], i = events.length - 1): { closeOnMust: boolean; closeOnFix: boolean; maxFixRounds?: number; maxShouldFix?: number; /** set when this pass began at a depth-bearing round: the depth it ran under */ depth?: Depth; start: number } {
  const start = passStartAt(events, i);
  if (start < 0 || events[start].event === "s4_review_comment_received" || events[start].event === "s2_review_skipped") return { closeOnMust: false, closeOnFix: false, start };
  for (let j = start; j <= Math.min(i, events.length - 1); j += 1) {
    const e = events[j];
    if (e.event !== "s2_review_started" || (e.attrs?.kind ?? "blind") !== "blind") continue;
    const cap = e.attrs?.max_fix_rounds;
    const shouldCap = e.attrs?.max_should_fix;
    const depth = e.attrs?.depth;
    return {
      closeOnMust: e.attrs?.close_on === "must",
      closeOnFix: e.attrs?.close_on === "must_and_fix",
      ...(typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? { maxFixRounds: cap } : {}),
      ...(typeof shouldCap === "number" && Number.isInteger(shouldCap) && shouldCap >= 1 ? { maxShouldFix: shouldCap } : {}),
      ...(isDepthReference(depth) ? { depth } : {}),
      start,
    };
  }
  return { closeOnMust: false, closeOnFix: false, start };
}

/**
 * Whether the judgement at `i` lets the loop close with these counts of what it sent to the fix: no accepted must,
 * and, unless its pass closes on musts alone, at most ACCEPTED_LIMIT should. What such a close leaves unsent goes to
 * the follow-ups (`followupsOf`).
 */
export function closesAt(events: LifecycleRecord[], i: number, c: { must: number; should: number }): boolean {
  const p = passPolicy(events, i);
  // the `triage` value tolerates no should either: one the judgement recommended a fix for keeps the pass open
  if (p.closeOnFix) return c.must === 0 && c.should === 0;
  return p.closeOnMust ? c.must === 0 : withinLimit(c.must, c.should);
}

/**
 * The stop penne is asked for when one judgement of a `triage` pass recommends more should fixes than the pass's cap
 * (`s2_review_started` attrs `max_should_fix`, the default `DEFAULT_MAX_SHOULD_FIX` otherwise). Undefined within the
 * cap and for a pass that does not close on fix-recommended shoulds (S4, a skipped blind, an old record).
 */
export function overCapStop(a: Attrs | undefined, p: { closeOnFix: boolean; maxShouldFix?: number }): string | undefined {
  if (!p.closeOnFix) return undefined;
  const over = acceptedOf(a).filter((x) => x.severity === "should" && fixesNow(x));
  const max = p.maxShouldFix ?? DEFAULT_MAX_SHOULD_FIX;
  if (over.length <= max) return undefined;
  const list = over.map((x) => `${x.ref}（${x.severity}）${x.claim}`).join(" / ");
  return `1 回の判定で fix を勧めた should が ${over.length} 件（この回の上限 ${max} 件）。境目を決めてください: ${list}`;
}

/**
 * Where the pass of the loop that holds event `i` began, when it began at feedback on the PR (S4): the index
 * of that `s4_review_comment_received`, or -1 for a pass that began at a blind (or a skipped one).
 */
export function feedbackPassAt(events: LifecycleRecord[], i = events.length - 1): number {
  const at = passStartAt(events, i);
  return at >= 0 && events[at].event === "s4_review_comment_received" ? at : -1;
}

/** whether a blind of the review loop ever started: the only rounds a missing review_blind slot skips */
export function blindEverRan(events: LifecycleRecord[]): boolean {
  return events.some((e) => e.event === "s2_review_started");
}

/** a send-back for a conflict with the mainline: where it was recorded and the lane head it counts from */
export interface ConflictSendBack { /** the event that recorded the send-back */ index: number; /** the lane head at the send-back, when a record holds one */ head?: string }

/**
 * The send-backs for a conflict with the mainline, in the order they were recorded, read from both paths: the
 * harness's `s4_land_conflict` (which carries the head it counts from), and a judgement of a submit card whose
 * S3 check then said conflict (`s3_check_conflict` as the latest check result), which counts from the head the
 * card opened at. The harness's pair of a revise and an `s4_land_conflict` is one send-back, not two.
 */
export function conflictSendBacks(events: LifecycleRecord[]): ConflictSendBack[] {
  const out: ConflictSendBack[] = [];
  let latestCheck: "conflict" | "clean" | undefined;
  let submitHead: string | undefined;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e.event === "s3_check_conflict") latestCheck = "conflict";
    else if (e.event === "s3_check_clean") latestCheck = "clean";
    else if (e.event === "s4_submit_started") {
      const h = e.attrs?.head;
      submitHead = typeof h === "string" && h ? h : undefined;
    } else if (e.event === "s4_land_conflict") {
      const h = e.attrs?.head;
      out.push({ index: i, ...(typeof h === "string" && h ? { head: h } : {}) });
    } else if (e.event === "s4_verify_user_judgment_answered" && e.attrs?.outcome === "revise" && e.attrs?.by !== "harness" && latestCheck === "conflict") {
      out.push({ index: i, ...(submitHead ? { head: submitHead } : {}) });
    }
  }
  return out;
}

/**
 * The event the pass of the loop that holds event `i` began at: feedback on the PR, a blind, or a skipped blind.
 * A conflict scope round continues the pass before the send-back (its blind is skipped over); a pass that began at
 * PR feedback is not continued, so the conflict round starts a new one there.
 */
function passStartAt(events: LifecycleRecord[], i: number): number {
  for (let j = Math.min(i, events.length - 1); j >= 0; j -= 1) {
    const e = events[j];
    if (e.event === "s4_review_comment_received" || e.event === "s2_review_skipped") return j;
    if ((e.event === "s2_review_started" || e.event === "s2_map_started") && (e.attrs?.kind ?? "blind") === "blind") {
      // a pass may hold several blind rounds (a depth-bearing one does): the pass begins at its first, and a
      // converge, a skipped blind or PR feedback between two of them starts a new pass. A conflict scope round
      // continues the pass before it even across a converge; a pass that began at PR feedback is not continued (the
      // boundary above stops the walk).
      const conflict = e.event === "s2_review_started" && e.attrs?.diff_scope === "conflict";
      let first = j;
      for (let k = j - 1; k >= 0; k -= 1) {
        const prev = events[k];
        if (prev.event === "s4_review_comment_received" || prev.event === "s2_review_skipped") break;
        if (prev.event === "s2_review_converged" && !conflict) break;
        if ((prev.event === "s2_review_started" || prev.event === "s2_map_started") && (prev.attrs?.kind ?? "blind") === "blind") first = k;
      }
      return first;
    }
  }
  return -1;
}

/**
 * Whether the next blind started now would be the pass's first: no pass event (a blind, a skipped blind, PR
 * feedback) is on record yet. The plan driver records a depth-bearing round's depth and budget only then.
 */
export function firstBlindOfPass(events: LifecycleRecord[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    // a converge, a skipped blind or PR feedback ends the pass: what follows is a new one until its first blind
    if (e.event === "s4_review_comment_received" || e.event === "s2_review_skipped" || e.event === "s2_review_converged") return true;
    // only a started review is the pass's blind: the map before it is not the blind done (F-113-12)
    if (e.event === "s2_review_started" && (e.attrs?.kind ?? "blind") === "blind") return false;
  }
  return true;
}

/** the judgement of the PR's feedback the current pass began with, when it is an S4 pass */
export function feedbackTriageOf(events: LifecycleRecord[]): LifecycleRecord | undefined {
  const fb = feedbackPassAt(events);
  if (fb < 0) return undefined;
  let found: LifecycleRecord | undefined;
  for (let i = fb + 1; i < events.length; i += 1) {
    const e = events[i];
    if (e.event === "s2_triage_done" && e.attrs?.kind === "feedback" && !e.attrs?.failed) found = e;
  }
  return found;
}

/**
 * Whether the judgement at `i` belongs to an S4 pass (PR feedback, or the confirm of its leftovers). There the
 * fix takes every accepted item whose action is fix, nits included; followup and skip become a reply, not a fix.
 */
export function s4Triage(events: LifecycleRecord[], i: number): boolean {
  const kind = events[i]?.attrs?.kind;
  return kind === "feedback" || (kind === "confirm" && feedbackPassAt(events, i) >= 0);
}

/** the state the loop was in just before the last `started` event of a stage: what a retry starts again */
function before(events: LifecycleRecord[], started: string): ReviewLoopState | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === started) return reviewLoopState(events.slice(0, i));
  return undefined;
}

function counts(items: { severity: string }[]): { must: number; should: number } {
  return { must: items.filter((i) => i.severity === "must").length, should: items.filter((i) => i.severity === "should").length };
}

/**
 * An event that hands the executor a fix to make and so begins a fix round: one the review sent (`s2_fix_sent`), a
 * send-back from penne (`s4_verify_user_judgment_answered` with `revise`, the harness's on a conflict among them),
 * and the S3 rejection that goes back to the implementation (one that goes back to the plan hands the executor nothing). A `sub_todo` answer closes the lane without a fix, so it does not begin a round.
 * The split's `fixRoundStarts` reads this, so the two agree on where a round begins.
 */
export function beginsFixRound(e: LifecycleRecord): boolean {
  if (e.event === "s2_fix_sent" || (e.event === "s3_reject" && !returnsToPlan(e))) return true;
  return e.event === "s4_verify_user_judgment_answered" && e.attrs?.outcome !== "sub_todo";
}

/** which of the loop's fix-round caps it has reached: the lane-wide one or the pass's own */
export type FixCap =
  | { scope: "lane"; fixes: number; cap: number }
  | { scope: "pass"; fixes: number; cap: number; /** where the pass began: the index of its first blind, feedback or skipped blind */ start: number };

/**
 * The fix-round cap the loop has reached, or null while another fix may still go: `fixes` rounds sent against `cap`,
 * either the lane-wide MAX_FIX_ROUNDS or the cap this pass's first blind recorded (`passPolicy`). A pass that
 * recorded no cap is bounded by the lane-wide one alone, as the loop always was. The lane-wide cap counts on every
 * round; the pass's own counts only the `s2_fix_sent` of the pass it belongs to, so a send-back's round is not its
 * predecessor's.
 *
 * `forForecast` reads the cap where the forecast does: right after a send-back, before the blind that opens the
 * next pass is written. The round then running was begun by a send-back (not an `s2_fix_sent`), and it will record a
 * cap of its own after the fix, so the cap the pass reached before it is not a stop for it yet.
 */
export function fixCapReached(events: LifecycleRecord[], opts: { forForecast?: boolean } = {}): FixCap | null {
  const fixes = events.filter((e) => e.event === "s2_fix_sent").length;
  if (fixes >= MAX_FIX_ROUNDS) return { scope: "lane", fixes, cap: MAX_FIX_ROUNDS };
  const policy = passPolicy(events);
  if (policy.maxFixRounds === undefined) return null;
  const inPassFixes = events.filter((e, i) => i > policy.start && e.event === "s2_fix_sent").length;
  if (inPassFixes < policy.maxFixRounds) return null;
  if (opts.forForecast) {
    let lastStart = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) if (beginsFixRound(events[i])) { lastStart = i; break; }
    if (lastStart < 0 || events[lastStart].event !== "s2_fix_sent") return null;
  }
  return { scope: "pass", fixes: inPassFixes, cap: policy.maxFixRounds, start: policy.start };
}

/**
 * Stagnation: the same accepted claim comes back after two fixes, or the accepted must / should
 * count did not go down between the triages of the current pass's fix loop.
 */
export function stagnation(events: LifecycleRecord[]): string | null {
  // every judgement counts, including the final blind's: a must that keeps coming back there is stagnation too
  // an S4 pass fixes every accepted item whose action is fix, nits included, and tolerates none of them
  const triages = events.flatMap((e, i) => (e.event === "s2_triage_done" && !e.attrs?.failed ? [{ e, i, all: s4Triage(events, i) }] : []));
  const fixed = (t: { e: LifecycleRecord; i: number; all: boolean }) => acceptedAt(events, t.i).filter((x) => (t.all ? fixesNow(x) : inFixScope(x)));
  const key = (i: AcceptedItem) => `${i.path ?? ""}|${i.claim}`;
  const seen = new Map<string, number>();
  for (const t of triages) {
    for (const i of fixed(t)) {
      const n = (seen.get(key(i)) ?? 0) + 1;
      seen.set(key(i), n);
      if (n >= 3) return `同じ指摘が修正後も戻ってくる: ${i.claim}`;
    }
  }
  // the count is compared within the pass: a new pass (feedback on the PR, a whole-diff round after a send-back)
  // starts from what it was handed, while a conflict scope round compares only the judgements after the send-back
  const start = passStartAt(events, events.length - 1);
  const sendBacks = conflictSendBacks(events).map((s) => s.index).filter((i) => i > start);
  const base = sendBacks.length ? sendBacks[sendBacks.length - 1] : start;
  const inPass = triages.filter((t) => t.i > base);
  if (inPass.length >= 3) {
    const recent = inPass.slice(-3);
    // both counts are what the triage sent to the fix, so they compare as one quantity; only the tolerance differs.
    // The `triage` value tolerates no should, so it compares from 0 like an S4 pass (DEC-10081)
    const noShould = passPolicy(events).closeOnFix;
    const [a, b, c] = recent.map((t) => (t.all ? fixed(t).length : blocking(acceptedAt(events, t.i).filter(fixesNow))));
    if (c >= b && b >= a && c > (recent[2].all || noShould ? 0 : ACCEPTED_LIMIT)) return `${recent[2].all ? "受理済みの指摘" : "受理済みの must / should "}が減らない（${a} → ${b} → ${c}）`;
  }
  const cap = fixCapReached(events);
  if (cap?.scope === "lane") return `修正が ${cap.fixes} 巡に達した（上限）`;
  // the pass's own cap: another fix would go past what its first blind recorded, so penne decides where the change ends
  if (cap) {
    const last = triages.at(-1);
    const open = last && last.i > cap.start ? fixed(last).filter((x) => x.severity !== "nit" || x.corrected === true) : [];
    const list = open.map((x) => `${x.ref}（${x.severity}）${x.claim}`).join(" / ");
    // the High role's final found what is still open: penne decides the boundary knowing who stopped the loop (DEC-2764)
    const started = last ? [...events.slice(0, last.i)].reverse().find((e) => e.event === "s2_review_started") : undefined;
    const highFinal = !!last && (events[last.i].attrs?.kind ?? "blind") === "final" && Array.isArray(started?.attrs?.extras) && (started.attrs.extras as unknown[]).includes("high_risk");
    return `修正が ${cap.fixes} 巡に達した（この回の上限 ${cap.cap} 巡）${highFinal ? "。High の最後のレビューの指摘が残っています" : ""}。境目を決めてください${list ? `: ${list}` : ""}`;
  }
  return null;
}

/**
 * A result the executor sent back without working: the brief's return condition was met (a dependency not landed, a
 * premise missing), so the lane holds no change to review. Read from the record's own fields: `failed` with no
 * changed file. A failed result that changed files is work the review reads as before.
 */
export function isReturnedResult(e: LifecycleRecord | undefined): boolean {
  if (!e || e.event !== "s2_result") return false;
  const a = e.attrs ?? {};
  return a.outcome === "failed" && Array.isArray(a.changed_files) && a.changed_files.length === 0;
}

/**
 * Whether the newest records send-back is still waiting on the executor. The wait and the instruction that went with it
 * are two records, so a send-back whose instruction could not be written leaves the wait alone on the record. A round
 * that read nothing and stands after it did not answer those errors, so it cannot close the review.
 */
export function recordsSendBackOpen(events: LifecycleRecord[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === "s2_records_conflict") return true;
    if (events[i].event === "s2_records_instructed") return false;
  }
  return false;
}

/** the checks' names the checks' record sends to the fix, in its order */
function checkNamesOf(a: Attrs): string[] {
  const findings = Array.isArray(a.findings) ? (a.findings as Record<string, unknown>[]) : [];
  return findings.map((f) => String(f?.ref ?? "").replace(/^checks\//, "")).filter(Boolean);
}

/** the checks that could not be compared, as the stop names them: each with what the run said of it */
function uncomparedOf(a: Attrs): string[] {
  const rows = Array.isArray(a.checks) ? (a.checks as Record<string, unknown>[]) : [];
  return rows
    .filter((r) => r && r.status !== "pass" && r.status !== "not-applicable" && !(r.status === "fail" && r.verdict === "preexisting"))
    .map((r) => (typeof r.phrase === "string" && r.phrase ? `${String(r.name ?? "")}（${r.phrase}）` : String(r.name ?? "")));
}

/**
 * What the checks' record says of the tree they failed on, as a sentence of a stop: the first failed row's note (the
 * run checked the head merged with the public base's tip), or nothing
 */
function treeNoteOf(a: Attrs): string {
  const rows = Array.isArray(a.checks) ? (a.checks as Record<string, unknown>[]) : [];
  const row = rows.find((r) => r?.status === "fail" && typeof r.tree_note === "string" && r.tree_note);
  return row ? `${String(row.tree_note)}。` : "";
}

/**
 * Where the checks before the convergence leave the loop: a run that did not finish stops for penne and runs again on
 * a continue; a failure the lane made goes to the fix, unless the fix rounds are spent (then penne decides); a failure
 * that could not be compared stops for penne; nothing the lane made converges.
 */
function checksDoneState(events: LifecycleRecord[], last: number, a: Attrs, round: number): ReviewLoopState {
  if (a.failed) return { state: "escalated", reason: `収束の前の必須の検査を回せなかった: ${String(a.error ?? "")}`, retry: checksReturnState(events, last) };
  if (a.outcome === "pass") return checksReturnState(events, last);
  if (a.outcome === "new") {
    const cap = fixCapReached(events.slice(0, last + 1));
    if (!cap) return { state: "send_fix", round };
    const limit = cap.scope === "lane" ? "（上限）" : `（この回の上限 ${cap.cap} 巡）`;
    return { state: "escalated", reason: `収束の前の必須の検査が lane の変更で落ちた（${checkNamesOf(a).join("、")}）。${treeNoteOf(a)}修正が ${cap.fixes} 巡に達した${limit}。続けると検査の失敗を手直しに送り、受け入れると収束する` };
  }
  return { state: "escalated", reason: `収束の前の必須の検査を比べる base（公開 base の先端。取れなかったときは lane の分岐元）と比べられなかった: ${uncomparedOf(a).join("、")}。${treeNoteOf(a)}続けると検査を回し直し、受け入れると収束する` };
}

/**
 * Where the loop goes once the checks whose record is at `d` have spoken for the head: the state the checks held back
 * when their start carried one (a round the mainline's merge alone skipped), the convergence otherwise.
 */
export function checksReturnState(events: LifecycleRecord[], d: number): ReviewLoopState {
  for (let i = d - 1; i >= 0; i -= 1) {
    if (events[i].event !== "s2_checks_started") continue;
    const back = events[i].attrs?.resume_state;
    return back && typeof back === "object" && !Array.isArray(back) && "state" in back ? (back as ReviewLoopState) : { state: "converge" };
  }
  return { state: "converge" };
}

/**
 * The checks' record a stop penne's answer at `last` answered was over: walking back over the stops (and over a fix of
 * the checks' failures that left the head where it was, which stops right after it), the record the loop stopped at.
 * -1 when the stop was over anything else.
 */
export function checksStopAt(events: LifecycleRecord[], last: number): number {
  let stopped = false;
  for (let i = last - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!(REVIEW_EVENTS as readonly string[]).includes(e.event)) continue;
    if (e.event === "s2_review_escalated") { stopped = true; continue; }
    if (e.event === "s2_review_resumed") continue;
    if (e.event === "s2_fix_sent" && e.attrs?.source === "checks" && stopped) continue;
    // the stop may be derived and not yet on record (an answer can come before the stop is written)
    return e.event === "s2_checks_done" ? i : -1;
  }
  return -1;
}

/**
 * The checks' record whose failures a fix sent now carries: the loop's last word is that record, or a stop over it and
 * penne's answers (a fix of those failures that left the head where it was included). -1 for a fix of anything else.
 */
export function checksFixAt(events: LifecycleRecord[]): number {
  let stopped = false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!(REVIEW_EVENTS as readonly string[]).includes(e.event)) continue;
    if (e.event === "s2_review_escalated") { stopped = true; continue; }
    if (e.event === "s2_review_resumed") continue;
    if (e.event === "s2_fix_sent" && e.attrs?.source === "checks" && stopped) continue;
    return e.event === "s2_checks_done" && e.attrs?.outcome === "new" && !e.attrs?.failed ? i : -1;
  }
  return -1;
}

/**
 * The checks' record the lane's stop is over (the loop stopped at it), or undefined when the lane is not stopped over
 * the checks: the stuck card shows what they found instead of the last judgement's findings.
 */
export function checksStopOf(events: LifecycleRecord[]): Attrs | undefined {
  const d = checksStopAt(events, events.length);
  return d >= 0 ? events[d].attrs ?? {} : undefined;
}

/**
 * Whether the checks before the convergence have spoken for `head`: the last finished run of that head found nothing
 * the lane made, or penne accepted after it. A run of another head, or none, has not.
 */
export function checksSettled(events: LifecycleRecord[], head: string): boolean {
  let d = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event === "s2_checks_done" && e.attrs?.head === head) { d = i; break; }
  }
  if (d < 0) return false;
  if (events[d].attrs?.outcome === "pass" && !events[d].attrs?.failed) return true;
  // a run that could not run, or found what penne then accepted: the accept answers for the head
  return events.slice(d + 1).some((e) => e.event === "s2_review_resumed" && e.attrs?.decision === "accept");
}

/**
 * What the convergence writes: after checks that passed, what the convergence they held back would have written
 * (carried on their start) and the head they spoke for; otherwise what the caller gives (a final skipped), or the
 * reason of a continue with nothing left to fix.
 */
export function convergeAttrsOf(events: LifecycleRecord[], given?: Record<string, unknown>): Record<string, unknown> {
  let last = events.length - 1;
  while (last >= 0 && !(REVIEW_EVENTS as readonly string[]).includes(events[last].event)) last -= 1;
  const done = last >= 0 ? events[last] : undefined;
  const carriedFrom = (d: number): Record<string, unknown> => {
    let s = d - 1;
    while (s >= 0 && events[s].event !== "s2_checks_started") s -= 1;
    const carried = s >= 0 ? events[s].attrs?.converge : undefined;
    return carried && typeof carried === "object" && !Array.isArray(carried) ? { ...(carried as Record<string, unknown>) } : {};
  };
  if (done?.event === "s2_checks_done" && done.attrs?.outcome === "pass" && !done.attrs?.failed) {
    return { ...carriedFrom(last), checks_head: String(done.attrs?.head ?? "") };
  }
  // an accept on a stop over the checks: the convergence they held back is written as it would have been
  if (done?.event === "s2_review_resumed" && done.attrs?.decision === "accept") {
    const over = checksStopAt(events, last);
    if (over >= 0) return { ...carriedFrom(over), checks_accepted: String(events[over].attrs?.head ?? "") };
  }
  return given ?? zeroFixMarks(events) ?? {};
}

export function reviewLoopState(events: LifecycleRecord[]): ReviewLoopState {
  const names = events.map((e) => e.event);
  const lastResult = names.lastIndexOf("s2_result");
  if (lastResult < 0) return { state: "idle" };
  // lanes that reached S3 before this loop existed (or after it finished) are not re-entered,
  // unless feedback on the PR came in after that
  const lastReady = names.lastIndexOf("s3_ready");
  if (lastReady > lastResult && names.lastIndexOf("s4_review_comment_received") < lastReady) return { state: "done" };

  // the last loop event decides; events before the executor's first result do not exist
  let last = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if ((REVIEW_EVENTS as readonly string[]).includes(events[i].event)) { last = i; break; }
  }
  const round = events.filter((e) => e.event === "s2_fix_sent").length + conflictSendBacks(events).length + 1;
  // the executor's first word was a return (no change to review): no round starts, so an empty diff cannot converge
  // and go on to a records-only landing. The lane waits on what it returned for (blockers.ts), not on the loop
  if (last < 0) return isReturnedResult(events[lastResult]) ? { state: "idle" } : { state: "start_blind", kind: "blind", round: 1 };

  const ev = events[last];
  const a = ev.attrs ?? {};

  // a result after the last loop event: an answer to a fix, or new work after the loop had finished
  // (a revise from S4). A duplicate result while a stage is running does not restart the loop.
  if (lastResult > last && ev.event !== "s2_review_skipped") {
    if (ev.event === "s2_fix_sent") {
      // a depth-bearing round has no confirm: the next step is the review that reads the whole diff again
      if (passPolicy(events, last).depth !== undefined) return { state: "start_blind", kind: "blind", round };
      // a fix of the checks' failures sent no finding a confirm could check: the whole diff is reviewed again
      if (a.source === "checks") return { state: "start_blind", kind: "blind", round };
      return { state: "start_confirm", round: round - 1 };
    }
    // the executor's result after the first review's merge conflict: the lane's first review begins
    if (ev.event === "s2_review_base_conflict") return { state: "start_blind", kind: "blind", round };
    // the executor answered the records send-back: the records check runs again without a review round
    if (ev.event === "s2_records_conflict" || ev.event === "s2_records_instructed") return { state: "recheck_intent", round };
    // a result right after penne's continue / accept is not new work: the decision still stands.
    // After the loop finished, only a result that answers a send-back (S4 revise, legacy S3 reject) is new
    // work; any other result there is a duplicate and leaves the lane where it is.
    // whether the loop had finished is read from the state it reached, whichever event ended it (a judgement,
    // penne's continue)
    if (["s2_review_converged", "s2_device_done", "s2_device_skipped"].includes(ev.event) || reviewLoopState(events.slice(0, last + 1)).state === "done") {
      const sentBack = events.slice(last + 1, lastResult).some((e) => e.event === "s4_verify_user_judgment_answered" || (e.event === "s3_reject" && !returnsToPlan(e)));
      if (sentBack) return { state: "start_blind", kind: "blind", round };
    }
  }

  switch (ev.event) {
    case "s2_review_started":
      return { state: "running_blind", kind: (a.kind as ReviewKind) ?? "blind", round: num(a.round), runIds: strs(a.run_ids) };
    // awaiting: the instruction was sent and the executor's result has not come; otherwise the review goes on
    case "s2_review_base_conflict":
      return a.awaiting === true ? { state: "awaiting_merge", round } : { state: "start_blind", kind: "blind", round };
    // the order check: waiting on the lanes ahead, and the records that end the wait or let the first review begin
    case "s2_order_waiting":
      return { state: "awaiting_order", round, opponents: orderOpponentsOf(a) };
    case "s2_order_passed":
    case "s2_order_released":
    case "s2_order_limit":
    case "s2_order_unknown":
      return { state: "start_blind", kind: "blind", round };
    case "s2_map_started":
      return { state: "running_map", kind: a.kind === "final" ? "final" : "blind", round: num(a.round), runId: String(a.run_id ?? ""), ...(typeof a.head === "string" && a.head ? { head: a.head } : {}) };
    case "s2_map_done":
      return { state: "start_blind", kind: a.kind === "final" ? "final" : "blind", round: num(a.round), map: { routes: routesOf(a.routes), ...(typeof a.head === "string" && a.head ? { head: a.head } : {}) } };
    // the head moved out from under the routes: the map is not usable, so the round waits and draws it again (the
    // state carries no map, as before one ran; a dropped whole-diff blind keeps an empty map instead, which is not drawn again)
    case "s2_map_head_moved":
      return { state: "start_blind", kind: a.kind === "final" ? "final" : "blind", round: num(a.round) };
    // the whole-diff blind of a routed round did not finish: the round runs again as if there were no map
    case "s2_map_dropped":
      return { state: "start_blind", kind: a.kind === "final" ? "final" : "blind", round: num(a.round), map: { routes: [] } };
    case "s2_review_findings":
      return { state: "start_triage", kind: (a.kind as ReviewKind) ?? "blind", round: num(a.round), inputs: strs(a.files) };
    case "s4_review_comment_received":
      return { state: "start_triage", kind: "feedback", round, inputs: strs(a.files) };
    case "s2_triage_started":
      return { state: "running_triage", kind: (a.kind as TriageKind) ?? "blind", round: num(a.round), runId: String(a.run_id ?? "") };
    case "s2_triage_done": {
      if (a.failed) return { state: "escalated", reason: `判定に失敗: ${String(a.error ?? "")}`, retry: before(events, "s2_triage_started") };
      // the `triage` value's cap is checked before any other stop: a judgement that also asks a question or reverses
      // a fix must still show penne the shoulds it recommended fixing past the cap, not hide them behind that branch.
      // The stops are joined, so none is dropped.
      const stops = [
        overCapStop(a, passPolicy(events, last)),
        // a finding that undoes an earlier fix is never sent to the fix: which way the boundary lies is penne's call
        oscillationsOf(a).length ? "修正が往復している（前の巡の修正を打ち消す指摘がある）。境目を決めてください" : undefined,
        strs(a.escalated_claims).length ? "判定が penne の判断を求めた指摘がある" : undefined,
      ].filter((x): x is string => !!x);
      if (stops.length) return { state: "escalated", reason: stops.join("\n") };
      // a pass that began at a depth-bearing round follows the depth's order, not the old one
      const roundDepth = passPolicy(events, last).depth;
      if (roundDepth !== undefined) return newOrderTriage(events, last, roundDepth, round);
      if (s4Triage(events, last)) {
        // a reviewer's request whose action is fix is fixed, nit or not; followup and skip become a reply.
        // With no fix at all the round closes without touching the code: the feedback leaves it as it is, the
        // confirm's leftovers go on to the final blind
        if (!acceptedOf(a).some(fixesNow)) return a.kind === "feedback" ? { state: "done" } : { state: "start_blind", kind: "final", round };
        const stuck = stagnation(events);
        return stuck ? { state: "escalated", reason: stuck } : { state: "send_fix", round };
      }
      // an answered judgement sends the fix as the answer said and does not stop again; the cap stop above is read
      // once, so the resumed path goes on
      const c = fixCounts(acceptedOf(a));
      if (closesAt(events, last, c)) {
        if (a.kind === "final") return { state: "converge" };
        if (a.kind === "device") return { state: "done" };
        return { state: "start_blind", kind: "final", round };
      }
      const stuck = stagnation(events);
      if (stuck) return { state: "escalated", reason: stuck };
      return { state: "send_fix", round };
    }
    case "s2_fix_sent":
      return { state: "fixing", round: round - 1 };
    case "s2_confirm_started":
      return { state: "running_confirm", round: num(a.round), runId: String(a.run_id ?? "") };
    case "s2_confirm_done": {
      if (a.failed) return { state: "escalated", reason: `確認に失敗: ${String(a.error ?? "")}`, retry: before(events, "s2_confirm_started") };
      // a reviewer's request (S4) that is not confirmed fixed is never tolerated, nit or not; nor is a boundary
      // penne decided that the fix was not found to meet. In S4 the confirm's list is exactly the fix items, so none
      // of them may stay unresolved: the one-should tolerance is the review loop's, not this pass's
      const clean = num(a.new_blocking) === 0 && num(a.unresolved_requests) === 0 && num(a.unresolved_boundaries) === 0;
      // the confirm event carries no kind of its own: whether this pass is an S4 one is read from where it began.
      // The `triage` value tolerates no unresolved should either: one keeps the pass open (DEC-10081)
      const s4Pass = feedbackPassAt(events, last) >= 0;
      const tolerable = s4Pass || passPolicy(events, last).closeOnFix
        ? num(a.unresolved_must) === 0 && num(a.unresolved_should) === 0
        : withinLimit(num(a.unresolved_must), num(a.unresolved_should));
      if (clean && tolerable) return { state: "start_blind", kind: "final", round };
      return { state: "start_triage", kind: "confirm", round: num(a.round), inputs: strs(a.files) };
    }
    case "s2_review_escalated": {
      const retry = a.retry_state as ReviewLoopState | undefined;
      const q = a.quota_wait;
      const quotaWait = q && typeof q === "object" && !Array.isArray(q) && typeof (q as { reason?: unknown }).reason === "string"
        ? { ...(typeof (q as { role?: unknown }).role === "string" ? { role: String((q as { role: unknown }).role) } : {}), ...(typeof (q as { resets_at?: unknown }).resets_at === "number" ? { resetsAt: Number((q as { resets_at: unknown }).resets_at) } : {}), reason: String((q as { reason: unknown }).reason) }
        : undefined;
      return { state: "escalated", reason: String(a.reason ?? ""), ...(retry && typeof retry === "object" && "state" in retry ? { retry } : {}), ...(quotaWait ? { quotaWait } : {}) };
    }
    case "s2_review_resumed": {
      // an accept on a stop over the checks takes the head as answered for and goes where the checks were taking it
      if (a.decision === "accept") {
        const over = checksStopAt(events, last);
        return over >= 0 ? checksReturnState(events, over) : { state: "converge" };
      }
      // penne took the code: the lane waits for the hand work, then one review round runs (no fix round)
      if (a.decision === "hand_fix") return { state: "awaiting_hand_fix", round };
      // continuing after a failure retries the stage that failed; after stagnation or a question it sends the fix again.
      // The escalation is read from the state itself, so a "continue" pressed before the escalation event was
      // written still retries the right stage.
      const prior = reviewLoopState(events.slice(0, last));
      // a continue on a High role's window wait lets the fallback run the final (DEC-2766); the record says penne allowed it
      if (prior.state === "escalated" && prior.retry) {
        if (prior.quotaWait && prior.retry.state === "start_blind") return { ...prior.retry, allowHighFallback: true };
        return prior.retry;
      }
      // a stop over the checks before the convergence: a continue sends the failures the lane made to the fix (the cap
      // stop), or runs the checks again (one that could not be compared). No judgement is answered there
      const checked = checksStopAt(events, last);
      if (checked >= 0) return events[checked].attrs?.outcome === "new" && !events[checked].attrs?.failed ? { state: "send_fix", round } : checksReturnState(events, checked);
      // a stop over the judgement's questions only: nits are not fixed, so the loop goes on as if nothing was asked.
      // A note is an instruction to the executor, and goes with a fix
      if (!String(a.note ?? "").trim()) {
        const next = afterQuestion(events.slice(0, last), round);
        if (next) return next;
      }
      // the answer left nothing for this change's fix (no finding in its scope, no reversal, no question the note
      // answers; after a stop right after a fix, the note and boundaries that fix carried count, as `fixScope` carries
      // them): a fix of nothing would wake the planner and the executor for a head that does not move, so the loop
      // goes where a judgement with nothing to fix goes without a stop. A note that answers no question is not an
      // instruction to fix
      if (sendsNothing(events.slice(0, last + 1))) return afterZeroFix(events, last, round);
      return { state: "send_fix", round };
    }
    // the records check ended without sending the lane back: the loop is done and S3 may run (the loop's own step
    // wrote the event, so the state machine only has to read it)
    case "s2_intent_checked":
      return { state: "done" };
    // the check sent the lane back to fix its records: not done until the executor answers
    case "s2_records_conflict":
    case "s2_records_instructed":
      return { state: "awaiting_records_fix", round };
    // the executor changed code outside the records place: the review's rounds run again
    case "s2_records_reopened":
      return { state: "start_blind", kind: "blind", round };
    case "s2_review_converged":
    case "s2_review_skipped":
      return { state: "start_device", round };
    case "s2_checks_started":
      return { state: "running_checks", runId: String(a.run_id ?? ""), head: String(a.head ?? "") };
    case "s2_checks_done":
      return checksDoneState(events, last, a, round);
    // the round read nothing (the head is only the mainline merged in): the lane goes on where the round before it
    // left it, S3 and the submit. On the records check's way the check runs again in the same step and is the event
    // the next tick reads (`s2_intent_checked`); the origin the record carries is what every later reading diffs against.
    // A send-back whose instruction never went out leaves the wait alone under the skip, so the errors are unanswered
    // and the lane waits for the executor rather than reading the skip as the review's end (`done`)
    case MERGE_ONLY_SKIP_EVENT:
      return recordsSendBackOpen(events) ? { state: "awaiting_records_fix", round } : { state: "done" };
    // penne finished the hand work: one whole-diff review round runs, without using the fix budget (DEC-113-11)
    case "s2_hand_fixed":
      return { state: "start_blind", kind: "blind", round };
    case "s2_device_started":
      return { state: "running_device", round: num(a.round), runId: String(a.run_id ?? "") };
    case "s2_device_done": {
      if (a.failed) return { state: "escalated", reason: `絵の見比べに失敗: ${String(a.error ?? "")}`, retry: before(events, "s2_device_started") };
      // a person judges their lane: the role's findings are material for their submit card, never sent to a fix
      if (a.judge === "human") return { state: "done" };
      if (num(a.blocking) > 0) return { state: "start_triage", kind: "device", round: num(a.round), inputs: strs(a.files) };
      return { state: "done" };
    }
    case "s2_device_skipped":
      return { state: "done" };
    default:
      return { state: "idle" };
  }
}

/**
 * Where a depth-bearing round goes after its judgement, by the depth's table: no item the judgement sends to the fix
 * closes the round toward the last review, then convergence (the kept check was removed with R2, 2026-10-22). An item
 * sent to the fix goes to the fix while the round's budget holds; once it is spent, penne decides (DEC-113-3).
 */
function newOrderTriage(events: LifecycleRecord[], i: number, depth: Depth, round: number): ReviewLoopState {
  const kind = String(events[i]?.attrs?.kind ?? "blind");
  const accepted = acceptedAt(events, i);
  if (!accepted.some(fixesNow)) {
    // the device check ends the lane whether or not the pass ran it at depth (F-113-13)
    if (kind === "device") return { state: "done" };
    // a kept judgement is read for the lanes that ran the kept check before it was removed (R2, 2026-10-22)
    if (kind === "kept") return { state: "converge" };
    if (kind === "final") return { state: "converge" };
    if (DEPTH_TABLE_REFERENCE[depth].finalReview) return { state: "start_blind", kind: "final", round };
    return { state: "converge" };
  }
  const stuck = stagnation(events);
  if (stuck) return { state: "escalated", reason: stuck };
  return { state: "send_fix", round };
}

/**
 * Where the loop goes on after a stop that only the last judgement's questions caused, when the rest of what it
 * accepted is within the limit (nits are not counted): the same step as a judgement without questions. Undefined
 * for any other stop, for a judgement over the limit, and for one that fixes every accepted item (S4).
 */
function afterQuestion(events: LifecycleRecord[], round: number): ReviewLoopState | undefined {
  let t = events.length - 1;
  for (; t >= 0; t -= 1) {
    const name = events[t].event;
    if (name === "s2_triage_done") break;
    if (name !== "s2_review_escalated" && (REVIEW_EVENTS as readonly string[]).includes(name)) return undefined;
  }
  if (t < 0) return undefined;
  const a = events[t].attrs ?? {};
  if (a.failed || oscillationsOf(a).length || !strs(a.escalated_claims).length) return undefined;
  // a reviewer's request whose action is fix is sent whatever its severity; with none the round goes where it goes without the question
  if (s4Triage(events, t)) return acceptedOf(a).some(fixesNow) ? undefined : a.kind === "feedback" ? { state: "done" } : { state: "start_blind", kind: "final", round };
  const c = fixCounts(acceptedOf(a));
  if (!closesAt(events, t, c)) return undefined;
  if (a.kind === "final") return { state: "converge" };
  if (a.kind === "device") return { state: "done" };
  return { state: "start_blind", kind: "final", round };
}

/**
 * Whether any recorded switch changed the role that read a round. A switch that only moved a role to another
 * provider of the same model keeps the same reader, so it does not make the round unread (DEC-110-4/110-7).
 */
export function roleChangedIn(fallbacks: unknown): boolean {
  if (!Array.isArray(fallbacks)) return false;
  return (fallbacks as Record<string, unknown>[]).some((f) => !!f && f.role !== f.fallback);
}

/**
 * The head the last whole-diff blind (an unmapped blind, or a final) read, when its judgement is within the limit:
 * a final blind of that same code would only look at it again. Undefined when the last blind was mapped, has no
 * head on record, had a role's blind fail or run on a fallback for Claude's windows (its round was not read by every
 * role it names), is not judged yet, its judgement is over the limit or has a reversal, or a fix was sent after it.
 * The step that skips the final blind reads it, and so does the stuck card through the same step.
 */
export function settledHead(events: LifecycleRecord[]): string | undefined {
  let s = events.length - 1;
  for (; s >= 0; s -= 1) if (events[s].event === "s2_review_started" && (events[s].attrs?.kind ?? "blind") !== "device") break;
  if (s < 0) return undefined;
  const a = events[s].attrs ?? {};
  if (Array.isArray(a.whole_run_ids) || typeof a.head !== "string" || !a.head) return undefined;
  // a role that ran on its fallback was not read by that role, and a folded fallback read it once for two
  if (roleChangedIn(a.fallbacks)) return undefined;
  // a round some of whose roles failed was not read by every role
  const findings = events.find((e, i) => i > s && e.event === "s2_review_findings");
  if (num(findings?.attrs?.failed_runs) > 0) return undefined;
  // a role that switched mid-run was not read by that role either, the same as one switched at the start;
  // a provider-only switch keeps the reader and still counts
  if (roleChangedIn(findings?.attrs?.fallbacks)) return undefined;
  // a fix after that blind may have changed the code it read
  if (events.slice(s + 1).some((e) => e.event === "s2_fix_sent")) return undefined;
  const kind = a.kind ?? "blind";
  const t = events.findIndex((e, i) => i > s && e.event === "s2_triage_done" && !e.attrs?.failed && (e.attrs?.kind ?? "blind") === kind);
  if (t < 0) return undefined;
  const ta = events[t].attrs;
  if (oscillationsOf(ta).length || s4Triage(events, t)) return undefined;
  const c = fixCounts(acceptedAt(events, t));
  return closesAt(events, t, c) ? a.head : undefined;
}

/** where a fix comes from: the review loop's own findings, feedback on the PR, or what a confirm found left of that feedback */
export type FixSource = "review" | "pr" | "pr_leftovers" | "checks";

/** a reversal sent back to the fix with the boundary penne decided (empty when penne only wrote a note) */
export type BoundaryFix = OscillationItem & { decision: string };

/**
 * What a fix sent now carries: the last judgement's accepted items it fixes (must / should, or everything in an S4
 * pass), its reversals with the boundaries penne decided, and penne's note when an answer came after that judgement.
 */
export function fixScope(events: LifecycleRecord[]): { source: FixSource; all: boolean; accepted: AcceptedItem[]; note: string; boundaries: BoundaryFix[] } {
  // the failures the checks before the convergence found the lane made: the fix carries them as musts, with the newest
  // note penne wrote since
  const d = checksFixAt(events);
  if (d >= 0) {
    const findings = Array.isArray(events[d].attrs?.findings) ? (events[d].attrs!.findings as AcceptedItem[]) : [];
    let note = "";
    for (let i = events.length - 1; i > d && !note.trim(); i -= 1) if (events[i].event === "s2_review_resumed") note = String(events[i].attrs?.note ?? "");
    return { source: "checks", all: false, accepted: findings, note, boundaries: [] };
  }
  const t = events.map((e) => e.event).lastIndexOf("s2_triage_done");
  const triage = t >= 0 ? events[t] : undefined;
  const all = t >= 0 ? s4Triage(events, t) : false;
  const source: FixSource = triage?.attrs?.kind === "feedback" ? "pr" : all ? "pr_leftovers" : "review";
  const accepted = (t >= 0 ? acceptedAt(events, t) : []).filter((a) => (all ? fixesNow(a) : inFixScope(a)));
  const r = events.map((e) => e.event).lastIndexOf("s2_review_resumed");
  const answered = r > t ? events[r] : undefined;
  let decided = boundariesOf(answered?.attrs);
  let note = answered ? String(answered.attrs?.note ?? "") : "";
  // an answer that only went on from a stop right after a fix sends that fix again: what the answer before the fix
  // said goes with it, unless this answer says something of its own
  if (r > t) {
    let at = r;
    while (!note.trim() || !decided.length) {
      const before = answerBeforeFixStop(events, at);
      if (before <= t) break;
      if (!note.trim()) note = String(events[before].attrs?.note ?? "");
      if (!decided.length) decided = boundariesOf(events[before].attrs);
      at = before;
    }
  }
  const boundaries = oscillationsOf(triage?.attrs).map((o) => ({ ...o, decision: decided.find((b) => b.ref === o.ref)?.text ?? "" }));
  return { source, all, accepted, note, boundaries };
}

/** the last judgement on record that did not fail, or -1 */
function lastJudgement(events: LifecycleRecord[]): number {
  for (let t = events.length - 1; t >= 0; t -= 1) if (events[t].event === "s2_triage_done" && !events[t].attrs?.failed) return t;
  return -1;
}

/**
 * The fix right before the stop penne's answer at `r` answered (only stops between), or -1: the stop came after a fix
 * and before the next round, as the stop of a head the fix did not move does.
 */
export function fixBeforeStop(events: LifecycleRecord[], r: number): number {
  let stopped = false;
  for (let i = r - 1; i >= 0; i -= 1) {
    const e = events[i].event;
    if (!(REVIEW_EVENTS as readonly string[]).includes(e)) continue;
    if (e === "s2_review_escalated") { stopped = true; continue; }
    return e === "s2_fix_sent" && stopped ? i : -1;
  }
  return -1;
}

/** the answer right before the retry stop penne's answer at `last` answered (only stops between), or -1 */
function answerBeforeRetryStop(events: LifecycleRecord[], last: number): number {
  let stopped = false;
  for (let i = last - 1; i >= 0; i -= 1) {
    const e = events[i].event;
    if (!(REVIEW_EVENTS as readonly string[]).includes(e)) continue;
    if (e === "s2_review_escalated") { stopped = true; continue; }
    return e === "s2_review_resumed" && stopped ? i : -1;
  }
  return -1;
}

/** the answer the fix before the stop answered at `r` was sent from (the loop row right before that fix), or -1 */
function answerBeforeFixStop(events: LifecycleRecord[], r: number): number {
  const f = fixBeforeStop(events, r);
  if (f < 0) return -1;
  for (let i = f - 1; i >= 0; i -= 1) {
    if ((REVIEW_EVENTS as readonly string[]).includes(events[i].event)) return events[i].event === "s2_review_resumed" ? i : -1;
  }
  return -1;
}

/**
 * Whether a fix sent now, after penne's answer, would carry nothing: a judgement is on record, and it leaves no
 * accepted finding in the fix's scope, no reversal with its boundary, and no question that penne's note answers (the
 * note is then the instruction the fix carries). A lane with no judgement on record is never read as empty.
 */
export function sendsNothing(events: LifecycleRecord[]): boolean {
  const t = lastJudgement(events);
  if (t < 0) return false;
  const scope = fixScope(events);
  if (scope.accepted.length || scope.boundaries.length) return false;
  return !(scope.note.trim() !== "" && strs(events[t].attrs?.escalated_claims).length > 0);
}

/**
 * Where the loop goes after penne's continue left nothing to fix: where the judgement it answered goes when it sends
 * nothing to the fix and stops for nothing, by the pass's own order (a depth's table, an S4 pass, or the loop's).
 */
function afterZeroFix(events: LifecycleRecord[], last: number, round: number): ReviewLoopState {
  const t = lastJudgement(events.slice(0, last + 1));
  if (t < 0) return { state: "converge" };
  const kind = String(events[t].attrs?.kind ?? "blind");
  if (s4Triage(events, t)) return kind === "feedback" ? { state: "done" } : { state: "start_blind", kind: "final", round };
  const depth = passPolicy(events, t).depth;
  if (depth !== undefined) {
    if (kind === "device") return { state: "done" };
    if (kind === "kept" || kind === "final") return { state: "converge" };
    return DEPTH_TABLE_REFERENCE[depth].finalReview ? { state: "start_blind", kind: "final", round } : { state: "converge" };
  }
  if (kind === "final") return { state: "converge" };
  if (kind === "device") return { state: "done" };
  return { state: "start_blind", kind: "final", round };
}

/**
 * The reason a record written right after penne's continue with nothing left to fix carries: the convergence that ends
 * the review there (told apart from an accept, which writes no reason), or the final review it starts. Undefined for
 * every other record.
 */
export function zeroFixMarks(events: LifecycleRecord[]): { reason: string; fix_targets: number } | undefined {
  let last = events.length - 1;
  while (last >= 0 && !(REVIEW_EVENTS as readonly string[]).includes(events[last].event)) last -= 1;
  if (last < 0 || events[last].event !== "s2_review_resumed") return undefined;
  const decision = events[last].attrs?.decision;
  if (decision === "accept" || decision === "hand_fix") return undefined;
  // a continue on a stop over the checks answers no judgement: it runs them again or sends their failures
  if (checksStopAt(events, last) >= 0) return undefined;
  // an answer that only retried a stage the zero-fix continue led to (a final whose start failed) carries that
  // continue's reason on: the record the retried stage writes is still the one the continue reached
  const prior = reviewLoopState(events.slice(0, last));
  if (prior.state === "escalated" && prior.retry) {
    const earlier = answerBeforeRetryStop(events, last);
    return earlier < 0 ? undefined : zeroFixMarks(events.slice(0, earlier + 1));
  }
  if (!sendsNothing(events.slice(0, last + 1))) return undefined;
  return { reason: "「続ける」の後に直す対象が 0 件のため、手直しを送らなかった", fix_targets: 0 };
}

/**
 * The judgement penne's answer at `r` answered, read from the record: the judgement right before it, with nothing
 * but penne's stop between them. -1 when the stop was one that retries a stage (a failure, a stage that could not
 * start), or when no judgement comes right before.
 */
export function answeredJudgementAt(events: LifecycleRecord[], r: number): number {
  for (let i = r - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!(REVIEW_EVENTS as readonly string[]).includes(e.event)) continue;
    if (e.event === "s2_review_escalated") {
      if (e.attrs?.retry_state) return -1;
      continue;
    }
    return e.event === "s2_triage_done" && !e.attrs?.failed ? i : -1;
  }
  return -1;
}

/** penne's answer to the judgement at `t`, when one was recorded right after it */
function answerTo(events: LifecycleRecord[], t: number): number {
  for (let i = t + 1; i < events.length; i += 1) {
    const e = events[i];
    if (!(REVIEW_EVENTS as readonly string[]).includes(e.event) || e.event === "s2_review_escalated") continue;
    return e.event === "s2_review_resumed" && answeredJudgementAt(events, i) === t ? i : -1;
  }
  return -1;
}

/** the fix recorded right after event `i` (only penne's stop and answer between), when one was */
export function fixAfter(events: LifecycleRecord[], i: number): LifecycleRecord | undefined {
  for (let j = i + 1; j < events.length; j += 1) {
    const e = events[j];
    if (!(REVIEW_EVENTS as readonly string[]).includes(e.event) || e.event === "s2_review_escalated" || e.event === "s2_review_resumed") continue;
    return e.event === "s2_fix_sent" ? e : undefined;
  }
  return undefined;
}

export interface Unfixed { accepted: AcceptedItem[]; questions: string[]; reversals: OscillationItem[] }

/**
 * What a judgement left unfixed, read from the fix sent right after it: the accepted items not in its refs (all of
 * them when no fix went), the reversals it carried no boundary for, and the questions unless it carried penne's note.
 */
/** the refs the fix right after a judgement was sent to fix; a record without refs (a hand-written one) falls back to what that judgement fixes */
function sentRefs(events: LifecycleRecord[], i: number, fix: LifecycleRecord | undefined): string[] {
  if (!fix) return [];
  return Array.isArray(fix.attrs?.refs) ? strs(fix.attrs.refs) : acceptedAt(events, i).filter(inFixScope).map((x) => x.ref);
}

/**
 * What a judgement left unfixed, read from the fix sent right after it: the accepted items not in its refs (all of
 * them when no fix went), the reversals it carried no boundary for, and the questions unless it carried penne's note.
 * An item the judgement sent to a follow-up or skipped is not left unfixed: the decision was not to fix it here.
 */
export function unfixedOf(events: LifecycleRecord[], t: number, fix: LifecycleRecord | undefined, note: string, s4 = false): Unfixed {
  const a = events[t]?.attrs ?? {};
  const refs = sentRefs(events, t, fix);
  const bounds = fix ? (Array.isArray(fix.attrs?.boundary_refs) ? strs(fix.attrs.boundary_refs) : oscillationsOf(a).map((o) => o.ref)) : [];
  return {
    // a follow-up was decided not to be fixed here, so it is not left unfixed; a skipped item is not left unfixed in
    // an S4 pass (its reply carries the reason), but is in the review loop. So is an accepted must whose action says
    // followup (a must is fixed whatever the action says)
    accepted: acceptedAt(events, t).filter((x) => !refs.includes(x.ref) && !isFollowup(x) && !isSetAside(x) && !(s4 && x.action === "skip")),
    questions: fix && note.trim() ? [] : strs(a.escalated_claims),
    reversals: oscillationsOf(a).filter((o) => !bounds.includes(o.ref)),
  };
}

/**
 * What the fix right after a judgement was sent to fix and nothing on record showed fixed, when no judgement came
 * after that fix to take over what was left: everything it carried when no confirm finished after it, or what the
 * last confirm that finished reported still unresolved.
 */
function unsettledOf(events: LifecycleRecord[], t: number): { unconfirmed: boolean; accepted: AcceptedItem[]; reversals: OscillationItem[] } {
  const none = { unconfirmed: false, accepted: [], reversals: [] };
  const fix = fixAfter(events, t);
  if (!fix) return none;
  const f = events.indexOf(fix);
  if (events.some((e, i) => i > f && e.event === "s2_triage_done" && !e.attrs?.failed)) return none;
  let c = -1;
  for (let i = events.length - 1; i > f; i -= 1) if (events[i].event === "s2_confirm_done" && !events[i].attrs?.failed) { c = i; break; }
  const a = events[t].attrs ?? {};
  const refs = sentRefs(events, t, fix);
  const u = unfixedOf(events, t, fix, "", s4Triage(events, t));
  // what the fix carried, whatever the recommended action says: it was sent, and until a confirm says otherwise it is open
  const sent = acceptedAt(events, t).filter((x) => refs.includes(x.ref));
  const bounds = oscillationsOf(a).filter((o) => !u.reversals.some((r) => r.ref === o.ref));
  if (c < 0) return { unconfirmed: true, accepted: sent, reversals: bounds };
  const open = strs(events[c].attrs?.unresolved_refs);
  return { unconfirmed: false, accepted: sent.filter((x) => open.includes(x.ref)), reversals: bounds.filter((o) => open.includes(o.ref)) };
}

/**
 * A finding left out of this change but worth keeping. `source` says why it is one when the judgement did not decide
 * so: `unsent` for an accepted must / should no fix carried (the loop closed, was capped, or left shoulds for later).
 */
export interface FollowupItem { severity: string; /** the weight the judgement gave, when penne set another (a must put off is a should here) */ judgedSeverity?: string; claim: string; path?: string; reason?: string; source?: "unsent" | "r2"; line?: number | null; round?: number }

/**
 * The refs the confirm after this fix reported unresolved. A fix carrying a finding made it fixed until a confirm
 * says otherwise; this is the confirm's `unresolved_refs`, read from the fix up to the next judgement or fix.
 */
function openAfterFix(events: LifecycleRecord[], fix: LifecycleRecord | undefined): Set<string> {
  const open = new Set<string>();
  if (!fix) return open;
  const f = events.indexOf(fix);
  for (let j = f + 1; j < events.length; j += 1) {
    const name = events[j].event;
    if (name === "s2_fix_sent" || name === "s2_triage_done") break;
    if (name === "s2_confirm_done" && !events[j].attrs?.failed) for (const ref of strs(events[j].attrs?.unresolved_refs)) open.add(ref);
  }
  return open;
}

/**
 * The follow-ups of the current pass: accepted items whose recommended handling is `followup`, rejected ones marked
 * `followup`, and every accepted must / should that no fix carried (the fix right after its judgement, if any, did not
 * name it) unless it was skipped: an accepted finding never leaves the lane without a trace. Only the judgements of
 * the diff review, the final review, a confirm and the device check count; the judgements on PR feedback go to an
 * Issue draft instead. The same words on the same file are one item, and a finding some fix of the pass carried is
 * none: it was fixed here.
 */
export function followupsOf(events: LifecycleRecord[]): FollowupItem[] {
  const start = passStartAt(events, events.length - 1);
  const key = (x: { path?: string; claim: string }) => `${x.path ?? ""}|${x.claim}`;
  // the judgements of this pass that leave a follow-up for the TODO or the card: the ones on PR feedback go to an Issue draft
  const judges = events.flatMap((e, i) => {
    if (i <= start || e.event !== "s2_triage_done" || e.attrs?.failed) return [];
    const kind = String(e.attrs?.kind ?? "blind");
    if (kind !== "blind" && kind !== "final" && kind !== "confirm" && kind !== "device" && kind !== "kept") return [];
    if (kind === "confirm" && feedbackPassAt(events, i) >= 0) return [];
    return [i];
  });
  // what each judgement's fix carried; a finding some fix of this pass carried was fixed here, even when another
  // judgement had left it for later
  const sentOf = new Map<number, string[]>();
  const fixed = new Set<string>();
  for (const i of judges) {
    const fix = fixAfter(events, i);
    const refs = sentRefs(events, i, fix);
    sentOf.set(i, refs);
    // a fix marks a finding fixed only when the confirm after it did not report it unresolved: a fix the confirm
    // found not to have taken the finding is not a fix, and a later judgement reading the same finding back as a
    // follow-up must not drop it from here too (a finding never leaves the lane without a trace)
    const open = openAfterFix(events, fix);
    for (const a of acceptedAt(events, i)) if (refs.includes(a.ref) && !open.has(a.ref)) fixed.add(key(a));
  }
  const out: FollowupItem[] = [];
  const seen = new Set<string>();
  // the refs already listed: a finding that repeats a corrected one is the same follow-up, worded again
  const listed = new Set<string>();
  const push = (x: FollowupItem, ref?: string) => {
    const k = key(x);
    if (seen.has(k) || fixed.has(k)) return;
    seen.add(k);
    if (ref !== undefined) listed.add(ref);
    out.push(x);
  };
  for (const i of judges) {
    const refs = sentOf.get(i) ?? [];
    for (const a of acceptedAt(events, i)) {
      const where = a.path ? { path: a.path } : {};
      const extra = { ...(a.line !== undefined ? { line: a.line } : {}), ...(typeof events[i].attrs?.round === "number" ? { round: events[i].attrs!.round as number } : {}) };
      const k = key({ ...a, ...where });
      if (seen.has(k) || fixed.has(k)) continue;
      if (a.correction_ref && listed.has(a.correction_ref)) continue;
      if (isFollowup(a)) push({ severity: a.severity, ...judgedWeight(a), claim: a.claim, ...where, ...extra }, a.ref);
      else if ((a.severity === "must" || a.severity === "should") && a.action !== "skip" && !refs.includes(a.ref)) push({ severity: a.severity, ...judgedWeight(a), claim: a.claim, ...where, ...extra, source: "unsent" }, a.ref);
    }
    for (const r of rejectedOf(events[i].attrs)) {
      if (!r.followup) continue;
      push({ severity: String(r.severity ?? "should") || "should", claim: r.claim, ...(r.reason ? { reason: r.reason } : {}) });
    }
  }
  return out;
}

export interface ShouldFixCounts {
  /** accepted should findings of this pass's judgements, one per path|claim */
  accepted: number;
  /** of those, the findings some judgement recommended fixing with one of the harms shown */
  fix: number;
  /** of those, the findings a judgement said to fix but left without a basis or a harm (read as follow-ups) */
  fixWithoutBasis: number;
}

/**
 * The shoulds the current pass's judgements accepted and the ones they recommended fixing, counted from the
 * judgement records alone (blind / final / confirm / device, never the PR feedback's). The same finding named again
 * (same path and claim) is one item, and a finding any judgement recommended a fix for with a basis is counted on the
 * fix side even when another judgement left its basis out. This is the one count the submit card and the state share.
 */
export function shouldFixCounts(events: LifecycleRecord[]): ShouldFixCounts {
  const start = passStartAt(events, events.length - 1);
  const byKey = new Map<string, { fix: boolean; without: boolean }>();
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (i <= start || e.event !== "s2_triage_done" || e.attrs?.failed) continue;
    const kind = String(e.attrs?.kind ?? "blind");
    if (kind !== "blind" && kind !== "final" && kind !== "confirm" && kind !== "device" && kind !== "kept") continue;
    if (kind === "confirm" && feedbackPassAt(events, i) >= 0) continue;
    for (const a of acceptedAt(events, i)) {
      if (a.severity !== "should") continue;
      const k = `${a.path ?? ""}|${a.claim}`;
      const cur = byKey.get(k) ?? { fix: false, without: false };
      // a fix with a basis counts on the fix side; one the `triage` value read back as a follow-up counts apart.
      // A record from before the value existed (an action fix with no basis and no read-back mark) counts as neither
      if (a.action === "fix" && a.fix_basis) cur.fix = true;
      else if (a.claimed_action === "fix") cur.without = true;
      byKey.set(k, cur);
    }
  }
  const values = [...byKey.values()];
  return {
    accepted: values.length,
    fix: values.filter((v) => v.fix).length,
    fixWithoutBasis: values.filter((v) => !v.fix && v.without).length,
  };
}

export interface Leftover { severity: string; /** the weight the judgement gave, when penne set another */ judgedSeverity?: string; claim: string; path?: string; /** the handling the judgement recommended, so the card can say why it is still here */ action?: string; /** the harm the judgement gave for a recommended fix: the card marks a should that was to be fixed here */ fixBasis?: string }

/**
 * What the submit card lists as accepted but not fixed, read from what was sent, never from the transition as it
 * stands now: the last judgement's unfixed items, then those of every judgement of the same pass penne answered.
 * What a fix carried is listed too when no judgement followed it: marked unconfirmed when no confirm finished after
 * it, or found unfixed when the last confirm that finished left it unresolved.
 * The same words on the same file named again are listed once.
 */
export function submitLeftovers(events: LifecycleRecord[]): Leftover[] {
  // a judgement that failed judged nothing: the last one that did is where the loop stood
  // within this pass: an earlier pass's judgement was listed on its own submit card
  const start = passStartAt(events, events.length - 1);
  let last = -1;
  for (let i = events.length - 1; i > start; i -= 1) if (events[i].event === "s2_triage_done" && !events[i].attrs?.failed) { last = i; break; }
  if (last < 0) return [];
  const judgements = [last, ...events.flatMap((e, t) => (t > start && t !== last && e.event === "s2_triage_done" && !e.attrs?.failed && answerTo(events, t) >= 0 ? [t] : []))];
  const out: Leftover[] = [];
  const seen = new Set<string>();
  // the same words on the same file are one finding, as stagnation counts them; a question has no file
  const push = (key: string, item: Leftover) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const aside = new Set<string>();
  const keyOf = (x: { path?: string; claim: string }) => `${x.path ?? ""}|${x.claim}`;
  for (const t of judgements) {
    const r = answerTo(events, t);
    const note = r >= 0 && events[r].attrs?.decision !== "accept" ? String(events[r].attrs?.note ?? "") : "";
    const sent = unsettledOf(events, t);
    const mark = sent.unconfirmed ? "（修正に回したが、直ったかを確かめずに進めた）" : "（確認で直っていないと分かった）";
    for (const a of sent.accepted) push(keyOf(a), { severity: a.severity, ...judgedWeight(a), claim: `${a.claim}${mark}`, ...(a.path ? { path: a.path } : {}), ...(a.action ? { action: a.action } : {}), ...(a.fix_basis ? { fixBasis: a.fix_basis } : {}) });
    for (const o of sent.reversals) push(keyOf(o), { severity: o.severity, claim: `${o.claim}${mark}`, ...(o.path ? { path: o.path } : {}) });
    const left = unfixedOf(events, t, fixAfter(events, t), note, s4Triage(events, t));
    for (const a of left.accepted) push(keyOf(a), { severity: a.severity, ...judgedWeight(a), claim: a.claim, ...(a.path ? { path: a.path } : {}), ...(a.action ? { action: a.action } : {}), ...(a.fix_basis ? { fixBasis: a.fix_basis } : {}) });
    // what penne set aside on the stuck card is not fixed and not followed up, so the submit card lists it as she decided it;
    // a finding that repeats it by citation is the same entry
    for (const a of acceptedAt(events, t)) {
      if (!isSetAside(a) || isFollowup(a)) continue;
      const cited = a.correction_ref ?? "";
      if (aside.has(a.ref) || (cited && aside.has(cited))) continue;
      aside.add(a.ref);
      if (cited) aside.add(cited);
      push(keyOf(a), { severity: a.severity, ...judgedWeight(a), claim: a.claim, ...(a.path ? { path: a.path } : {}), ...(a.action ? { action: a.action } : {}), ...(a.fix_basis ? { fixBasis: a.fix_basis } : {}) });
    }
    for (const o of left.reversals) {
      push(keyOf(o), { severity: o.severity, claim: `${o.claim}（${o.prior_ref ? `${o.prior_ref} の` : "前の巡の"}修正と往復。境目は決めず、今のコードのまま進めた）`, ...(o.path ? { path: o.path } : {}) });
    }
    for (const q of left.questions) push(q, { severity: "判断", claim: `${q}（判定が penne の判断を求めた指摘。直す指示を出さずに進めた）` });
  }
  return out;
}

/** one judgement's counts, as the Lanes chart reads them */
export interface ReviewRound {
  /** the round the judgement belongs to */
  round: number;
  /** what the judgement judged: blind / final / device / confirm / feedback */
  kind: string;
  must: number;
  should: number;
  nit: number;
  /** accepted items no finished confirm showed fixed: accepted = must + should + nit = fixed + open */
  open: number;
}

/**
 * The counts of every judgement of the review loop, one row each, failed ones left out. must / should / nit count
 * what the judgement accepted (a rejected finding is not on the chart). `open` is what no finished confirm showed
 * fixed: an item the fix after the judgement did not carry, or the confirm that followed listed as unresolved.
 */
export function reviewRounds(events: LifecycleRecord[]): ReviewRound[] {
  const out: ReviewRound[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e.event !== "s2_triage_done" || e.attrs?.failed) continue;
    const accepted = acceptedAt(events, i);
    const must = accepted.filter((x) => x.severity === "must").length;
    const should = accepted.filter((x) => x.severity === "should").length;
    const nit = accepted.filter((x) => x.severity === "nit").length;
    const fix = fixAfter(events, i);
    const refs = sentRefs(events, i, fix);
    let fixed = 0;
    if (fix) {
      const f = events.indexOf(fix);
      // the next fix of the pass ends the window the confirm is read from: a later confirm judged other work
      let next = events.length;
      for (let j = f + 1; j < events.length; j += 1) if (events[j].event === "s2_fix_sent") { next = j; break; }
      let confirm = -1;
      for (let j = f + 1; j < next; j += 1) if (events[j].event === "s2_confirm_done" && !events[j].attrs?.failed) confirm = j;
      if (confirm >= 0) {
        const open = new Set(strs(events[confirm].attrs?.unresolved_refs));
        fixed = accepted.filter((x) => refs.includes(x.ref) && !open.has(x.ref)).length;
      }
    }
    out.push({ round: num(e.attrs?.round), kind: String(e.attrs?.kind ?? "blind"), must, should, nit, open: accepted.length - fixed });
  }
  return out;
}

/**
 * Whether penne's answer closed the review in this pass: the answer right before the last converge of the pass, or,
 * in a pass that never converged, the answer that ended the loop (PR feedback that accepted nothing). Such an answer
 * is "go on as it is", or a continue on a judgement that sent no fix. What came after the review was closed (a device
 * check run again or gone on from, its judgement answered or within the limit) does not change who closed it.
 */
export function closedByPenne(events: LifecycleRecord[]): boolean {
  const start = passStartAt(events, events.length - 1);
  const closes = (r: number) => r > start && events[r]?.event === "s2_review_resumed"
    && (events[r].attrs?.decision === "accept" || (answeredJudgementAt(events, r) >= 0 && !fixAfter(events, r)));
  // the loop event right before `i`
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j -= 1) if ((REVIEW_EVENTS as readonly string[]).includes(events[j].event)) return j;
    return -1;
  };
  // the close at converge `c`: its answer, unless that answer was to a stop past an earlier close of the same review
  // (a device check that failed after the review closed, no fix since) — going on there re-closes it, and the
  // earlier close stands
  const closedAt = (c: number): boolean => {
    const r = before(c);
    if (!closes(r)) return false;
    if (answeredJudgementAt(events, r) >= 0) return true;
    let prev = -1;
    for (let i = r - 1; i > start; i -= 1) if (events[i].event === "s2_review_converged") { prev = i; break; }
    if (prev < 0 || events.slice(prev + 1, r).some((e) => e.event === "s2_fix_sent")) return true;
    return closedAt(prev);
  };
  const converged = events.map((e) => e.event).lastIndexOf("s2_review_converged");
  if (converged > start) return closedAt(converged);
  // a pass that ended without converging (PR feedback that accepted nothing): the answer that ended it
  return closes(before(events.length));
}

/** what an answer leaves on the submit card from the judgement it answers */
export interface LeftCount { accepted: number; questions: number; reversals: number }

/**
 * Where penne's answer on a stuck card takes the lane: a stage run again, a fix (what it carries), the final
 * review, or the review closed (and whether the device check then runs, for the first time or again).
 */
export type StuckOutcome =
  | { to: "retry"; /** penne's continue lets the High role's fallback run the final review (a window wait) */ highFallback?: boolean }
  | { to: "fix"; all: boolean; refs: string[]; boundaries: number; note: boolean; left: LeftCount }
  | { to: "final"; left: LeftCount }
  | { to: "close"; device: "first" | "again" | "none"; left: LeftCount }
  /** penne took the code: the lane waits at its hand turn, the engine starts nothing until "直した" */
  | { to: "hand" }
  /** the lane goes back to its plan (the card's "計画から考え直す"): it waits for the planner, then the plan review and the GO */
  | { to: "plan" }
  /** the repo's checks before the convergence run again at the head */
  | { to: "checks" };

/** the two things the answer's path depends on beyond the record: whether the final review is skipped, and the device slot */
export interface AnswerEnv { skipsFinal(events: LifecycleRecord[]): boolean; deviceOn: boolean }

/**
 * Where an answer takes a lane stopped in the loop, found by appending it to the record and following the same
 * transition the loop runs, through the steps that start nothing (a final review skipped, the loop converging,
 * the device check skipped). Undefined when the loop is not waiting for penne.
 */
export function answerOutcome(events: LifecycleRecord[], answer: { decision: "continue" | "accept" | "hand_fix" | "replan"; note?: string }, env: AnswerEnv): StuckOutcome | undefined {
  const prior = reviewLoopState(events);
  if (prior.state !== "escalated") return undefined;
  // penne takes the code: nothing is sent, and the lane waits for the hand work to be reported done (DEC-113-11)
  if (answer.decision === "hand_fix") return { to: "hand" };
  // the lane goes back to its plan: no round is run, and the plan is reviewed and gone through the GO again
  if (answer.decision === "replan") {
    return { to: "plan" };
  }
  const mark = (event: string, attrs: Attrs = {}): LifecycleRecord => ({ event, idd_id: events[events.length - 1]?.idd_id ?? "", at: "", attrs });
  const evs = [...events, mark("s2_review_resumed", { decision: answer.decision, note: answer.note ?? "" })];
  const t = answeredJudgementAt(evs, evs.length - 1);
  const leftOf = (fix?: LifecycleRecord): LeftCount => {
    if (t < 0) return { accepted: 0, questions: 0, reversals: 0 };
    const u = unfixedOf(evs, t, fix, answer.decision === "accept" ? "" : answer.note ?? "", s4Triage(evs, t));
    return { accepted: u.accepted.length, questions: u.questions.length, reversals: u.reversals.length };
  };
  let s = reviewLoopState(evs);
  const retry = !!prior.retry && answer.decision === "continue";
  const retryOut = (): StuckOutcome => ({ to: "retry", ...(prior.quotaWait ? { highFallback: true } : {}) });
  // a stop over the checks before the convergence: a continue runs them again (a cap stop sends their failures, below),
  // an accept goes where the checks were taking the lane (the convergence, or a round the mainline's merge skipped)
  const overChecks = checksStopAt(evs, evs.length - 1) >= 0;
  if (overChecks && answer.decision === "continue" && s.state !== "send_fix") return { to: "checks" };
  if (overChecks && answer.decision === "accept" && s.state === "start_blind") return { to: "close", device: "none", left: leftOf() };
  if (s.state === "send_fix") {
    if (retry) return retryOut();
    const scope = fixScope(evs);
    const refs = scope.accepted.map((a) => a.ref);
    const fix = mark("s2_fix_sent", { refs, boundary_refs: scope.boundaries.map((b) => b.ref) });
    return { to: "fix", all: scope.all, refs, boundaries: scope.boundaries.length, note: !!scope.note.trim(), left: leftOf(fix) };
  }
  if (s.state === "start_blind" && s.kind === "final") {
    if (!env.skipsFinal(evs)) return retry ? retryOut() : { to: "final", left: leftOf() };
    evs.push(mark("s2_review_converged"));
    s = reviewLoopState(evs);
  }
  if (s.state === "converge") {
    evs.push(mark("s2_review_converged"));
    s = reviewLoopState(evs);
  }
  // once the final review is skipped the loop closes whatever stage stopped; only a stopped device check runs again
  if (s.state === "start_device" && !(retry && prior.retry?.state === "start_device")) {
    const device = !env.deviceOn ? "none" : events.some((e) => e.event === "s2_device_started") ? "again" : "first";
    return { to: "close", device, left: leftOf() };
  }
  if (s.state === "done" && !retry) return { to: "close", device: "none", left: leftOf() };
  return retryOut();
}

/** label for the lane list while the loop runs */
export function reviewLoopLabel(s: ReviewLoopState, rank?: number): string | undefined {
  switch (s.state) {
    case "start_blind":
      return s.kind === "final" ? "最後のレビュー待ち" : `レビュー待ち（${s.round} 巡目）`;
    case "running_blind": return s.kind === "final" ? "最後のレビュー中" : s.kind === "device" ? "絵の見比べ中" : `レビュー中（${s.round} 巡目）`;
    case "running_map": return "危ない経路の下調べ中";
    case "start_triage":
    case "running_triage": return s.kind === "feedback" ? "PR の指摘の判定中" : "指摘の判定中";
    case "send_fix":
    case "fixing": return `修正中（${s.round} 巡目）`;
    case "start_confirm":
    case "running_confirm": return "修正の確認中";
    case "awaiting_merge": return "衝突の解消中";
    case "awaiting_records_fix": return "記録の直し待ち";
    case "recheck_intent": return "記録の再検査中";
    case "awaiting_order": {
      const lanes = s.opponents.map((o) => o.lane).join("、") || "先の lane";
      const files = [...new Set(s.opponents.flatMap((o) => o.files))];
      const shown = `${files.slice(0, 3).join("、")}${files.length > 3 ? ` ほか ${files.length - 3} 件` : ""}`;
      const parts = [rank !== undefined ? `${rank} 番目` : "", files.length ? shown : ""].filter(Boolean);
      return `${lanes} の取り込みを待っている${parts.length ? `（${parts.join("・")}）` : ""}`;
    }
    case "start_device":
    case "running_device": return "絵の見比べ中";
    default: return undefined;
  }
}

/** whether the lane's last failed start is too recent to try again (only while failures are counting) */
export function startRetryWaiting(events: LifecycleRecord[], now = Date.now()): boolean {
  if (startFailures(events) === 0) return false;
  const last = [...events].reverse().find((e) => e.event === "s2_review_run_failed");
  const at = last ? Date.parse(last.at) : NaN;
  return Number.isFinite(at) && now - at < START_RETRY_MS;
}

/** consecutive start failures since the last loop event (they are recorded but do not move the state) */
export function startFailures(events: LifecycleRecord[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === "s2_review_run_failed") { n += 1; continue; }
    if ((REVIEW_EVENTS as readonly string[]).includes(events[i].event) || events[i].event === "s2_result") break;
  }
  return n;
}

/** lanes that go through this loop (as opposed to lanes that reached S3 before it existed) */
export function isLoopLane(events: LifecycleRecord[]): boolean {
  return events.some((e) => (REVIEW_EVENTS as readonly string[]).includes(e.event));
}
