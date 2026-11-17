import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { stateDir } from "../paths.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";
import { readBacklog, readLifecycle } from "./read.ts";
import { laneHasEnded } from "./ends.ts";
import { lanesAwaitingPrep } from "../plan/prep.ts";
import { lanesAwaitingExec } from "../plan/exec.ts";

/** the file one engine's start order and urgent marks live in, under the state directory */
export function startOrderPath(): string {
  return join(stateDir(), "start-order.jsonl");
}

/** the operation one appended line records */
export type StartOrderOp = "move" | "urgent" | "unurgent";

/** the two lists as one operation left them: the whole order and the whole set of urgent marks */
export interface StartOrderState {
  order: string[];
  urgent: string[];
}

/** one appended line: the operation, its target, and the order / urgent lists it left behind */
export interface StartOrderRow extends StartOrderState {
  at: string;
  op: StartOrderOp;
  idd_id: string;
  before?: string;
  after?: string;
  position?: number;
}

/** one open lane, in the order the reader returns it */
export interface StartOrderLane {
  idd_id: string;
  title: string;
  area: string;
  /** 1-based position in this result */
  position: number;
  urgent: boolean;
  /** the lane is in the order (the user placed it), not merely sorted by when it was taken in */
  placed: boolean;
  /** the capped stage the lane is next waiting for, when it is waiting for one */
  awaiting: "planner" | "executor" | null;
}

export type StartOrderResult = { ok: true; lanes: StartOrderLane[] } | { ok: false; error: string };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readOrderRows(path: string): StartOrderRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const parsed: unknown = JSON.parse(l);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as StartOrderRow] : [];
      } catch {
        return [];
      }
    });
}

const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

/**
 * The order and the urgent marks the last readable line leaves. No file, or no readable line, is both lists empty.
 * Unreadable lines are skipped, as every other jsonl column is read.
 */
export function readStartOrder(path: string = startOrderPath()): StartOrderState {
  const rows = readOrderRows(path);
  const last = rows[rows.length - 1];
  if (!last) return { order: [], urgent: [] };
  return { order: strList(last.order), urgent: strList(last.urgent) };
}

/** a row's own sort key: the intake time, an empty string when the row carries none */
function createdAtOf(rec: { created_at?: unknown }): string {
  return typeof rec.created_at === "string" ? rec.created_at : "";
}

/**
 * The lanes in the user's order: the placed ones in their placed order, then the rest by when they were taken in
 * (an empty intake time ties, and the input row order breaks it). The urgent marks split the result in two, the
 * marked ones first, each side keeping the order above. Every input row is kept and no row is added; an id in the
 * order that no input row carries is ignored. The input is not modified.
 */
export function orderStartLanes<T extends { idd_id: string; created_at?: string }>(recs: readonly T[], state: StartOrderState): T[] {
  const byId = new Map(recs.map((r) => [r.idd_id, r]));
  const placed: T[] = [];
  const seen = new Set<string>();
  for (const id of state.order) {
    const rec = byId.get(id);
    if (!rec || seen.has(id)) continue;
    seen.add(id);
    placed.push(rec);
  }
  const rest = recs
    .map((rec, index) => ({ rec, index }))
    .filter(({ rec }) => !seen.has(rec.idd_id))
    .sort((a, b) => {
      const byTime = createdAtOf(a.rec).localeCompare(createdAtOf(b.rec));
      return byTime !== 0 ? byTime : a.index - b.index;
    })
    .map(({ rec }) => rec);
  const base = [...placed, ...rest];
  const urgent = new Set(state.urgent);
  return [...base.filter((r) => urgent.has(r.idd_id)), ...base.filter((r) => !urgent.has(r.idd_id))];
}

/**
 * The stages' one entrance: the rows in the user's order. A caller that has read the state hands it over, so one
 * pass over the lanes does not read the file once per stage.
 */
export function inStartOrder<T extends { idd_id: string; created_at?: string }>(recs: readonly T[], state?: StartOrderState): T[] {
  return orderStartLanes(recs, state ?? readStartOrder());
}

/** the open lanes: in the backlog, and not ended */
function openLanes(backlog: BacklogRecord[], events: LifecycleRecord[]): BacklogRecord[] {
  return backlog.filter((r) => !laneHasEnded(r.idd_id, events));
}

/** drop ids the open set does not carry: a closed lane, or one no backlog row names */
function cleanState(state: StartOrderState, open: Set<string>): StartOrderState {
  return {
    order: state.order.filter((id) => open.has(id)),
    urgent: state.urgent.filter((id) => open.has(id)),
  };
}

/** the base order (step 1, before the urgent split) over the open lanes */
function baseOrder(open: BacklogRecord[], order: string[]): string[] {
  const byId = new Map(open.map((r) => [r.idd_id, r]));
  const placed: string[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    placed.push(id);
  }
  const rest = open
    .map((rec, index) => ({ rec, index }))
    .filter(({ rec }) => !seen.has(rec.idd_id))
    .sort((a, b) => {
      const byTime = createdAtOf(a.rec).localeCompare(createdAtOf(b.rec));
      return byTime !== 0 ? byTime : a.index - b.index;
    })
    .map(({ rec }) => rec.idd_id);
  return [...placed, ...rest];
}

/** the reader's table rows for an open set and a state, without reading the file */
function buildView(open: BacklogRecord[], state: StartOrderState): StartOrderResult {
  const sorted = orderStartLanes(open, state);
  const urgent = new Set(state.urgent);
  const placed = new Set(state.order);
  const prep = new Set(lanesAwaitingPrep().map((r) => r.idd_id));
  const exec = new Set(lanesAwaitingExec().map((r) => r.idd_id));
  const lanes = sorted.map((rec, index) => ({
    idd_id: rec.idd_id,
    title: rec.title,
    area: rec.area,
    position: index + 1,
    urgent: urgent.has(rec.idd_id),
    placed: placed.has(rec.idd_id),
    awaiting: prep.has(rec.idd_id) ? "planner" as const : exec.has(rec.idd_id) ? "executor" as const : null,
  }));
  return { ok: true, lanes };
}

/** every open lane in the user's order: the table the Work screen's "next in" column reads */
export function startOrderView(): StartOrderResult {
  const events = readLifecycle();
  const open = openLanes(readBacklog(), events);
  return buildView(open, readStartOrder());
}

interface WriteContext {
  state: StartOrderState;
  /** the cleaned state: closed lanes and ids no backlog row names are already dropped */
  clean: StartOrderState;
  open: BacklogRecord[];
  backlog: BacklogRecord[];
  events: LifecycleRecord[];
}

type OrderDecision = { result: StartOrderResult; append?: StartOrderRow };

/**
 * Every start-order write runs here: the file's lock is taken, the order, the backlog and the lifecycle are read
 * again inside it, the caller decides, and only an accepted operation appends. Reading is never done under the
 * lock by another door, so a reader sees the row before the last one at worst.
 */
async function runOrderWrite(decide: (ctx: WriteContext) => OrderDecision): Promise<StartOrderResult> {
  const path = startOrderPath();
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // proper-lockfile resolves the file's real path, so the file has to exist before its lock can be taken. Create
  // it through an append, never a truncating write: another process may have won the race and appended its own
  // first row between our existence check and our create, and an opening that truncates would erase it.
  appendFileSync(path, "");
  const release = await lockfile.lock(path, { retries: { retries: 200, minTimeout: 5, maxTimeout: 100, factor: 1 } });
  try {
    const events = readLifecycle();
    const backlog = readBacklog();
    const open = openLanes(backlog, events);
    const state = readStartOrder(path);
    const clean = cleanState(state, new Set(open.map((r) => r.idd_id)));
    const { result, append } = decide({ state, clean, open, backlog, events });
    if (result.ok && append) appendFileSync(path, `${JSON.stringify(append)}\n`, "utf8");
    return result;
  } finally {
    await release();
  }
}

/** why the lane cannot be operated on, or null when it can */
function targetRefusal(ctx: WriteContext, iddId: string): string | null {
  if (!ctx.backlog.some((r) => r.idd_id === iddId)) return `${iddId} は backlog にありません`;
  if (laneHasEnded(iddId, ctx.events)) return `${iddId} は閉じています`;
  return null;
}

/** the row a reference lane must satisfy: in the backlog, open, and not the moving lane itself */
function referenceRefusal(ctx: WriteContext, iddId: string, ref: string): string | null {
  if (ref === iddId) return "動かす lane 自身を基準にはできません";
  if (!ctx.backlog.some((r) => r.idd_id === ref)) return `${ref} は backlog にありません`;
  if (laneHasEnded(ref, ctx.events)) return `${ref} は閉じています`;
  return null;
}

/** the same urgency side as the moving lane, for the position conversion */
const sameSide = (urgent: Set<string>, iddId: string, other: string): boolean => urgent.has(other) === urgent.has(iddId);

/**
 * Where a `position` in the reader's table falls in the base order. The table and the base order move a lane by
 * different amounts (the urgent split), so the position is read against the table first: remove the lane, put it
 * back at position N, then look at the lane next to it on the same urgency side and place it there in the base.
 * When no lane shares its side, the lane goes to the end of the base.
 */
function positionInBase(base: string[], view: string[], iddId: string, position: number, urgent: Set<string>): string[] {
  const without = view.filter((id) => id !== iddId);
  const at = Math.min(Math.max(position, 1), without.length + 1);
  const target = [...without.slice(0, at - 1), iddId, ...without.slice(at - 1)];
  const index = target.indexOf(iddId);
  let after: string | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (sameSide(urgent, iddId, target[i])) { after = target[i]; break; }
  }
  if (after !== undefined) {
    const i = base.indexOf(after);
    return [...base.slice(0, i + 1), iddId, ...base.slice(i + 1)];
  }
  let before: string | undefined;
  for (let i = index + 1; i < target.length; i += 1) {
    if (sameSide(urgent, iddId, target[i])) { before = target[i]; break; }
  }
  if (before !== undefined) {
    const i = base.indexOf(before);
    return [...base.slice(0, i), iddId, ...base.slice(i)];
  }
  return [...base, iddId];
}

export interface MoveStartOrderInput {
  idd_id?: unknown;
  before?: unknown;
  after?: unknown;
  position?: unknown;
}

/**
 * Move one open lane to a place in the order: before or after another lane, or at a 1-based position in the table.
 * The whole order after the move is written as one line, and the urgent marks are left as they were (closed lanes
 * dropped). A lane, its reference, or its position that cannot be honoured is refused and nothing is written.
 */
export async function moveInStartOrder(input: MoveStartOrderInput): Promise<StartOrderResult> {
  return runOrderWrite((ctx) => {
    const iddId = text(input.idd_id);
    if (!iddId) return { result: { ok: false, error: "動かす lane の ID がありません" } };
    const refusal = targetRefusal(ctx, iddId);
    if (refusal) return { result: { ok: false, error: refusal } };
    const before = text(input.before) ?? undefined;
    const after = text(input.after) ?? undefined;
    const position = input.position;
    const bases = [before !== undefined, after !== undefined, position !== undefined].filter(Boolean).length;
    if (bases !== 1) return { result: { ok: false, error: "動かす基準（before・after・position のどれか 1 つ）が必要です" } };
    const ref = before ?? after;
    if (ref !== undefined) {
      const bad = referenceRefusal(ctx, iddId, ref);
      if (bad) return { result: { ok: false, error: bad } };
    }
    if (position !== undefined && (typeof position !== "number" || !Number.isInteger(position) || position < 1)) {
      return { result: { ok: false, error: "position は 1 以上の整数にしてください" } };
    }

    const base = baseOrder(ctx.open, ctx.clean.order).filter((id) => id !== iddId);
    let next: string[];
    if (before !== undefined) {
      const i = base.indexOf(before);
      next = [...base.slice(0, i), iddId, ...base.slice(i)];
    } else if (after !== undefined) {
      const i = base.indexOf(after);
      next = [...base.slice(0, i + 1), iddId, ...base.slice(i + 1)];
    } else {
      const view = orderStartLanes(ctx.open, ctx.clean).map((r) => r.idd_id);
      next = positionInBase(base, view, iddId, position as number, new Set(ctx.clean.urgent));
    }
    const state: StartOrderState = { order: next, urgent: ctx.clean.urgent };
    return {
      result: buildView(ctx.open, state),
      append: {
        at: nowIso(), op: "move", idd_id: iddId, order: state.order, urgent: state.urgent,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(position !== undefined ? { position: position as number } : {}),
      },
    };
  });
}

export interface SetUrgentInput {
  idd_id?: unknown;
  urgent?: unknown;
}

/**
 * Mark one open lane urgent, or take the mark off. The order is left as it was (closed lanes dropped); a lane the
 * mark already has, or already lacks, is answered without a line.
 */
export async function setUrgent(input: SetUrgentInput): Promise<StartOrderResult> {
  return runOrderWrite((ctx) => {
    const iddId = text(input.idd_id);
    if (!iddId) return { result: { ok: false, error: "急ぎを付け外す lane の ID がありません" } };
    const refusal = targetRefusal(ctx, iddId);
    if (refusal) return { result: { ok: false, error: refusal } };
    const want = input.urgent === true;
    const has = ctx.clean.urgent.includes(iddId);
    if (has === want) return { result: buildView(ctx.open, ctx.clean) };
    const urgent = want
      ? [...ctx.clean.urgent, iddId]
      : ctx.clean.urgent.filter((id) => id !== iddId);
    const state: StartOrderState = { order: ctx.clean.order, urgent };
    return {
      result: buildView(ctx.open, state),
      append: { at: nowIso(), op: want ? "urgent" : "unurgent", idd_id: iddId, order: state.order, urgent: state.urgent },
    };
  });
}
