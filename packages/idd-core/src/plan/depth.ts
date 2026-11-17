import { depth_table_json } from "../../../idd-fold/dist/idd-fold.js";
import type { RiskPaths } from "../config/risk-paths.ts";
import { riskPathsMatching } from "../config/risk-paths.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { replanView } from "../ledger/derive.ts";

/**
 * How deep a lane's change goes, and what the change goes through because of it. The planner declares the depth in
 * its ready report; the engine only ever raises it. The one table below is where every count of stages is read from
 * (the plan review's roles, the per-round review's roles, the last review, the fix budget, the kept check, the GO),
 * so "how many reviews does this lane get" follows from the depth alone.
 */
export type Depth = "shallow" | "standard" | "deep";

export const DEPTHS: readonly Depth[] = ["shallow", "standard", "deep"];
export const DEPTH_RANK: Record<Depth, number> = { shallow: 0, standard: 1, deep: 2 };
export const DEPTH_LABEL: Record<Depth, string> = { shallow: "浅い", standard: "標準", deep: "深い" };

export function isDepth(v: unknown): v is Depth {
  return typeof v === "string" && (DEPTHS as readonly string[]).includes(v);
}

export type Size = "S" | "M" | "L";
const SIZES: readonly Size[] = ["S", "M", "L"];

export function isSize(v: unknown): v is Size {
  return typeof v === "string" && (SIZES as readonly string[]).includes(v);
}

/** the harm grades a plan may declare: 0 (none) through 3 (irreversible, payment, auth) */
export const HARM_MAX = 3;

export function isHarm(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= HARM_MAX;
}

/** the deeper of two depths; the engine raises a declaration, never lowers it */
export function deeper(a: Depth, b: Depth): Depth {
  return DEPTH_RANK[a] >= DEPTH_RANK[b] ? a : b;
}

/** what the depth of a lane decides: the one table every stage count is read from */
export interface DepthRow {
  /** the roles the plan review runs */
  planReview: number;
  /** the roles the per-round review runs */
  blind: number;
  /** the spec checks a blind round, and the last review, start beside it on the same head */
  spec: number;
  /** whether the high-risk role runs as the last review */
  finalReview: boolean;
  /** the fix rounds a round may send before it asks penne */
  fixRounds: number;
  /** whether the engine may record the GO itself */
  autoGo: boolean;
  /** the shape judge runs the plan review starts beside its reviewers: the same role judges a stopped round (C-252-1) */
  shape: number;
}

/**
 * The table as the MoonBit derivation keeps it: the counts are written once, in `packages/idd-fold/review_loop.mbt`,
 * and every reader here takes the same rows (DEC-113-2, C-191-2). A table that cannot be read is a failure, not a
 * second copy: two tables let the plan review's roles and the loop's stages disagree on how many a depth gets.
 */
function readDepthTable(): Record<Depth, DepthRow> {
  const rows = JSON.parse(depth_table_json()) as (DepthRow & { depth: Depth })[];
  const table = {} as Record<Depth, DepthRow>;
  for (const row of rows) {
    table[row.depth] = {
      planReview: row.planReview,
      blind: row.blind,
      spec: row.spec,
      finalReview: row.finalReview,
      fixRounds: row.fixRounds,
      autoGo: row.autoGo,
      shape: row.shape,
    };
  }
  return table;
}

export const DEPTH_TABLE: Record<Depth, DepthRow> = readDepthTable();

/** the most spec checks any depth starts in one round: the copies a round holds, counted before its depth is known */
export const MAX_SPEC: number = Math.max(...DEPTHS.map((depth) => DEPTH_TABLE[depth].spec));

/** the roles of a list the depth's count asks for: the first `n`, or all when the list is shorter */
export function takeRoles<T>(roles: readonly T[], n: number): T[] {
  return roles.slice(0, Math.max(0, n));
}

/** what the engine reads to find the floor: the plan's own declaration and the lane's recorded risk */
export interface DepthFloorInput {
  size?: unknown;
  harm?: unknown;
  /** the lane's last risk table says it touches a kind of harm */
  touchesTable?: boolean;
  /** the lane's qa risk is High or Critical */
  riskHigh?: boolean;
  /** a path the plan expects to touch matches the repo's declaration of dangerous paths */
  matchedPaths?: boolean;
}

/**
 * The shallowest depth this change may be reviewed at. The machine only raises: anything the engine can read that
 * points at harm makes the floor deep, and a change that is not small makes it standard. A declaration deeper than
 * this is taken as it stands; a shallower one is refused.
 */
export function depthFloor(input: DepthFloorInput): Depth {
  if (input.touchesTable || input.riskHigh || input.harm === 3 || input.matchedPaths) return "deep";
  if ((input.size !== undefined && !isSize(input.size)) || input.size !== "S" || input.harm === 2) return "standard";
  return "shallow";
}

/** the floor's conditions, as the refusal and the planner's brief spell them out */
export const DEPTH_FLOOR_RULE = "深さの下限は、該当表に「触れる」がある・qa の risk: が High 以上・害が 3・触る見込みのファイルが repo の risk_paths に当たる、のどれかなら deep。そうでなく Size が S でないか害が 2 なら standard。それ以外は shallow。深い申告はそのまま受ける。";

/** whether any of the paths matches the repo's declaration of dangerous paths */
export function pathsMatchRisk(paths: readonly string[], declared: RiskPaths | undefined): boolean {
  if (!declared) return false;
  return paths.some((p) => p && riskPathsMatching(declared, p).length > 0);
}

/**
 * The depth a lane declared in its ready, read from the last ready before the last GO (a ready written after the GO
 * does not move it). Undefined for a lane that declared none: the caller falls back to the reading for old lanes.
 */
export function recordedDepth(allEvents: LifecycleRecord[]): Depth | undefined {
  // a lane sent back to its plan reads the plan it now has, not the GO it had before
  const events = replanView(allEvents);
  let go = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === "s1_go") { go = i; break; }
  const from = go >= 0 ? go - 1 : events.length - 1;
  for (let i = from; i >= 0; i -= 1) {
    if (events[i].event !== "s1_ready") continue;
    const d = events[i].attrs?.depth;
    return isDepth(d) ? d : undefined;
  }
  return undefined;
}

/**
 * The depth to run a lane at, from the record alone: the declared depth, or standard when none was declared. The
 * form for a caller that cannot read the worktree (no lane risk is asked).
 */
export function laneDepthFromEvents(events: LifecycleRecord[]): Depth {
  return recordedDepth(events) ?? "standard";
}

/** the record's depth raised by the lane's own Risk: the one reading of a lane's depth when the worktree is there */
export function combineDepth(recorded: Depth | undefined, high: boolean): Depth {
  const base = recorded ?? "standard";
  return high ? deeper(base, "deep") : base;
}

/** the three fields a plan report must carry, normalized, or an error naming what is missing */
export function normalizeDepthFields(raw: { size?: unknown; harm?: unknown; depth?: unknown }): { size: Size; harm: number; depth: Depth } | { error: string } {
  const missing: string[] = [];
  if (!isSize(raw.size)) missing.push("--size");
  if (!isHarm(raw.harm)) missing.push("--harm");
  if (!isDepth(raw.depth)) missing.push("--depth");
  if (missing.length) {
    return { error: `計画の報告に ${missing.join("・")} がありません。--size (S / M / L)・--harm (0〜3)・--depth (shallow / standard / deep) の 3 つとも送ってください。${DEPTH_FLOOR_RULE}` };
  }
  return { size: raw.size as Size, harm: raw.harm as number, depth: raw.depth as Depth };
}

/** the refusal when a declaration is shallower than what the engine can read */
export function shallowRefusal(depth: Depth, floor: Depth): string {
  return `申告した深さ ${depth} は、この計画から機械が読める下限 ${floor} より浅い。深さを ${floor} 以上（${DEPTH_LABEL[floor]}以上）にして送り直してください。${DEPTH_FLOOR_RULE}`;
}
