/**
 * What each open lane's remaining machine time looks like, where it stops, and whether it is overdue
 * (DEC-104-2, DEC-104-3). The forecast stops at the human gate ahead: a gate's own length is not predicted
 * (INV-104-2), and a lane already waiting at one gets no time back. A lane waiting for another lane starts at the
 * other's finish. Everything is read: the door writes nothing (INV-104-4).
 */

import { pipelineSlotDeclared } from "../config/pipeline.ts";
import { readBacklog, readLifecycle } from "../ledger/read.ts";
import { laneDurations, fixRoundStarts, type GateKey, type LaneDurations, type StageKey, type StagePoint, type StageSplitContext, type WaitKey } from "../ledger/stage-spans.ts";
import { fixCapReached, reviewLoopState } from "../ledger/review-loop.ts";
import { currentLandApproval } from "../overlay/land.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { readStageDurations, usualFor, type StageStat, type StageUsual } from "./stage-durations.ts";

const CLOSE_EVENTS: readonly string[] = ["lane_close", "s1_defer", "s3_defer"];

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface ForecastNow {
  kind: "stage" | "gate" | "wait";
  stage?: StageKey;
  gate?: GateKey;
  wait?: WaitKey;
  /** when the lane came to this stage, gate or wait */
  since: string;
  elapsedMin: number;
}

export interface ForecastRemaining {
  stage: StageKey;
  minutes: number;
}

export interface ForecastEta {
  /** the time the machine stages reach the next human gate, or null when none can be given */
  at: string | null;
  /** the gate the lane stops at, or `end` when its work ends */
  stopsAt: GateKey | "end" | null;
  /** why no time can be given: a fix round at its cap, or a dependency that cannot be resolved */
  unknown?: "fix_cap" | "dependency";
  /** the lane it waits on and the gate that lane stops at (the wait is that lane's, not this one's) */
  via?: { lane: string; stopsAt: GateKey | "end" | null };
  remaining: ForecastRemaining[];
}

export interface ForecastLaneView {
  iddId: string;
  area: string;
  now: ForecastNow;
  /** the machine stage is past its threshold: two of its p75, never under ten minutes */
  anomaly: boolean;
  eta: ForecastEta;
}

export interface ForecastView {
  ok: true;
  generatedAt: string;
  /** one usual table per repo that has an open lane */
  usual: StageUsual[];
  lanes: ForecastLaneView[];
}

function isClosed(events: LifecycleRecord[]): boolean {
  return events.some((e) => CLOSE_EVENTS.includes(e.event));
}

function elapsedMin(since: string, now: number): number {
  const at = Date.parse(since);
  return Number.isFinite(at) ? round1(Math.max(0, (now - at) / 60000)) : 0;
}

function unknownEta(unknown: "fix_cap" | "dependency"): ForecastEta {
  return { at: null, stopsAt: null, unknown, remaining: [] };
}

function sum(remaining: ForecastRemaining[]): number {
  return remaining.reduce((n, r) => n + r.minutes, 0);
}

function iso(base: number | string, minutes: number): string {
  const at = typeof base === "number" ? base : Date.parse(base);
  return new Date(at + minutes * 60000).toISOString();
}

/** the lane a wait waits on: the order check's first opponent, or the dependency's first lane */
function opponentOf(wait: "order" | "dependency", events: LifecycleRecord[]): string | null {
  if (wait === "dependency") {
    const last = [...events].reverse().find((e) => e.event === "blocked_by_dependency");
    const dep = last?.attrs?.depends_on;
    return Array.isArray(dep) && dep.length ? String(dep[0]) : null;
  }
  const loop = reviewLoopState(events);
  if (loop.state !== "awaiting_order") return null;
  return loop.opponents[0]?.lane ?? null;
}

/**
 * Every open lane's now and its forecast, read once. `now` is an argument so a test can fix the clock. The whole
 * set is returned in one response: a lane waiting on another computes that lane's forecast anyway (DEC-104-6).
 */
export function buildForecast(opts: { now?: number } = {}): ForecastView {
  const now = opts.now ?? Date.now();
  const rows = readStageDurations();
  const backlog = readBacklog();
  const eventsById = new Map<string, LifecycleRecord[]>();
  for (const e of readLifecycle()) {
    const list = eventsById.get(e.idd_id);
    if (list) list.push(e);
    else eventsById.set(e.idd_id, [e]);
  }
  const backlogById = new Map(backlog.map((r) => [r.idd_id, r]));
  const open = backlog.filter((r) => !isClosed(eventsById.get(r.idd_id) ?? []));
  const usualByArea = new Map<string, StageUsual>();
  const usualOf = (area: string): StageUsual => {
    const found = usualByArea.get(area);
    if (found) return found;
    const built = usualFor(area, rows);
    usualByArea.set(area, built);
    return built;
  };
  const ctx: StageSplitContext = { landApproved: currentLandApproval };
  const declaredPlanReview = pipelineSlotDeclared("plan_review");

  function etaOf(id: string, events: LifecycleRecord[], usual: StageUsual, point: StagePoint, elapsed: number, stack: Set<string>): ForecastEta {
    const stat = (stage: StageKey): StageStat => usual.stages[stage];
    const remaining = (stage: StageKey, from = 0): ForecastRemaining => ({ stage, minutes: round1(Math.max(0, stat(stage).median - from)) });
    const whole = (stage: StageKey): ForecastRemaining => ({ stage, minutes: round1(stat(stage).median) });

    if (point.kind === "gate") return { at: null, stopsAt: point.gate, remaining: [] };
    if (point.kind === "wait") {
      if (point.wait === "outside" || point.wait === "quota") return { at: null, stopsAt: null, remaining: [] };
      if (point.wait === "slot") {
        // the cap wait is not a stage's time: the implementation's full usual is ahead of it
        const plan = [whole("impl"), whole("review"), whole("checks")];
        return { at: iso(now, sum(plan)), stopsAt: "sign", remaining: plan };
      }
      const opponent = opponentOf(point.wait, events);
      if (!opponent || stack.has(opponent)) return unknownEta("dependency");
      if (!backlogById.has(opponent)) return unknownEta("dependency");
      const ahead = resolve(opponent, new Set([...stack, id]));
      if (!ahead) return unknownEta("dependency");
      if (ahead.eta.unknown) return unknownEta(ahead.eta.unknown);
      const mine = point.wait === "order" ? [whole("review"), whole("checks")] : ownAfterWait(events, usual);
      // the other lane's time is when it reaches its next gate, so it is this lane's finish only when that gate is
      // the end; at any other gate (and when there is no time at all) the wait waits on that lane
      if (ahead.eta.stopsAt !== "end" || ahead.eta.at === null) {
        return { at: null, stopsAt: ahead.eta.stopsAt, via: { lane: opponent, stopsAt: ahead.eta.stopsAt }, remaining: mine };
      }
      return { at: iso(ahead.eta.at, sum(mine)), stopsAt: "sign", remaining: mine };
    }
    if (point.kind === "closed") return { at: new Date(now).toISOString(), stopsAt: "end", remaining: [] };

    switch (point.stage) {
      case "plan": {
        const plan = [remaining("plan", elapsed), ...(declaredPlanReview ? [whole("plan_review")] : [])];
        return { at: iso(now, sum(plan)), stopsAt: "go", remaining: plan };
      }
      case "plan_review": {
        const plan = [remaining("plan_review", elapsed)];
        return { at: iso(now, sum(plan)), stopsAt: "go", remaining: plan };
      }
      case "impl": {
        const plan = [remaining("impl", elapsed), whole("review"), whole("checks")];
        return { at: iso(now, sum(plan)), stopsAt: "sign", remaining: plan };
      }
      case "review": {
        const plan = [remaining("review", elapsed), whole("checks")];
        return { at: iso(now, sum(plan)), stopsAt: "sign", remaining: plan };
      }
      case "fix": {
        if (fixCapReached(events, { forForecast: true })) return unknownEta("fix_cap");
        const plan = [remaining("fix", elapsed), whole("checks")];
        return { at: iso(now, sum(plan)), stopsAt: "sign", remaining: plan };
      }
      case "checks": {
        const plan = [remaining("checks", elapsed)];
        return { at: iso(now, sum(plan)), stopsAt: "sign", remaining: plan };
      }
      case "land": {
        const plan = [remaining("land", elapsed)];
        return { at: iso(now, sum(plan)), stopsAt: "end", remaining: plan };
      }
    }
  }

  /** what a dependency-waiting lane still owes: the machine stages from where its work stands, all unstarted */
  function ownAfterWait(events: LifecycleRecord[], usual: StageUsual): ForecastRemaining[] {
    const names = events.map((e) => e.event);
    const whole = (stage: StageKey): ForecastRemaining => ({ stage, minutes: round1(usual.stages[stage].median) });
    if (!names.includes("s2_start") || !names.includes("s2_result")) return [whole("impl"), whole("review"), whole("checks")];
    const loop = reviewLoopState(events);
    if (loop.state === "done" || loop.state === "converge" || loop.state === "start_device" || loop.state === "running_device" || loop.state === "running_checks") return [whole("checks")];
    return fixRoundStarts(events).length ? [whole("fix"), whole("checks")] : [whole("review"), whole("checks")];
  }

  function resolve(id: string, stack: Set<string>): { now: ForecastNow; anomaly: boolean; eta: ForecastEta } | null {
    const rec = backlogById.get(id);
    if (!rec) return null;
    const events = eventsById.get(id) ?? [];
    const usual = usualOf(rec.area);
    const d: LaneDurations = laneDurations(events, ctx, now);
    const point = d.point;
    // a summed stage's elapsed is the lane's total on it (a question leaves it and comes back); a fix round's is
    // the round's own length; a gate's and a wait's is the stretch since it began
    const elapsed = point.kind === "stage"
      ? point.stage === "fix"
        ? d.fixRounds[(point.fixRound ?? 1) - 1] ?? 0
        : d.stages[point.stage] ?? 0
      : elapsedMin(d.since, now);
    const nowView: ForecastNow = point.kind === "stage"
      ? { kind: "stage", stage: point.stage, since: d.since, elapsedMin: round1(elapsed) }
      : point.kind === "gate"
        ? { kind: "gate", gate: point.gate, since: d.since, elapsedMin: round1(elapsed) }
        : point.kind === "wait"
          ? { kind: "wait", wait: point.wait, since: d.since, elapsedMin: round1(elapsed) }
          : { kind: "stage", stage: "land", since: d.since, elapsedMin: round1(elapsed) };
    const anomaly = point.kind === "stage" && elapsed > usual.stages[point.stage].threshold;
    return { now: nowView, anomaly, eta: etaOf(id, events, usual, point, elapsed, stack) };
  }

  const areas = [...new Set(open.map((r) => r.area))].sort();
  const lanes: ForecastLaneView[] = [];
  for (const rec of open) {
    const r = resolve(rec.idd_id, new Set());
    if (!r) continue;
    lanes.push({ iddId: rec.idd_id, area: rec.area, now: r.now, anomaly: r.anomaly, eta: r.eta });
  }
  return { ok: true, generatedAt: new Date(now).toISOString(), usual: areas.map(usualOf), lanes };
}
