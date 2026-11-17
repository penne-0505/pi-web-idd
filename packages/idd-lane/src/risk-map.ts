import { gitTry } from "./git.ts";

/**
 * A map of the routes a large diff carries, written by a cheap read-only run before the blind round: the files a
 * value or decision passes through (entry to exit), why a break there matters, then one blind per route that reads
 * that file list as one unit, next to one blind that reads the whole diff for the files no route covers.
 */

/**
 * The kinds of harm a break on a route can cause. They decide how the routes are ordered (heaviest first) and are
 * kept on the round's record and the submit card, so a person can read why the map cut the diff that way.
 */
export type HarmKind = "authority" | "irreversible" | "shown_vs_sent";

export const HARM_KINDS: Record<HarmKind, string> = {
  authority: "判断が外に出る",
  irreversible: "取り返しがつかない操作",
  shown_vs_sent: "見せている値と送る値",
};

/** the harms from the heaviest: a route is read first when a break on it can go further out */
export const HARM_ORDER: HarmKind[] = ["authority", "irreversible", "shown_vs_sent"];

export interface RiskRoute {
  id: string;
  /** the changed files the value or decision passes through, entry to exit, relative to the repo root */
  paths: string[];
  /** the state that must hold along the route, one sentence */
  question: string;
  /** the kinds of harm a break on this route can cause */
  harms: HarmKind[];
}

/** a diff this size or larger is mapped first, when pipeline.risk_map names no min_lines */
export const DEFAULT_MIN_LINES = 1000;
/**
 * The most routes a mapped round gives blinds of their own, when pipeline.risk_map names no max_routes. A lane
 * with more is a sign of several duties in one lane; the map's order is by harm, so the heaviest are kept and the
 * rest of the files go to the whole-diff blind (C-152-6).
 */
export const DEFAULT_MAX_ROUTES = 8;

export const MAP_TASK = [
  "この差分と、依頼（inputs の作業指示と受け入れ条件、または PR の本文・コメント・既存のレビュー）を読み、レビューで重点に見るべき経路の一覧を作る。指摘の段ではない。問題を断定せず、直さず、テストやビルドを走らせない（読むだけ。使うコマンドは git diff / git show / git log / grep などの読み取りに限る）。",
  "1 つの経路は、値や判断が入口から出口へ渡るファイルの列である。paths に、その列を入口から出口の順に書く（repo 相対パス）。両端のファイルが同じ読み手に渡らないと見えない食い違いを、1 つの経路が拾えるように切る。",
  "question には、その経路で成り立つべき状態を 1 文で書く（例: 画面に出した値と、送る値が同じである）。",
  "harms には、その経路が壊れたときに起きうる害の種類を書く: authority（判断が外に出る）、irreversible（取り返しがつかない操作）、shown_vs_sent（見せている値と送る値が食い違う）。",
  "経路は害の重い順に並べる。生成物・整形・翻訳の追加などの機械的な変更は経路にせず、skipped_paths に書く。重点に見る経路が無ければ routes を空にする。",
].join("\n");

export function mapFocus(maxRoutes: number): string[] {
  return [`経路は多くとも ${maxRoutes} 本を目安にする。超えた分のファイルは、差分全体を読む 1 本の一覧に入る。`];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * A path the map may name: relative, inside the repo, with no control character (a newline would break the brief)
 * and no git pathspec magic. The map is a model's output, read off someone else's PR too.
 */
function repoPath(v: unknown): string {
  const p = str(v).replace(/^(\.\/)+/, "");
  if (!p || p.startsWith("/") || p.startsWith(":") || /[\u0000-\u001f\u007f]/.test(p) || p.split("/").includes("..")) return "";
  return p;
}

/** the routes of a map's report, in its order and renumbered; a route without a file or a question is left out */
export function parseRoutes(raw: unknown): RiskRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: RiskRoute[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const paths = [...new Set((Array.isArray(o.paths) ? o.paths : []).map(repoPath).filter(Boolean))];
    const question = str(o.question);
    if (!paths.length || !question) continue;
    const harms = [...new Set((Array.isArray(o.harms) ? o.harms : []).map(str).filter((h): h is HarmKind => (HARM_ORDER as string[]).includes(h)))];
    out.push({ id: `R-${out.length + 1}`, paths, question, harms });
  }
  return out;
}

/**
 * The routes that pass through at least one file the diff changes, renumbered. A route outside the diff would give
 * a blind no changed file to read; its paths are kept as they are, so the reader may look at the neighbouring files.
 */
export function routesInDiff(routes: RiskRoute[], files: Set<string>): RiskRoute[] {
  return routes.filter((r) => r.paths.some((p) => files.has(p))).map((r, i) => ({ ...r, id: `R-${i + 1}` }));
}

/** added plus deleted lines between two revisions (binary files count nothing); null when git cannot tell */
export function diffLineCount(repo: string, base: string, head: string): number | null {
  const out = gitTry(repo, ["diff", "--numstat", "--no-renames", base, head]);
  if (out === null) return null;
  let n = 0;
  for (const row of out.split("\n")) {
    const [a, d] = row.split("\t");
    if (/^\d+$/.test(a ?? "")) n += Number(a);
    if (/^\d+$/.test(d ?? "")) n += Number(d);
  }
  return n;
}

export interface RoutedRun {
  /** r<n> for the n-th route's blind, rest for the whole-diff one */
  label: string;
  role: string;
  /** the model definition the run uses; absent when the stage names none */
  model?: string;
  /** the thinking this pair runs with */
  thinking?: string;
  focus: string[];
  /** rest only: this run reads the whole diff, so the round is judged when it finished (C-152-7) */
  wholeDiff?: boolean;
}

/** a role of a routed round: the role's name, and the model it runs with when the stage names one */
export type RoutedRole = string | { role: string; model?: string; thinking?: string };

/** the file list of a route as one line, entry to exit */
export function routeListing(paths: string[]): string {
  return paths.map((p) => `\`${p}\``).join(" → ");
}

/**
 * The blinds of a routed round: one per route (the slot's first role), each reading that file list as one unit
 * over the whole diff, then one over the whole diff by another role for the files no kept route covers. The map
 * orders the routes by harm, so the routes past the cap are the lightest and their files join the whole-diff list.
 * What to look for is never handed over: the map's question and harm kinds stay on the record (C-152-1, C-152-3).
 */
export function planRoutedBlind(routes: RiskRoute[], roles: readonly RoutedRole[], opts: { cap?: number; leftovers: string[] }): RoutedRun[] {
  if (!routes.length || !roles.length) return [];
  const cap = Math.max(1, Math.floor(opts.cap ?? DEFAULT_MAX_ROUTES));
  const kept = routes.slice(0, cap);
  const asRole = (r: RoutedRole): { role: string; model?: string; thinking?: string } => (typeof r === "string" ? { role: r } : r);
  const routeRole = asRole(roles[0]);
  const restRole = asRole(roles[1] ?? roles[0]);
  const covered = new Set(kept.flatMap((r) => r.paths));
  const rest = opts.leftovers.filter((p) => !covered.has(p));
  const routeRuns: RoutedRun[] = kept.map((r, i) => ({
    label: `r${i + 1}`,
    role: routeRole.role,
    ...(routeRole.model ? { model: routeRole.model } : {}),
    ...(routeRole.thinking ? { thinking: routeRole.thinking } : {}),
    focus: [
      "この差分のうち、次のファイルの列を 1 つの経路として読む。値や判断が入口から出口へどう渡るかを、列の順に追う。経路の外の変更も、確かめるのに要る範囲で読んでよい。",
      `経路: ${routeListing(r.paths)}`,
      "これは下調べが決めた読み方で、問題の断定ではない。鵜呑みにせず、現物とコマンドで確かめる。",
    ],
  }));
  const restRun: RoutedRun = {
    label: "rest",
    role: restRole.role,
    ...(restRole.model ? { model: restRole.model } : {}),
    ...(restRole.thinking ? { thinking: restRole.thinking } : {}),
    wholeDiff: true,
    focus: [
      "この差分全体を読む。次のファイルは、どの経路の読み手も重点としては読まない。ここに挙がっていない変更と、経路どうし・経路と他の変更の干渉を重点に見る。",
      rest.length ? `どの経路にも入らなかったファイル: ${rest.map((p) => `\`${p}\``).join("、")}` : "どの経路にも入らなかったファイルは無い。",
    ],
  };
  return [...routeRuns, restRun];
}

/** the heaviest harm of a route, for ordering and display */
export function heaviestHarm(harms: HarmKind[]): HarmKind | undefined {
  return HARM_ORDER.find((h) => harms.includes(h));
}
