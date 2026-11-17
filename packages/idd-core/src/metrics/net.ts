import { acceptedAt, fixesNow, rejectedOf } from "../ledger/review-loop.ts";
import type { AcceptedItem } from "../ledger/review-loop-reference.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import type { MetricsLeakArea } from "./leaks.ts";

/**
 * What the review net did in a period, counted from the judgements the ledger froze: where each finding ended up, which
 * must came back after a fix, and (in `leaks.ts`) which landed lines were rewritten soon after. Everything is read from
 * the `s2_triage_done` event itself. The run directories the findings came from are removed after a week, so no
 * number here depends on them, and a value the event does not hold is shown as "no record" instead of being guessed.
 */

/** the group for a reviewer role or a reviewer's weight that the event does not let us decide */
export const NET_NO_RECORD = "記録なし";

/** the four places a finding ends up; a person's decision (escalated) is outside them */
export type NetFate = "accepted" | "followup" | "skip" | "rejected";

/** one group of the table: a reviewer role and the weight the reviewer gave the finding */
export interface NetFateRow {
  role: string;
  /** the reviewer's own weight (must / should / nit), or "記録なし" */
  weight: string;
  /** the findings of the group; the four counts below add up to it */
  total: number;
  accepted: number;
  followup: number;
  skip: number;
  rejected: number;
}

/** a must accepted again after a fix, in the round it came back */
export interface ReturnedMust {
  lane: string;
  /** the ref of the first round's must of this run of returns, as `<round>-<kind>/<ref>` */
  previous: string;
  /** the ref of the must as it came back last */
  returned: string;
  /** the rounds between, when the must came back more than once in the period */
  via: string[];
  /** how many times the must came back, in the period */
  returns: number;
  path: string;
  /** the time of the judgement the must came back in */
  at: string;
}

export interface MetricsNet {
  /** judgements (not failed ones) made in the period */
  judgements: number;
  /** claims handed to a person; they carry no weight, path or role, so they are only counted */
  escalated: number;
  /** per role and weight; a finding found by several roles is in each of them */
  fates: NetFateRow[];
  /** per weight, every finding once, however many roles found it */
  weights: NetFateRow[];
  returned: ReturnedMust[];
  /** per repo; an area whose git could not be read has no rows to show */
  leaks: MetricsLeakArea[];
}

const WEIGHTS = ["must", "should", "nit"];

/** how close two claims must be to read as the same finding (the dice coefficient of their character pairs) */
export const NEAR_CLAIM = 0.45;

function pairs(text: string): Map<string, number> {
  const t = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const out = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** how alike two claims are, 0 to 1: the share of character pairs they have in common */
export function claimLikeness(a: string, b: string): number {
  const x = pairs(a);
  const y = pairs(b);
  let common = 0;
  let sx = 0;
  let sy = 0;
  for (const [g, c] of x) {
    sx += c;
    common += Math.min(c, y.get(g) ?? 0);
  }
  for (const c of y.values()) sy += c;
  return sx + sy === 0 ? 0 : (2 * common) / (sx + sy);
}

/** where a finding ended up, with the judgement's weight and handling as penne's corrections left them */
export function fateOf(item: Pick<AcceptedItem, "severity" | "action">): Exclude<NetFate, "rejected"> {
  if (fixesNow(item)) return "accepted";
  return item.action === "followup" ? "followup" : "skip";
}

/** the reviewer's weight as the event froze it; anything else is not a weight */
function weightOf(value: unknown): string {
  return typeof value === "string" && WEIGHTS.includes(value) ? value : NET_NO_RECORD;
}

/** the roles of the round's review runs, which the directory names of a finding are read against */
function roundRoles(events: LifecycleRecord[], triage: number): string[] {
  const round = events[triage].attrs?.round;
  const roles = new Set<string>();
  for (let j = 0; j < triage; j += 1) {
    const e = events[j];
    if (e.event !== "s2_review_started" || e.attrs?.round !== round) continue;
    if (Array.isArray(e.attrs?.run_roles)) for (const r of e.attrs.run_roles) if (typeof r === "string" && r) roles.add(r);
  }
  return [...roles];
}

/**
 * The roles that found a finding. A directory name joins the round, the stage, the role, the model and a hash with
 * hyphens, and the role and the model have hyphens of their own, so the name is not split: it is read against the
 * round's own roles, and the longest role that stands in it between hyphens is the one (`blind-reviewer-final` over
 * `blind-reviewer`). A name no role of the round fits, or a finding with no name, is "no record".
 */
export function rolesFound(from: unknown, known: string[]): string[] {
  const names = Array.isArray(from) ? from.filter((f): f is string => typeof f === "string" && f !== "") : [];
  if (!names.length) return [NET_NO_RECORD];
  const found = new Set<string>();
  for (const name of names) {
    let best: string | undefined;
    for (const role of known) {
      if (!(name.includes(`-${role}-`) || name.startsWith(`${role}-`))) continue;
      if (best === undefined || role.length > best.length) best = role;
    }
    found.add(best ?? NET_NO_RECORD);
  }
  return [...found].sort();
}

function emptyRow(role: string, weight: string): NetFateRow {
  return { role, weight, total: 0, accepted: 0, followup: 0, skip: 0, rejected: 0 };
}

function tally(row: NetFateRow, fate: NetFate): void {
  row.total += 1;
  row[fate] += 1;
}

const rank = (weight: string): number => {
  const i = WEIGHTS.indexOf(weight);
  return i < 0 ? WEIGHTS.length : i;
};

/** the roles in name order with "no record" last, and the weights from the heaviest */
function byRoleAndWeight(a: NetFateRow, b: NetFateRow): number {
  const noRole = (r: string) => (r === NET_NO_RECORD ? 1 : 0);
  return noRole(a.role) - noRole(b.role) || a.role.localeCompare(b.role) || rank(a.weight) - rank(b.weight);
}

/** the fates of the findings judged in the period, per reviewer role and weight */
function fatesOf(byLane: Map<string, LifecycleRecord[]>, inPeriod: (at: string) => boolean): Pick<MetricsNet, "judgements" | "escalated" | "fates" | "weights"> {
  const cells = new Map<string, NetFateRow>();
  const weights = new Map<string, NetFateRow>();
  let judgements = 0;
  let escalated = 0;
  for (const lane of [...byLane.keys()].sort()) {
    const events = byLane.get(lane)!;
    events.forEach((e, i) => {
      if (e.event !== "s2_triage_done" || e.attrs?.failed || !inPeriod(e.at)) return;
      judgements += 1;
      if (Array.isArray(e.attrs?.escalated_claims)) escalated += e.attrs.escalated_claims.length;
      const known = roundRoles(events, i);
      const place = (from: unknown, reported: unknown, fate: NetFate): void => {
        const weight = weightOf(reported);
        const wRow = weights.get(weight) ?? weights.set(weight, emptyRow("", weight)).get(weight)!;
        tally(wRow, fate);
        for (const role of rolesFound(from, known)) {
          const key = `${role}\u0000${weight}`;
          tally(cells.get(key) ?? cells.set(key, emptyRow(role, weight)).get(key)!, fate);
        }
      };
      for (const x of acceptedAt(events, i)) place(x.from, x.reported_severity, fateOf(x));
      for (const x of rejectedOf(e.attrs)) {
        const r = x as { from?: unknown; reported_severity?: unknown };
        place(r.from, r.reported_severity, "rejected");
      }
    });
  }
  return {
    judgements,
    escalated,
    fates: [...cells.values()].sort(byRoleAndWeight),
    weights: [...weights.values()].sort((a, b) => rank(a.weight) - rank(b.weight)),
  };
}

interface SeenMust {
  /** the index of the judgement in the lane's events */
  index: number;
  at: string;
  ref: string;
  path: string;
  claim: string;
}

interface Return {
  lane: string;
  prev: SeenMust;
  cur: SeenMust;
}

const sameMust = (a: SeenMust, b: SeenMust): boolean => a.index === b.index && a.ref === b.ref;

/**
 * The musts one lane's judgements accepted again after a fix. A must returns when an earlier round accepted a must at
 * the same path whose claim reads as the same finding, with a fix sent between the two judgements. The claim is
 * rewritten every round, so it is compared by likeness. Of the earlier musts that fit, the newest round's is the one it
 * returned from; and a must that reads as a must the same judgement already holds is that one finding, not a second.
 */
function returnsOf(lane: string, events: LifecycleRecord[]): Return[] {
  const seen: SeenMust[] = [];
  const out: Return[] = [];
  events.forEach((e, index) => {
    if (e.event !== "s2_triage_done" || e.attrs?.failed) return;
    const here: SeenMust[] = [];
    for (const x of acceptedAt(events, index)) {
      if (x.severity !== "must" || typeof x.path !== "string" || !x.path || typeof x.claim !== "string") continue;
      // a round that carries no depth leaves the bare name, which every round starts again from F-1
      const ref = x.ref.includes("/") ? x.ref : `${e.attrs?.round ?? "?"}-${e.attrs?.kind ?? "blind"}/${x.ref}`;
      const cur: SeenMust = { index, at: e.at, ref, path: x.path, claim: x.claim };
      if (here.some((h) => h.path === cur.path && claimLikeness(h.claim, cur.claim) >= NEAR_CLAIM)) continue;
      here.push(cur);
      let best: { m: SeenMust; like: number } | undefined;
      for (const prev of seen) {
        if (prev.path !== cur.path) continue;
        const like = claimLikeness(prev.claim, cur.claim);
        if (like < NEAR_CLAIM) continue;
        if (!events.slice(prev.index + 1, index).some((f) => f.event === "s2_fix_sent")) continue;
        if (!best || prev.index > best.m.index || (prev.index === best.m.index && like > best.like)) best = { m: prev, like };
      }
      if (best) out.push({ lane, prev: best.m, cur });
    }
    seen.push(...here);
  });
  return out;
}

/** a run of returns of the same must, folded to one row: the first round it came from and the round it came back last */
function foldReturns(returns: Return[], inPeriod: (at: string) => boolean): ReturnedMust[] {
  const live = returns.filter((r) => inPeriod(r.cur.at));
  const rows: ReturnedMust[] = [];
  for (const head of live) {
    // the head is the last return of its run: no other return of the period starts from where it came back
    if (live.some((r) => r.lane === head.lane && sameMust(r.prev, head.cur))) continue;
    const via: string[] = [];
    let start = head;
    let returns = 1;
    for (;;) {
      const before = live.find((r) => r.lane === start.lane && sameMust(r.cur, start.prev));
      if (!before) break;
      via.unshift(start.prev.ref);
      start = before;
      returns += 1;
    }
    rows.push({ lane: head.lane, previous: start.prev.ref, returned: head.cur.ref, via, returns, path: head.cur.path, at: head.cur.at });
  }
  return rows;
}

/** the musts that came back after a fix, in judgements made in the period */
function returnedIn(byLane: Map<string, LifecycleRecord[]>, inPeriod: (at: string) => boolean): ReturnedMust[] {
  const rows: ReturnedMust[] = [];
  for (const lane of [...byLane.keys()].sort()) {
    const events = byLane.get(lane)!;
    // reading a lane's judgements is not free, so a lane with no judgement in the period is not read
    if (!events.some((e) => e.event === "s2_triage_done" && !e.attrs?.failed && inPeriod(e.at))) continue;
    rows.push(...foldReturns(returnsOf(lane, events), inPeriod));
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.lane.localeCompare(b.lane) || a.returned.localeCompare(b.returned));
}

/**
 * The review half of the net's numbers: the fates of the period's findings and the musts that came back. The period is
 * cut by the time of the judgement, not by when the lane opened, so an old lane's round of this week is this week's.
 */
export function buildReviewNet(byLane: Map<string, LifecycleRecord[]>, inPeriod: (at: string) => boolean): Omit<MetricsNet, "leaks"> {
  return { ...fatesOf(byLane, inPeriod), returned: returnedIn(byLane, inPeriod) };
}
