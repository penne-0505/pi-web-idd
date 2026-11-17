import { pathsInText } from "../intent/decisions.ts";
import { readyIntentImpactOf } from "../agent/intent-impact.ts";
import { LANE_ENDED_EVENTS } from "../ledger/ends.ts";
import type { BacklogRecord, LifecycleRecord } from "../schema/records.ts";

/** the most hits a lane's overlap lists; the rest are a count */
export const OVERLAP_HITS_MAX = 8;

/**
 * how two declared places meet: the same path, a dir and a path inside it, or two files in the same dir (each lane
 * may make its own file there, and its own helper with it). The records cannot say whether a file is new, so two
 * files in one dir are told whatever the mainline holds: telling too much costs less than reading git to tell less.
 */
export type OverlapKind = "same" | "nested" | "sibling";

export interface OverlapHit {
  /** the viewing lane's place */
  path: string;
  /** the other lane's place */
  other: string;
  kind: OverlapKind;
}

/** one open lane the viewing lane shares a place with */
export interface LaneOverlap {
  lane: string;
  title: string;
  /** a side declared nothing, so the pair was matched on the paths its Issue's text names */
  provisional: boolean;
  hits: OverlapHit[];
  /** hits beyond the ones listed */
  more: number;
}

/** the places an open lane says it will touch, and whether it said so or the Issue's text was read for it */
export interface LaneDeclaration {
  lane: string;
  title: string;
  /** the area (the repo's checkout) the lane works in; lanes of different areas never meet */
  area: string;
  paths: string[];
  provisional: boolean;
}

const ENDED = new Set<string>(LANE_ENDED_EVENTS);

/** a declared path as it is compared: no leading `./`, and a trailing slash kept as the mark of a dir */
function normalize(raw: string): string | null {
  const t = raw.trim().replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!t || t === "/" || t.startsWith("/") || t.split("/").includes("..")) return null;
  return t;
}

/**
 * The paths an Issue's text names: those `pathsInText` reads, and the top-level files it leaves out without a
 * checkout to ask (a backquoted `README.md`). A bare name must carry an extension and sit in backquotes, so prose
 * such as "e.g." or "v1.2" is not a path.
 */
function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const raw of pathsInText(text)) {
    const n = normalize(raw);
    if (n) out.add(n);
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim().replace(/^\.\//, "");
    if (/^[\w.@+~-]*[A-Za-z_][\w.@+~-]*\.[A-Za-z][A-Za-z0-9]*$/.test(tok)) out.add(tok);
  }
  return [...out].sort();
}

function declaredPaths(events: LifecycleRecord[]): string[] {
  const seen = new Set<string>();
  for (const p of readyIntentImpactOf(events)?.paths ?? []) {
    const n = normalize(p);
    if (n) seen.add(n);
  }
  return [...seen].sort();
}

/**
 * The places of every open lane, read from the records alone (backlog and lifecycle). A lane that planned declares
 * them in its last ready's report; one with none (a ready with an empty list, or no ready yet) is read from the paths
 * its Issue names, and marked provisional. A lane an end event closed is not an opponent: what it declared is not
 * code still to be written. The same reading as `laneHasEnded`, which folds the same events.
 */
export function openDeclarations(backlog: BacklogRecord[], byLane: Map<string, LifecycleRecord[]>): LaneDeclaration[] {
  const out: LaneDeclaration[] = [];
  for (const rec of backlog) {
    const events = byLane.get(rec.idd_id) ?? [];
    if (events.some((e) => ENDED.has(e.event))) continue;
    const declared = declaredPaths(events);
    if (declared.length) {
      out.push({ lane: rec.idd_id, title: rec.title, area: rec.area, paths: declared, provisional: false });
      continue;
    }
    const named = namedPaths(`${rec.title}\n${rec.context ?? ""}`);
    if (named.length) out.push({ lane: rec.idd_id, title: rec.title, area: rec.area, paths: named, provisional: true });
  }
  return out;
}

const isDir = (p: string): boolean => p.endsWith("/");
const bare = (p: string): string => (isDir(p) ? p.slice(0, -1) : p);
const dirOf = (p: string): string => {
  const at = bare(p).lastIndexOf("/");
  return at < 0 ? "" : bare(p).slice(0, at);
};

/** how two places meet, or null when they do not */
function meet(a: string, b: string): OverlapKind | null {
  const x = bare(a);
  const y = bare(b);
  if (x === y) return "same";
  // a dir is declared with or without its slash: either way a path under it is inside it
  if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return "nested";
  // two files in the same dir: top-level files are too weak a sign, and a dir is not a file
  const dir = dirOf(a);
  if (!dir || isDir(a) || isDir(b) || dir !== dirOf(b)) return null;
  return "sibling";
}

/**
 * The open lanes that share a place with `iddId`, from the declarations `openDeclarations` read. Nothing here moves a
 * lane: the answer is told to the planner, the implementer and the GO card, and no stage reads it. Only lanes of
 * the same area are compared: a relative path of another repo is another place. The answer comes from the
 * declarations alone, never from a worktree or the mainline, so every reader gets the same pairs.
 */
export function overlapsOf(declarations: LaneDeclaration[], iddId: string): LaneOverlap[] {
  const mine = declarations.find((d) => d.lane === iddId);
  if (!mine) return [];
  const out: LaneOverlap[] = [];
  for (const other of declarations) {
    if (other.lane === iddId || other.area !== mine.area) continue;
    const all: OverlapHit[] = [];
    for (const a of mine.paths) {
      for (const b of other.paths) {
        const kind = meet(a, b);
        if (kind) all.push({ path: a, other: b, kind });
      }
    }
    // a path already shared by name or by dir is not told again as a neighbour of the other lane's paths
    const shared = new Set(all.filter((h) => h.kind !== "sibling").flatMap((h) => [h.path, h.other]));
    const hits = all.filter((h) => h.kind !== "sibling" || !(shared.has(h.path) || shared.has(h.other)));
    if (!hits.length) continue;
    out.push({
      lane: other.lane,
      title: other.title,
      provisional: mine.provisional || other.provisional,
      hits: hits.slice(0, OVERLAP_HITS_MAX),
      more: Math.max(0, hits.length - OVERLAP_HITS_MAX),
    });
  }
  return out.sort((p, q) => p.lane.localeCompare(q.lane, undefined, { numeric: true }));
}

/** every open lane's overlaps with `rec`, as the briefs read them: one pass over the backlog and the lifecycle */
export function overlapsForLane(rec: BacklogRecord, backlog: BacklogRecord[], events: LifecycleRecord[]): LaneOverlap[] {
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  // the viewing lane is read even when it is not in the backlog list a caller holds
  const lanes = backlog.some((b) => b.idd_id === rec.idd_id) ? backlog : [...backlog, rec];
  return overlapsOf(openDeclarations(lanes, byLane), rec.idd_id);
}

const KIND_TEXT: Record<OverlapKind, string> = {
  same: "同じ path",
  nested: "dir とその中",
  sibling: "同じ dir の別の file",
};

/** the lines a brief carries for the overlaps; none when there are none */
export function overlapLines(overlaps: LaneOverlap[]): string[] {
  return overlaps.flatMap((o) => [
    `${o.lane}「${o.title}」${o.provisional ? "（仮: 宣言ではなく Issue の文面の path で照合した）" : ""}`,
    ...o.hits.map((h) => `  - ${h.path === h.other ? h.path : `${h.path} ↔ ${h.other}`}（${KIND_TEXT[h.kind]}）`),
    ...(o.more > 0 ? [`  - ほか ${o.more} 件`] : []),
  ]);
}

/**
 * The `<overlapping-lanes>` block of a brief, or none when no open lane shares a place. It informs and moves nothing:
 * the lane's stage, its start and its GO are what they would be without it. The planner chooses; the implementer
 * does not rebuild what the other lane builds.
 */
export function overlapSection(overlaps: LaneOverlap[], role: "planner" | "executor", escape: (text: string) => string): string[] {
  if (!overlaps.length) return [];
  const guide = role === "planner"
    ? [
      "閉じていない別の lane が、あなたの lane と同じ場所を触ると宣言している。段・開始順・GO は変わらない。",
      "plan の触る範囲を決める前に、相手の lane が作る補助を前提にするか、別の場所を選ぶかを決め、依頼に書く。あなたの lane はまだ宣言が無いので、Issue の文面の path で照合している。報告の `paths` が宣言になる。",
    ]
    : [
      "閉じていない別の lane が、この lane と同じ場所を触ると宣言している。段・開始順・GO は変わらない。",
      "相手の lane が作る補助を、同じ役目で作り直さない。同じ file の変更は、取り込みで衝突しないよう最小に留める。相手の worktree は読まない。",
    ];
  return [
    `    <overlapping-lanes count="${overlaps.length}">`,
    ...guide.map((l) => `      ${escape(l)}`),
    ...overlapLines(overlaps).map((l) => `      ${escape(l)}`),
    "    </overlapping-lanes>",
  ];
}
