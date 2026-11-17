import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { readContextSnapshots, type ContextFile, type ContextSnapshot } from "./context-files.ts";
import { lanesRoot } from "./paths.ts";
import { messageText } from "./transcript.ts";

/*
 * What a role's one run was handed, read back from the run's own record and nothing else: the request text (the
 * envelope included), what was added to the model's context while it worked (the files it opened and what the
 * hooks put beside them), and the parts of a pi system prompt that are the workdir's and the package's own (the
 * context files and the addendum). The context files are read from the copy made when pi was started when the run
 * has one, and from the system prompt in the stream when it has not. The model's output is not here, and neither is what is the same in every
 * run (the tools' definitions and pi's fixed opening). Nothing is written and no directory is made: a reader on a
 * machine with no run finds nothing and leaves nothing.
 */

export type DeliveredKind = "request" | "tool-result" | "inject" | "session-start" | "context-file" | "addendum" | "note";

export interface DeliveredLine {
  kind: DeliveredKind;
  /** the reply it was handed in (a conversation's turn); absent for a one-off run and for the system prompt */
  turn?: number;
  /** what a reader sees after the kind's word: the tool and its target, the envelope's type, a file's path */
  heading: string;
  /** what two runs are matched by: the kind and the thing it is about, never the text */
  key: string;
  /** the text as it was handed over */
  text: string;
}

export interface DeliveredRun {
  id: string;
  role: string;
  harness: string;
  conversation: boolean;
  lane?: string;
  status?: string;
  lines: DeliveredLine[];
  /** what this read leaves out, said once so a reader does not take it for what was handed */
  notes: string[];
}

export const NOT_SHOWN_PI = "道具の定義と pi の固定の前置き（preamble・tools・rules・docs・skills・cwd）は、全起動で同じなので出していません";
export const NOT_RECORDED_PI = "この pi の run は system prompt が記録に無いので、context file と規約は読めません";
export const NOT_RECORDED_PI_ADDENDUM = "この pi の run は system prompt が記録に無いので、規約（addendum）は読めません。context file は起動時の写しから出しています";
export const NOT_RECORDED_PI_COPIED = "この pi の run は system prompt が記録に無いので、context file と規約（addendum）は起動時の写しから出しています";
export const NOT_RECORDED_CLAUDE = "Claude の run は system prompt が記録に無いので、context file（CLAUDE.md など）と規約は読めません";

// ---------------------------------------------------------------- finding a run

interface RunRecord {
  id: string;
  role?: string;
  slot?: string;
  idd_id?: string;
  spec?: string;
  mode?: string;
  status?: string;
  worktree?: string;
  role_preset?: { name?: string; harness?: string };
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** a run's id starts with a letter or a digit, so `.` and `..` (and a hidden name) never name a directory above or beside the runs */
export function isRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id);
}

function runRecord(id: string): RunRecord | null {
  if (!isRunId(id)) return null;
  return readJson<RunRecord>(join(lanesRoot(), id, "lane.json"));
}

/** the lane a run belongs to: a conversation's own, or the one its spec names (a one-off run has no lane in its record) */
function laneOfRun(rec: RunRecord): string | undefined {
  if (rec.idd_id) return rec.idd_id;
  if (!rec.spec) return undefined;
  try {
    return /^lane:\s*(\S+)\s*$/m.exec(readFileSync(rec.spec, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

const rolesOf = (rec: RunRecord) => [rec.role, rec.role_preset?.name, rec.slot].filter((r): r is string => !!r);

/**
 * The run a reference names: a run's id, or `IDD-x/role` (the newest run of that role in that lane; the role is a
 * preset's name or the slot it was started for). Null when none is found.
 */
export function resolveRun(ref: string): string | null {
  const at = ref.indexOf("/");
  if (at < 0) return runRecord(ref) ? ref : null;
  const lane = ref.slice(0, at);
  const role = ref.slice(at + 1);
  if (!lane || !role) return null;
  let names: string[];
  try { names = readdirSync(lanesRoot()); } catch { return null; }
  // an id starts with its start time, so the newest is the last name
  for (const name of names.sort().reverse()) {
    const rec = runRecord(name);
    if (!rec || !rolesOf(rec).includes(role)) continue;
    if (laneOfRun(rec) === lane) return name;
  }
  return null;
}

// ---------------------------------------------------------------- reading a record

/** every line of a file, a megabyte at a time (a record is up to 90MB); the last, half-written line is passed as it is */
function eachLine(path: string, fn: (line: string) => void): void {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return; }
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.alloc(1 << 20);
  let rest = "";
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const parts = (rest + decoder.write(buf.subarray(0, n))).split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) if (p) fn(p);
    }
  } finally {
    closeSync(fd);
  }
  rest += decoder.end();
  if (rest) fn(rest);
}

/** a line that is not whole JSON (the one being written) is skipped, never thrown on */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---------------------------------------------------------------- paths

const PATH_ARGS = ["path", "file_path", "notebook_path"];

/** a path as the worktree names it (relative to it), by its letters alone: two worktrees' same file is one key. A path outside it stays as it is. */
function logicalPath(path: string, worktree: string | undefined): string {
  if (!isAbsolute(path)) return normalize(path);
  for (const root of worktree ? [worktree, safeReal(worktree)] : []) {
    const rel = relative(root, path);
    if (rel === "") return ".";
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  }
  return path;
}

const safeReal = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// ---------------------------------------------------------------- the lines of one run

const TOOL_TARGET_KEYS = [...PATH_ARGS, "command", "pattern", "url", "query"];

/**
 * The one thing a tool call is about, as a heading shows it (never a long command): the path it was given, relative
 * to the worktree, or else the command, the pattern, the url or the query, as it was written.
 */
function targetOf(input: Record<string, unknown>, worktree: string | undefined): string {
  for (const k of TOOL_TARGET_KEYS) {
    const v = str(input[k]).replace(/\s+/g, " ").trim();
    if (v) return (PATH_ARGS.includes(k) ? logicalPath(v, worktree) : v).slice(0, 100);
  }
  return "";
}

/** a text block's text, or the plain string a tool result may be */
function textOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return asArray(content).map((c) => str(asRecord(c).text)).filter((t) => t.length > 0);
}

const INJECT_HEAD = /^\s*<propter-intent[\s>]/;

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

class Collector {
  readonly lines: DeliveredLine[] = [];
  private readonly calls = new Map<string, ToolCall>();
  private readonly systemSeen = new Set<string>();
  /** whether any system prompt was in the record: a pi run from before pi wrote it has none */
  sawSystem = false;
  /** whether the context files come from the copy made at the start: the system prompt's own are then not read again */
  contextCopied = false;
  private readonly requests = new Map<string, number>();
  turn: number | undefined;

  /** whether the package's norms come from the copy made at the start: the system prompt's own are then not read again */
  addendumCopied = false;

  private readonly worktree: string | undefined;

  constructor(worktree: string | undefined) {
    this.worktree = worktree;
  }

  push(line: DeliveredLine): void {
    this.lines.push(line);
  }

  /**
   * A request text, at the end or (a reply whose stream is not there yet) at a given place. Two runs are matched by
   * the request's kind and how many of that kind came before it, so a reply one run has and the other lacks does
   * not move the ones after it.
   */
  request(text: string, type?: string, at?: number): void {
    const before = this.lines.length;
    const kind = type ?? "";
    const nth = (this.requests.get(kind) ?? 0) + 1;
    this.requests.set(kind, nth);
    this.push({
      kind: "request", ...(this.turn !== undefined ? { turn: this.turn } : {}),
      heading: kind, key: `request:${kind}#${nth}`, text,
    });
    if (at !== undefined && at < before) this.lines.splice(at, 0, ...this.lines.splice(before));
  }

  /** what a tool put in the model's context, and what a hook put beside it */
  toolResult(id: string, name: string, texts: string[]): void {
    const call = this.calls.get(id);
    const tool = call?.name ?? name;
    const input = call?.input ?? {};
    const target = targetOf(input, this.worktree);
    const turn = this.turn !== undefined ? { turn: this.turn } : {};
    const injected = texts.filter((t) => INJECT_HEAD.test(t));
    const result = texts.filter((t) => !INJECT_HEAD.test(t));
    this.push({ kind: "tool-result", ...turn, heading: `${tool}${target ? ` ${target}` : ""}`, key: `tool-result:${tool} ${target}`, text: result.join("\n") });
    for (const t of injected) {
      const named = /<propter-intent\s+path="([^"]*)"/.exec(t)?.[1];
      const path = named ? logicalPath(named, this.worktree) : target;
      this.push({ kind: "inject", ...turn, heading: `Choice ${path}`, key: `inject:${path}`, text: t });
    }
  }

  toolCalls(content: unknown[]): void {
    for (const c of content) {
      const b = asRecord(c);
      const id = str(b.id);
      if (id && (b.type === "toolCall" || b.type === "tool_use")) {
        this.calls.set(id, { name: str(b.name), input: asRecord(b.arguments ?? b.input) });
      }
    }
  }

  hook(event: string, name: string, text: string): void {
    const start = event === "SessionStart";
    this.push({
      kind: start ? "session-start" : "inject", ...(this.turn !== undefined ? { turn: this.turn } : {}),
      heading: start ? "案内" : `hook ${name}`, key: `${start ? "session-start" : "hook"}:${name}`, text,
    });
  }

  /** a context file as it was handed over; one given again with the same text is not shown again */
  private contextFile(path: string, content: string): void {
    const seen = `${path}\0${content}`;
    if (this.systemSeen.has(seen)) return;
    this.systemSeen.add(seen);
    this.push({ kind: "context-file", heading: path, key: `context-file:${basename(path)}`, text: content });
  }

  /** the context files copied when pi was started, at the place the reply (or the run) they were copied for begins */
  copiedContextFiles(files: ContextFile[]): void {
    this.contextCopied = true;
    for (const f of files) this.contextFile(f.path, f.content);
  }

  /** the package's norms as they were handed over (a one-off or a reply's copy, or the system prompt's); the same text is not given twice */
  private addendumLine(text: string): void {
    if (!text || this.systemSeen.has(`addendum\0${text}`)) return;
    this.systemSeen.add(`addendum\0${text}`);
    this.push({ kind: "addendum", heading: "パッケージの規約", key: "addendum", text });
  }

  /** the norms copied when pi was started */
  copiedAddendum(text: string): void {
    this.addendumCopied = true;
    this.addendumLine(text);
  }

  /** the system prompt's context files and addendum; a prompt that is the same as one already given is not given again */
  system(sections: Record<string, unknown>, whole = ""): void {
    this.sawSystem = true;
    // a prompt written as one string (no sections) is read for the same two parts
    const project = this.contextCopied ? "" : str(sections.project_context) || whole;
    for (const m of project.matchAll(/<project_instructions path="([^"]*)">([\s\S]*?)<\/project_instructions>/g)) this.contextFile(m[1], m[2]);
    if (this.addendumCopied) return;
    const wrapped = str(sections.addendum) || (/<addendum>[\s\S]*?<\/addendum>/.exec(whole)?.[0] ?? "");
    // pi wraps the norms in an `addendum` element; the copy holds the text alone, so the two are shown the same way
    this.addendumLine(/^<addendum>\n?([\s\S]*?)\n?<\/addendum>$/.exec(wrapped.trim())?.[1] ?? wrapped);
  }
}

/** a pi stream: `message_start` is a message as it was handed over, an assistant's `message_end` has its tool calls whole */
function readPiRecord(path: string, c: Collector, requestType?: string): void {
  let firstUser = true;
  eachLine(path, (line) => {
    // the stream is mostly `message_update`: only the two types that carry a message are read at all
    if (!line.startsWith('{"type":"message_')) return;
    const isStart = line.startsWith('{"type":"message_start"');
    const isEnd = line.startsWith('{"type":"message_end"');
    if (!isStart && !isEnd) return;
    if (isEnd && !line.includes('"role":"assistant"') && !line.includes('"role":"system"')) return;
    const ev = parseLine(line);
    const msg = ev && asRecord(ev.message);
    if (!msg) return;
    const role = str(msg.role);
    // the system prompt is read from either end of its message: a stream may carry only the one
    if (role === "system") c.system(asRecord(msg.sections), typeof msg.content === "string" ? msg.content : "");
    if (isEnd) {
      if (role === "assistant") c.toolCalls(asArray(msg.content));
      return;
    }
    if (role === "user") {
      const texts = textOf(msg.content);
      if (!texts.length) return;
      c.request(texts.join("\n"), firstUser ? requestType : undefined);
      firstUser = false;
    } else if (role === "toolResult") c.toolResult(str(msg.toolCallId), str(msg.toolName), textOf(msg.content));
  });
}

/** a Claude stream-json: tool results and hook responses only (the request is not in it) */
function readClaudeRecord(path: string, c: Collector): void {
  eachLine(path, (line) => {
    if (!line.startsWith('{"type":"assistant"') && !line.startsWith('{"type":"user"') && !line.startsWith('{"type":"system"')) return;
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === "assistant") {
      c.toolCalls(asArray(asRecord(ev.message).content));
    } else if (ev.type === "user") {
      for (const block of asArray(asRecord(ev.message).content)) {
        const b = asRecord(block);
        if (b.type === "tool_result") c.toolResult(str(b.tool_use_id), "", textOf(b.content));
      }
    } else if (ev.subtype === "hook_response") {
      const out = parseLine(str(ev.output));
      const added = str(asRecord(out?.hookSpecificOutput).additionalContext);
      if (added) c.hook(str(ev.hook_event), str(ev.hook_name), added);
    }
  });
}

interface TurnRow {
  n: number;
  message: string;
  /** the log's word on whether the message got into the conversation; a row from before the word was written has none */
  reached?: boolean;
  /** the reply being written: its row is not in the log yet */
  inflight?: boolean;
}

function turnRows(dir: string): TurnRow[] {
  const out: TurnRow[] = [];
  const have = new Set<number>();
  eachLine(join(dir, "turns.jsonl"), (line) => {
    const t = parseLine(line);
    if (t && typeof t.n === "number" && typeof t.message === "string") {
      out.push({ n: t.n, message: t.message, ...(typeof t.reached === "boolean" ? { reached: t.reached } : {}) });
      have.add(t.n);
    }
  });
  // the reply being written has no row in the log yet: its own file says which message it took
  const inflight = readJson<{ n?: unknown; message?: unknown }>(join(dir, "inflight.json"));
  if (inflight && typeof inflight.n === "number" && typeof inflight.message === "string" && !have.has(inflight.n)) {
    out.push({ n: inflight.n, message: inflight.message, inflight: true });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** the kind recorded outside the envelope for a message file (the lane's own `message-types.json`) */
function recordedType(dir: string, name: string): string | undefined {
  const map = readJson<Record<string, unknown>>(join(dir, "message-types.json"));
  const t = map?.[name];
  return typeof t === "string" && t ? t : undefined;
}

/** a request file's text, or null when the file is no longer there */
function requestFile(dir: string, name: string): string | null {
  const text = messageText(dir, name);
  return text ? text : null;
}

/**
 * Everything a run was handed, in the order it was handed. A conversation is read turn by turn (its own `turns/<n>.jsonl`);
 * a one-off run is the one stream and its brief. The record is read as far as it was written.
 */
export function deliveredRun(id: string): DeliveredRun | null {
  if (!isRunId(id)) return null;
  const rec = runRecord(id);
  if (!rec) return null;
  const dir = join(lanesRoot(), id);
  const harness = rec.role_preset?.harness ?? "pi";
  const conversation = rec.mode === "conversation";
  const c = new Collector(rec.worktree);
  const claude = harness === "claude";
  const notes = [claude ? NOT_RECORDED_CLAUDE : NOT_SHOWN_PI];

  // a pi run's context files are read from the copy made at its start, when it has one
  const copies = claude ? [] : readContextSnapshots(dir);
  if (copies.length) c.contextCopied = true;
  if (copies.some((s) => s.addendum)) c.addendumCopied = true;
  const copiedAt = (snap: ContextSnapshot) => {
    c.copiedContextFiles(snap.files);
    if (snap.addendum) c.copiedAddendum(snap.addendum);
  };
  if (!conversation) for (const snap of copies) copiedAt(snap);

  if (conversation) {
    for (const t of turnRows(dir)) {
      // a reply the model never got into (its message went back to the queue) was not handed anything
      if (t.reached === false) {
        notes.push(`turn ${t.n} はモデルに届かなかったので、その依頼文は出していません`);
        continue;
      }
      if (t.inflight && !existsSync(join(dir, "turns", `${t.n}.jsonl`))) notes.push(`turn ${t.n} は始まったところで、モデルに届いたかはまだ記録に無いので、依頼文は届く前のものです`);
      // what a reply started with is the newest copy made at or before it: a copy is kept only when it changed, and
      // a reply whose own copy was skipped (the same rules again) was handed the earlier one. Shown once, where it first reached.
      const latest = copies.filter((s) => s.turn !== undefined && s.turn <= t.n).pop();
      if (latest) copiedAt(latest);
      c.turn = t.n;
      const type = recordedType(dir, t.message);
      const stream = join(dir, "turns", `${t.n}.jsonl`);
      const before = c.lines.length;
      if (claude) {
        // the request is not in a Claude stream: the file the turn was sent from is the text
        const text = requestFile(dir, t.message);
        if (text) c.request(text, type);
        readClaudeRecord(stream, c);
      } else {
        readPiRecord(stream, c, type);
        // a reply with no stream yet (just started): the file it took is what it was handed
        if (!c.lines.slice(before).some((l) => l.kind === "request")) {
          const text = requestFile(dir, t.message);
          if (text) c.request(text, type, before);
        }
      }
    }
    c.turn = undefined;
  } else {
    const events = join(dir, "events.jsonl");
    if (claude) {
      const brief = existsSync(join(dir, "brief.md")) ? readFileSync(join(dir, "brief.md"), "utf8") : "";
      if (brief) c.request(brief);
      readClaudeRecord(events, c);
    } else {
      readPiRecord(events, c);
    }
  }
  // a pi run whose stream has no system prompt says so, rather than saying the fixed part was left out
  if (!claude && !c.sawSystem) notes[0] = c.addendumCopied ? NOT_RECORDED_PI_COPIED : copies.length ? NOT_RECORDED_PI_ADDENDUM : NOT_RECORDED_PI;
  const lane = laneOfRun(rec);
  return {
    id, role: rec.role ?? rec.role_preset?.name ?? "", harness, conversation, ...(lane ? { lane } : {}), ...(rec.status ? { status: rec.status } : {}),
    lines: c.lines, notes,
  };
}

// ---------------------------------------------------------------- the same, changed, and only one side's

export type DiffMark = "same" | "changed" | "only-a" | "only-b";

export interface DiffRow {
  mark: DiffMark;
  a?: DeliveredLine;
  b?: DeliveredLine;
  /** a changed line's text difference: `-` only in a, `+` only in b, ` ` the same */
  diff?: { op: " " | "-" | "+"; text: string }[];
}

/** the longest common run of two sequences by an equality; the pairs of matching positions, in order */
function commonPairs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  let lo = 0;
  while (lo < a.length && lo < b.length && eq(a[lo], b[lo])) lo += 1;
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && eq(a[ha - 1], b[hb - 1])) { ha -= 1; hb -= 1; }
  const out: [number, number][] = [];
  for (let i = 0; i < lo; i += 1) out.push([i, i]);
  const n = ha - lo;
  const m = hb - lo;
  if (n > 0 && m > 0) {
    if (n * m > 16_000_000) {
      // too large to match line by line: what is left in the middle is taken as one change
    } else {
      const w = m + 1;
      const t = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          t[i * w + j] = eq(a[lo + i], b[lo + j]) ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (eq(a[lo + i], b[lo + j])) { out.push([lo + i, lo + j]); i += 1; j += 1; }
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i += 1;
        else j += 1;
      }
    }
  }
  for (let k = 0; ha + k < a.length; k += 1) out.push([ha + k, hb + k]);
  return out;
}

/** one step through two sequences: an item only the first has, only the second has, or the pair that matched */
type Step<T> = { side: "a"; a: T } | { side: "b"; b: T } | { side: "both"; a: T; b: T };

/** the two sequences walked together, in order, by the pairs `commonPairs` found; what is between two pairs is on one side only */
function align<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Step<T>[] {
  const out: Step<T>[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...commonPairs(a, b, eq), [a.length, b.length] as [number, number]]) {
    for (; i < pi; i += 1) out.push({ side: "a", a: a[i] });
    for (; j < pj; j += 1) out.push({ side: "b", b: b[j] });
    if (pi < a.length) out.push({ side: "both", a: a[i++], b: b[j++] });
  }
  return out;
}

/** the text difference of two bodies, line by line, with the lines left as they are */
export function textDiff(a: string, b: string): { op: " " | "-" | "+"; text: string }[] {
  return align(a.split("\n"), b.split("\n"), (p, q) => p === q).map((s) =>
    s.side === "a" ? { op: "-", text: s.a } : s.side === "b" ? { op: "+", text: s.b } : { op: " ", text: s.a });
}

/**
 * Two runs' lines side by side. The lines are matched by what they are about (the kind and the target), in order;
 * a matched pair is the same when its text is, and changed with the text's difference when it is not. A line with no
 * match is only in one of them. The same record twice is all `same`.
 */
export function diffDelivered(a: DeliveredLine[], b: DeliveredLine[]): DiffRow[] {
  return align(a, b, (x, y) => x.key === y.key).map((s): DiffRow => {
    if (s.side === "a") return { mark: "only-a", a: s.a };
    if (s.side === "b") return { mark: "only-b", b: s.b };
    return s.a.text === s.b.text ? { mark: "same", a: s.a, b: s.b } : { mark: "changed", a: s.a, b: s.b, diff: textDiff(s.a.text, s.b.text) };
  });
}
