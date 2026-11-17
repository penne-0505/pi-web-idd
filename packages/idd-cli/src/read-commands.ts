/**
 * The one list of the reads the CLI answers, and the runners behind them. A person at a terminal and the
 * conversation's agent read the same range, so the list lives here once (C-167-1). Every command below only
 * reads: the engine's GET doors, the state's own files, and the lane's documents. Nothing here writes state,
 * and nothing here calls a door with a side effect.
 *
 * The default output is the point, not the whole JSON: the detail door of one lane is over 100KB and the
 * screen's shape, so a reader gets the lines a person and an agent can use (C-167-3). `--json` is beside the
 * lines where the original answer is worth keeping.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readBacklog, readLifecycle, readSessions } from "../../idd-core/src/ledger/read.ts";
import { readAreas } from "../../idd-core/src/config/areas.ts";
import { listLandRounds, type LandRoundRecord } from "../../idd-core/src/overlay/land-run.ts";
import { areaSegment, slugOf } from "../../idd-core/src/intent/parse.ts";
import { stateDir } from "../../idd-core/src/paths.ts";
import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";

import { DELIVERED_FLAGS, DELIVERED_VALUE_FLAGS, readDelivered } from "./read-delivered.ts";

/** what a runner may reach besides the process: swapped in the tests, so no read here starts a server */
export interface ReadDeps {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  stateDir?: () => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** one read-only command: its name, the flags it takes, and how it runs */
export interface ReadCommand {
  name: string;
  summary: string;
  usage: string;
  /** flags a caller may pass, besides the `--json` every command takes */
  flags: string[];
  /** the flags whose next argument is their value */
  valueFlags: string[];
  run(args: string[], deps: ReadDeps): Promise<number>;
}

/** characters that would build a second command line if a shell ever saw them; a read never needs one */
const SHELL_CHARS = /[\n\r;|&$`()<>]/;

// ---------------------------------------------------------------- the engine's values

interface LaneRowView {
  iddId: string;
  title: string;
  group?: string;
  blockedBy?: string;
  stageCurrent?: number | null;
  source?: { kind?: string; label?: string; url?: string };
}

interface SourceRefView { kind?: string; label?: string; url?: string }

interface StateView {
  lanes?: LaneRowView[];
  items?: Record<string, unknown>[];
  error?: string;
}

interface LaneDetailView {
  iddId?: string;
  title?: string;
  group?: string;
  phaseLabel?: string;
  source?: SourceRefView;
  branch?: string;
  area?: string;
  contract?: {
    decisions?: { id: string; text: string }[];
    criteria?: { id: string; text: string; state?: string }[];
  };
  work?: { files?: { path: string }[] };
  timeline?: { time: string; title: string; detail?: string; kind: string }[];
  reviewRounds?: unknown[];
  spend?: { budget?: number };
  pr?: { url?: string; number?: number };
  error?: string;
  [key: string]: unknown;
}

/** the group words the lane list uses, the same ones the screen shows (lib/idd-ui/types.ts) */
const GROUP_LABEL: Record<string, string> = { judge: "判断待ち", prep: "下調べ中", impl: "実装中", waiting: "待機中", closed: "終端" };

function sourceLine(source: SourceRefView | undefined): string {
  if (!source?.label) return "";
  return `Issue: ${source.label}${source.url ? ` ${source.url}` : ""}`;
}

function laneLine(row: LaneRowView): string {
  const parts = [`lane ${row.iddId} [${GROUP_LABEL[row.group ?? ""] ?? row.group ?? "?"}] ${row.title}`];
  if (row.blockedBy) parts.push(row.blockedBy);
  if (sourceLine(row.source)) parts.push(sourceLine(row.source));
  if (row.stageCurrent !== null && row.stageCurrent !== undefined) parts.push(`段 ${row.stageCurrent}`);
  return parts.join(" — ");
}

/** `idd read lanes`: every lane as one line, by group */
export function formatLanes(state: StateView): string[] {
  const lanes = state.lanes ?? [];
  if (!lanes.length) return ["lane はありません"];
  const counts = new Map<string, number>();
  for (const l of lanes) counts.set(l.group ?? "?", (counts.get(l.group ?? "?") ?? 0) + 1);
  const summary = [...counts.entries()].map(([g, n]) => `${GROUP_LABEL[g] ?? g} ${n}`).join(" / ");
  return [`lane ${lanes.length} 本（${summary}）`, ...lanes.map(laneLine)];
}

/** `idd read lane IDD-xxx`: one lane's point, never the whole detail JSON */
export function formatLane(detail: LaneDetailView): string[] {
  const lines = [`lane ${detail.iddId} ${detail.title}`];
  const head = [detail.phaseLabel ?? detail.group, detail.area ? `area ${detail.area}` : "", detail.branch ? `枝 ${detail.branch}` : "", sourceLine(detail.source)].filter(Boolean);
  if (head.length) lines.push(head.join(" / "));
  if (detail.pr?.url) lines.push(`PR: ${detail.pr.url}`);
  const criteria = detail.contract?.criteria ?? [];
  const decisions = detail.contract?.decisions ?? [];
  if (criteria.length || decisions.length) {
    lines.push(`契約: AC ${criteria.length} 件 / DEC ${decisions.length} 件`);
    for (const c of criteria) lines.push(`  ${c.id} [${c.state ?? "?"}] ${c.text}`);
    for (const d of decisions) lines.push(`  ${d.id} ${d.text}`);
  }
  const files = detail.work?.files ?? [];
  if (files.length) lines.push(`変更: ${files.length} ファイル`);
  const rounds = detail.reviewRounds ?? [];
  if (rounds.length) lines.push(`巡: ${rounds.length} 回`);
  if (typeof detail.spend?.budget === "number") lines.push(`費用: $${detail.spend.budget.toFixed(4)}`);
  const timeline = detail.timeline ?? [];
  if (timeline.length) {
    lines.push(`直近 ${Math.min(8, timeline.length)} 件:`);
    for (const t of timeline.slice(-8)) lines.push(`  ${t.time.slice(0, 16).replace("T", " ")} ${t.title}${t.detail ? ` — ${t.detail}` : ""}`);
  }
  return lines;
}

function cardHeadline(item: Record<string, unknown>): string[] {
  const kind = String(item.kind ?? "?");
  const iddId = String(item.iddId ?? "");
  const title = String(item.laneTitle ?? item.title ?? "");
  const head = `card ${kind} ${iddId}${title ? ` ${title}` : ""}`;
  if (kind === "question") {
    const open = Array.isArray(item.open) ? (item.open as Record<string, unknown>[]) : [];
    const out: string[] = [head];
    for (const q of open) {
      const options = Array.isArray(q.options) ? (q.options as { label?: string }[]) : [];
      out.push(`  問い: ${String(q.question ?? "")}`);
      if (options.length) out.push(`  選択肢: ${options.map((o) => o.label ?? "").join(" / ")}`);
    }
    return out;
  }
  if (kind === "go") {
    const s = (item.summary ?? {}) as { situation?: string; action?: string; outcome?: string };
    return [head, `  状況: ${s.situation ?? ""} / 行動: ${s.action ?? ""} / 結果: ${s.outcome ?? ""}`];
  }
  return [head];
}

/** `idd read cards`: the open cards, with each kind's own ask only */
export function formatCards(state: StateView): string[] {
  const items = state.items ?? [];
  if (!items.length) return ["card はありません"];
  return [`card ${items.length} 枚`, ...items.flatMap(cardHeadline)];
}

// ---------------------------------------------------------------- the state's own records

interface LifecycleView { event: string; idd_id: string; at: string; attrs?: Record<string, unknown> }

/**
 * The rows one read keeps: the named lane's own, or every row when no lane is named. `--lane` narrows the JSON
 * beside the lines too, or a caller asking for one lane's records would get the whole ledger (15MB) instead.
 */
function rowsOfLane(events: LifecycleView[], lane?: string): LifecycleView[] {
  return lane ? events.filter((e) => e.idd_id === lane) : events;
}

function eventLine(e: LifecycleView): string {
  const extra = e.attrs && typeof e.attrs === "object" ? Object.entries(e.attrs).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 3).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
  return `${e.at.slice(0, 16).replace("T", " ")} ${e.idd_id} ${e.event}${extra ? ` ${extra}` : ""}`;
}

/** `idd read ledger [--lane IDD-x] [--area A]`: the append-only record's events, newest last */
export function formatLedger(events: LifecycleView[], opts: { lane?: string; limit?: number } = {}): string[] {
  const filtered = rowsOfLane(events, opts.lane);
  const limit = opts.limit ?? 60;
  const shown = filtered.slice(-limit);
  if (!shown.length) return [opts.lane ? `${opts.lane} の台帳はありません` : "台帳はありません"];
  const head = filtered.length > shown.length ? `台帳 ${filtered.length} 件（直近 ${shown.length} 件）` : `台帳 ${filtered.length} 件`;
  return [head, ...shown.map(eventLine)];
}

/** `idd read land [--lane IDD-x]`: the merge side of the ledger, the `s4_land_*` events only */
export function formatLand(events: LifecycleView[], opts: { lane?: string } = {}): string[] {
  const land = rowsOfLane(events.filter((e) => e.event.startsWith("s4_land")), opts.lane);
  if (!land.length) return [opts.lane ? `${opts.lane} の land の記録はありません` : "land の記録はありません"];
  return [`land の記録 ${land.length} 件`, ...land.map(eventLine)];
}

/** one landing round's structure counts, beside the mainline tip they were compared at */
export interface StructureRoundView {
  lane: string;
  ended_at: string;
  status: LandRoundRecord["status"];
  mainTip: string;
  mergeCommit: string;
  source: "mainline" | "merged";
  blocking: string[];
  mainline: Record<string, number>;
  merged: Record<string, number>;
  failure?: string;
}

/** the rounds that measured the structure, in the order they ended (the mainline tip each was compared at is on the row) */
export function structureRounds(rounds: LandRoundRecord[], lane?: string): StructureRoundView[] {
  return rounds
    .filter((r) => r.structure && (!lane || r.lane === lane))
    .sort((a, b) => a.ended_at.localeCompare(b.ended_at))
    .map((r) => ({
      lane: r.lane, ended_at: r.ended_at, status: r.status, mainTip: r.mainTip, mergeCommit: r.mergeCommit,
      source: r.structure!.source, blocking: r.structure!.blocking, mainline: r.structure!.mainline, merged: r.structure!.merged,
      ...(r.structure!.failure ? { failure: r.structure!.failure } : {}),
    }));
}

/** `idd read structure [--lane IDD-x]`: each round's counts as `mainline → merged`, the ones that stop a landing marked */
export function formatStructure(rows: StructureRoundView[], opts: { lane?: string } = {}): string[] {
  if (!rows.length) return [opts.lane ? `${opts.lane} の構造の数の記録はありません` : "構造の数の記録はありません"];
  const lines = rows.map((r) => {
    const names = [...new Set([...r.blocking, ...Object.keys(r.mainline), ...Object.keys(r.merged)])];
    const counts = names.map((n) => `${r.blocking.includes(n) ? "*" : ""}${n} ${r.mainline[n] ?? "?"}→${r.merged[n] ?? "?"}`).join(" / ");
    const head = `${r.ended_at.slice(0, 16).replace("T", " ")} ${r.lane} 本流 ${r.mainTip.slice(0, 7)} merge ${r.mergeCommit.slice(0, 7)}`;
    return `${head}: ${counts}${r.failure ? `（測れない数があります: ${r.failure.split("\n")[0]}）` : ""}`;
  });
  return [`構造の数 ${rows.length} 回（* は本流より増えると取り込みを止める数）`, ...lines];
}

// ---------------------------------------------------------------- the lane's documents

export interface LaneDoc { kind: "plan" | "qa" | "reference"; path: string; headings: string[] }

/** the first `##` headings of a markdown file, the point a reader scans for */
export function headingsOf(text: string, limit = 8): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^#{1,3}\s+(.*)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
    if (out.length >= limit) break;
  }
  return out;
}

/** the directories a lane's documents may live in, the lane's worktree first */
export function docRoots(id: string): { area?: string; slug: string; roots: string[] } {
  const rec = readBacklog().find((r) => r.idd_id === id);
  const area = rec?.area;
  const slug = rec ? slugOf(rec) : id.toLowerCase();
  const sessions = [...readSessions("executor"), ...readSessions("planner")];
  const session = sessions.filter((r) => r.idd_id === id).pop();
  const roots: string[] = [];
  if (session?.worktree_path) roots.push(session.worktree_path);
  const local = area ? readAreas().areas[area]?.local_path : undefined;
  if (local && !roots.includes(local)) roots.push(local);
  return { ...(area ? { area } : {}), slug, roots };
}

/**
 * The places a lane's document of one kind may live, relative to a checkout, in the order the writer uses them:
 * the area's last segment and the lane's lowercase id, the same pair `laneRecordDirs` builds. A plan is moved
 * under `archives` before the submit, and a reference may be written beside the intent instead.
 */
export function docCandidates(kind: "plan" | "qa" | "reference", seg: string, slug: string): string[] {
  const rel = [`_docs/${kind}/${seg}/${slug}/${kind}.md`, `_docs/archives/${kind}/${seg}/${slug}/${kind}.md`];
  if (kind === "reference") rel.push(`_docs/intent/${seg}/${slug}/reference.md`);
  return rel;
}

/** `idd read docs IDD-xxx`: where the lane's plan / qa / reference are, and what they head with */
export function formatDocs(id: string, docs: LaneDoc[]): string[] {
  if (!docs.length) return [`${id} の lane の文書は見つかりません（worktree が無いか、まだ書かれていません）`];
  const lines = [`${id} の lane の文書`];
  for (const d of docs) {
    lines.push(`${d.kind}: ${d.path}`);
    for (const h of d.headings) lines.push(`  ${h}`);
  }
  return lines;
}

// ---------------------------------------------------------------- the review rounds' reports

export interface ReviewReport { dir: string; files: string[]; heading?: string }

/** `idd read reviews IDD-xxx`: the review stage's per-round directories and their report's first heading */
export function formatReviews(id: string, reports: ReviewReport[]): string[] {
  if (!reports.length) return [`${id} のレビューの report はありません`];
  const lines = [`${id} のレビューの report ${reports.length} 件`];
  for (const r of reports) lines.push(`${r.dir}${r.heading ? `: ${r.heading}` : ""}${r.files.length ? ` (${r.files.join(", ")})` : ""}`);
  return lines;
}

// ---------------------------------------------------------------- the list and the dispatch

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (valueFlags.includes(a.slice(2))) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function emit(deps: ReadDeps, lines: string[], json: unknown, wantJson: boolean): number {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  if (wantJson) out(`${JSON.stringify(json, null, 2)}\n`);
  else for (const line of lines) out(`${line}\n`);
  return 0;
}

/** one JSON GET against the engine; a refusal is a line, never a stack trace */
async function getJson(deps: ReadDeps, path: string): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  const base = (deps.baseUrl ?? agentBaseUrl)();
  const res = await doFetch(`${base}${path}`, { headers: { "Cache-Control": "no-store" } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? res.status));
  return data;
}

function readDocFiles(id: string): LaneDoc[] {
  const { area, slug, roots } = docRoots(id);
  if (!area) return [];
  const seg = areaSegment(area);
  const docs: LaneDoc[] = [];
  for (const kind of ["plan", "qa", "reference"] as const) {
    const candidates = roots.flatMap((root) => docCandidates(kind, seg, slug).map((rel) => join(root, rel)));
    const path = candidates.find((p) => existsSync(p));
    if (!path) continue;
    let headings: string[] = [];
    try {
      headings = headingsOf(readFileSync(path, "utf8"));
    } catch {
      headings = [];
    }
    docs.push({ kind, path, headings });
  }
  return docs;
}

function readReviewReports(id: string): ReviewReport[] {
  const dir = join(stateDir(), "pipeline", "review", id);
  if (!existsSync(dir)) return [];
  const out: ReviewReport[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const files = readdirSync(full).sort();
    const report = files.find((f) => f === "report.md") ?? files.find((f) => f.endsWith(".md"));
    let heading: string | undefined;
    if (report) {
      try {
        heading = headingsOf(readFileSync(join(full, report), "utf8"), 1)[0];
      } catch {
        heading = undefined;
      }
    }
    out.push({ dir: name, files, ...(heading ? { heading } : {}) });
  }
  return out;
}

const LANE_ONLY = ["lane"];

async function readStructure(args: string[], deps: ReadDeps): Promise<number> {
  const lane = flagValue(args, "lane");
  const rows = structureRounds(listLandRounds(), lane);
  const lines = formatStructure(rows, { ...(lane ? { lane } : {}) });
  return emit(deps, lines, rows, args.includes("--json"));
}

export const READ_COMMANDS: readonly ReadCommand[] = Object.freeze([
  {
    name: "lanes",
    summary: "lane の一覧と段",
    usage: "idd read lanes [--json]",
    flags: [],
    valueFlags: [],
    async run(args, deps) {
      const state = (await getJson(deps, "/api/idd/state")) as StateView;
      return emit(deps, formatLanes(state), state, args.includes("--json"));
    },
  },
  {
    name: "lane",
    summary: "1 本の lane の状態と段",
    usage: "idd read lane IDD-xxx [--json]",
    flags: [],
    valueFlags: [],
    async run(args, deps) {
      const id = positionals(args, [])[0];
      if (!id) throw new Error("lane（IDD-xxx）を指定してください");
      const detail = (await getJson(deps, `/api/idd/lane/${encodeURIComponent(id)}`)) as LaneDetailView;
      return emit(deps, formatLane(detail), detail, args.includes("--json"));
    },
  },
  {
    name: "cards",
    summary: "card の一覧",
    usage: "idd read cards [--json]",
    flags: [],
    valueFlags: [],
    async run(args, deps) {
      const state = (await getJson(deps, "/api/idd/state")) as StateView;
      return emit(deps, formatCards(state), state.items ?? [], args.includes("--json"));
    },
  },
  {
    name: "ledger",
    summary: "台帳（追記の記録）",
    usage: "idd read ledger [--lane IDD-xxx] [--json]",
    flags: ["lane"],
    valueFlags: ["lane"],
    async run(args, deps) {
      const lane = flagValue(args, "lane");
      const rows = rowsOfLane(readLifecycle(), lane);
      return emit(deps, formatLedger(rows, lane ? { lane } : {}), rows, args.includes("--json"));
    },
  },
  {
    name: "land",
    summary: "land の記録",
    usage: "idd read land [--lane IDD-xxx] [--json]",
    flags: ["lane"],
    valueFlags: ["lane"],
    async run(args, deps) {
      const lane = flagValue(args, "lane");
      const rows = rowsOfLane(readLifecycle().filter((e) => e.event.startsWith("s4_land")), lane);
      return emit(deps, formatLand(rows, lane ? { lane } : {}), rows, args.includes("--json"));
    },
  },
  {
    name: "structure",
    summary: "取り込みの検査ごとの構造の数",
    usage: "idd read structure [--lane IDD-xxx] [--json]",
    flags: LANE_ONLY,
    valueFlags: LANE_ONLY,
    run: readStructure,
  },
  {
    name: "delivered",
    summary: "役の起動に渡った文と、2 つの起動の差分",
    usage: "idd read delivered <run の id | IDD-xxx/役> [--diff <run の id | IDD-xxx/役>] [--full] [--line N] [--json]",
    flags: DELIVERED_FLAGS,
    valueFlags: DELIVERED_VALUE_FLAGS,
    run: readDelivered,
  },
  {
    name: "docs",
    summary: "lane の plan・qa・reference",
    usage: "idd read docs IDD-xxx [--json]",
    flags: [],
    valueFlags: [],
    async run(args, deps) {
      const id = positionals(args, [])[0];
      if (!id) throw new Error("lane（IDD-xxx）を指定してください");
      const docs = readDocFiles(id);
      return emit(deps, formatDocs(id, docs), docs, args.includes("--json"));
    },
  },
  {
    name: "reviews",
    summary: "lane のレビューの巡の report",
    usage: "idd read reviews IDD-xxx [--json]",
    flags: [],
    valueFlags: [],
    async run(args, deps) {
      const id = positionals(args, [])[0];
      if (!id) throw new Error("lane（IDD-xxx）を指定してください");
      const reports = readReviewReports(id);
      return emit(deps, formatReviews(id, reports), reports, args.includes("--json"));
    },
  },
]);

/** the names of the reads, the one list the conversation's tool also leans on */
export const READ_COMMAND_NAMES: readonly string[] = Object.freeze(READ_COMMANDS.map((c) => c.name));

export function findReadCommand(name: string): ReadCommand | undefined {
  return READ_COMMANDS.find((c) => c.name === name);
}

/**
 * Why this argv must not run, or null when it may. It is the one gate the terminal and the conversation's tool
 * share: a name that is not a read, an unknown or writing flag, a flag missing its value, or a shell character
 * in any argument (C-167-2). It never decides by the name alone, so a write verb under `read` stays out.
 */
export function readCommandRefusal(argv: readonly string[]): string | null {
  const [name, ...args] = argv;
  if (!name) return "読み取りの command を指定してください";
  const command = findReadCommand(name);
  if (!command) return `読み取りの command ではありません: ${name}`;
  // the shell check runs over every argument, the values behind a flag included, so a `;` cannot hide there
  for (const a of args) if (SHELL_CHARS.test(a)) return `引数に shell の文字があります: ${a}`;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const flag = a.slice(2);
    if (flag === "json") continue;
    if (!command.flags.includes(flag)) return `${command.name} に知らない flag です: ${a}`;
    if (command.valueFlags.includes(flag)) {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) return `${a} には値が必要です`;
      i += 1;
    }
  }
  return null;
}

/** run one read; the gate above decides first, and every runner returns the CLI's own exit code */
export async function runReadCommand(argv: readonly string[], deps: ReadDeps = {}): Promise<number> {
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const refusal = readCommandRefusal(argv);
  if (refusal) {
    err(`${refusal}\n`);
    return 2;
  }
  const command = findReadCommand(argv[0]) as ReadCommand;
  try {
    return await command.run([...argv.slice(1)], deps);
  } catch (cause) {
    err(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

/** the usage block the CLI prints when the reader asks for help */
export function readUsage(): string {
  return ["usage: idd read <command> [args] [--json]", ...READ_COMMANDS.map((c) => `       ${c.usage}    ${c.summary}`)].join("\n") + "\n";
}
