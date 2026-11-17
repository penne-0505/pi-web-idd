/**
 * `idd read delivered`: what a role's run was handed, and how two runs differ. The reading is the lane package's
 * (`delivered.ts`, from the run's own record); this file is how it is shown: the default cuts each text and says
 * what it cut, `--full` and `--json` do not cut, and `--line N` reads one line whole. Nothing here writes.
 */
import { deliveredRun, diffDelivered, resolveRun, type DeliveredLine, type DeliveredRun, type DiffRow } from "../../idd-lane/src/delivered.ts";
import type { ReadDeps } from "./read-commands.ts";

/** the characters of one text the default shows before it says what is left */
export const SHOWN_CHARS = 1200;
/** the lines of one changed text's difference the default shows */
export const SHOWN_DIFF_LINES = 30;

const KIND_WORD: Record<DeliveredLine["kind"], string> = {
  request: "依頼文",
  "tool-result": "道具の結果",
  inject: "差し込み",
  "session-start": "session 開始",
  "context-file": "context file",
  addendum: "規約",
  note: "注記",
};

export interface DeliveredArgs {
  /** the run a reader points at, then (with `--diff`) the one it is set against */
  a: string;
  b?: string;
  full: boolean;
  json: boolean;
  line?: number;
}

/** what a command line says; a reader who gives no run, or a line that is not a number, gets the reason */
export function parseDeliveredArgs(args: string[]): DeliveredArgs {
  const pos: string[] = [];
  let b: string | undefined;
  let line: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--diff") { b = args[i + 1]; i += 1; }
    else if (a === "--line") {
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--line には 1 以上の行の番号を指定してください");
      line = n;
      i += 1;
    } else if (!a.startsWith("--")) pos.push(a);
  }
  if (!pos[0]) throw new Error("run の id か IDD-xxx/役 を指定してください");
  return { a: pos[0], ...(b ? { b } : {}), full: args.includes("--full"), json: args.includes("--json"), ...(line ? { line } : {}) };
}

function load(ref: string): DeliveredRun {
  const id = resolveRun(ref);
  if (!id) throw new Error(`run が見つかりません: ${ref}`);
  const run = deliveredRun(id);
  if (!run) throw new Error(`run の記録を読めません: ${id}`);
  return run;
}

/** a text cut at a length, with what was left and how to read it */
export function cutText(text: string, full: boolean, hint: string): string[] {
  const lines = text.split("\n");
  if (full || text.length <= SHOWN_CHARS) return lines;
  const kept = text.slice(0, SHOWN_CHARS).split("\n");
  return [...kept, `… 切りました: ${SHOWN_CHARS} 文字まで（全 ${text.length} 文字、残り ${text.length - SHOWN_CHARS} 文字）。${hint}`];
}

/** the kind's word, and what it is about when there is something to say */
const what = (l: DeliveredLine) => `${KIND_WORD[l.kind]}${l.heading ? ` ${l.heading}` : ""}`;

const indent = (lines: string[]) => lines.map((l) => `    ${l}`);

function lineHead(i: number, l: DeliveredLine): string {
  const turn = l.turn !== undefined ? `turn ${l.turn} ` : "";
  return `[${i}] ${turn}${what(l)}（${l.text.length} 文字）`;
}

function runHead(run: DeliveredRun): string {
  const parts = [run.role, run.harness, run.conversation ? "会話" : "1 回きり", run.lane ?? "lane なし", run.status ?? ""].filter(Boolean);
  return `run ${run.id}（${parts.join(" / ")}）渡った文 ${run.lines.length} 行`;
}

/** `idd read delivered <run>`: the run's lines in the order they were handed over */
export function formatDelivered(run: DeliveredRun, opts: { full?: boolean; line?: number } = {}): string[] {
  const out = [runHead(run), ...run.notes.map((n) => `※ ${n}`)];
  if (opts.line !== undefined) {
    const l = run.lines[opts.line - 1];
    if (!l) return [...out, `${opts.line} 行目はありません（${run.lines.length} 行）`];
    return [...out, lineHead(opts.line, l), ...indent(l.text.split("\n"))];
  }
  if (!run.lines.length) out.push("渡った文は、この run の記録にまだありません");
  run.lines.forEach((l, i) => {
    out.push(lineHead(i + 1, l), ...indent(cutText(l.text, opts.full ?? false, `--full か --line ${i + 1} で全部読めます`)));
  });
  return out;
}

const MARK: Record<DiffRow["mark"], string> = { same: "=", changed: "~", "only-a": "<", "only-b": ">" };
const MARK_WORD: Record<DiffRow["mark"], string> = { same: "同じ", changed: "変わった", "only-a": "A だけ", "only-b": "B だけ" };

function rowLine(r: DiffRow): DeliveredLine {
  return (r.a ?? r.b) as DeliveredLine;
}

function rowHead(i: number, r: DiffRow): string {
  const l = rowLine(r);
  const turn = l.turn !== undefined ? `turn ${l.turn} ` : "";
  const size = r.mark === "changed" ? `${r.a?.text.length} → ${r.b?.text.length} 文字` : `${l.text.length} 文字`;
  return `${MARK[r.mark]} [${i}] ${MARK_WORD[r.mark]} ${turn}${what(l)}（${size}）`;
}

/** `idd read delivered <run> --diff <run>`: same, changed (with the text's difference) and only one side's, line by line */
export function formatDeliveredDiff(a: DeliveredRun, b: DeliveredRun, rows: DiffRow[], opts: { full?: boolean } = {}): string[] {
  const count = (m: DiffRow["mark"]) => rows.filter((r) => r.mark === m).length;
  const out = [
    `A: ${runHead(a)}`,
    `B: ${runHead(b)}`,
    `同じ ${count("same")} / 変わった ${count("changed")} / A だけ ${count("only-a")} / B だけ ${count("only-b")}`,
    ...[...new Set([...a.notes, ...b.notes])].map((n) => `※ ${n}`),
  ];
  rows.forEach((r, i) => {
    out.push(rowHead(i + 1, r));
    if (r.mark === "changed" && r.diff) {
      const changed = r.diff.filter((d) => d.op !== " ");
      const shown = opts.full ? changed : changed.slice(0, SHOWN_DIFF_LINES);
      out.push(...indent(shown.map((d) => `${d.op} ${d.text}`)));
      if (shown.length < changed.length) out.push(`    … 差分を切りました: ${shown.length} 行まで（全 ${changed.length} 行）。--full で全部読めます`);
    } else if (r.mark === "only-a" || r.mark === "only-b") {
      out.push(...indent(cutText(rowLine(r).text, opts.full ?? false, `--full で全部読めます`)));
    }
  });
  return out;
}

/** the flags the command takes besides `--json`, and the ones whose next argument is their value */
export const DELIVERED_FLAGS = ["diff", "line", "full"];
export const DELIVERED_VALUE_FLAGS = ["diff", "line"];

/** `idd read delivered`: lines for a person, or the whole of every line as JSON */
export async function readDelivered(args: string[], deps: ReadDeps): Promise<number> {
  const parsed = parseDeliveredArgs(args);
  const a = load(parsed.a);
  const b = parsed.b ? load(parsed.b) : undefined;
  const rows = b ? diffDelivered(a.lines, b.lines) : [];
  const lines = b
    ? formatDeliveredDiff(a, b, rows, { full: parsed.full })
    : formatDelivered(a, { full: parsed.full, ...(parsed.line ? { line: parsed.line } : {}) });
  const json = b ? { a: { ...a, lines: undefined }, b: { ...b, lines: undefined }, rows } : a;
  const write = deps.stdout ?? ((s: string) => process.stdout.write(s));
  write(parsed.json ? `${JSON.stringify(json, null, 2)}\n` : lines.map((l) => `${l}\n`).join(""));
  return 0;
}
