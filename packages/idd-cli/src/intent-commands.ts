import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import { checkProjection, checkTree, type CheckChoice, type CheckFinding, type FindingWeight, type ProjectionEntryKind, type RoundView, type TreePathKind } from "../../idd-core/src/intent/check.ts";
import { PROJECTION_MARK, type ProjectionFile } from "../../idd-core/src/intent/projection.ts";
import { normalizeChoiceBody, normalizeProposalBody, normalizePurposeBody, normalizeReanchorBody } from "../../idd-core/src/intent/records.ts";
import { readAgentToken } from "../../idd-lane/src/agent-token.ts";
import { git } from "../../idd-lane/src/git.ts";
import { touchedSinceBase, fileNamesInTree, placeMovesSinceBase } from "../../idd-lane/src/gate.ts";
import { repoForPath } from "../../idd-lane/src/repos.ts";
import { postJsonWithRetry } from "./lane-commands.ts";
import { runIntentConvert } from "./intent-convert.ts";
import { runIntentHook } from "./intent-hook.ts";

export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  missing: string[];
}

export const str = (v: string | boolean | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: string | boolean | string[] | undefined): string[] => (Array.isArray(v) ? v : []);

export function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}
export function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return join(process.env.HOME ?? "", p.slice(2));
  return p;
}

export function readJsonFile(path: string): { json: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(resolve(expandHome(path)), "utf8");
  } catch (err) {
    return { error: `JSON を読めませんでした: ${String(err)}` };
  }
  try {
    return { json: JSON.parse(raw) };
  } catch (err) {
    return { error: `JSON を読めませんでした: ${String(err)}` };
  }
}

/** the lane that reports must not be told apart from the harness's own: the id and the token come from the environment */
export function laneId(): string | null {
  return process.env.IDD_ID?.trim() || null;
}

/** the forbidden flags when a lane is calling: the same rule as a report (the lane is not a command-line argument) */
const LANE_FORBIDDEN = ["view-lane", "session", "repo", "token"];

export function laneFlagRefusal(flags: Parsed["flags"]): string | null {
  const set = LANE_FORBIDDEN.filter((f) => flags[f] !== undefined);
  return set.length ? `lane の呼び出しでは --${set.join(" --")} を使えません` : null;
}

/** the repo of an outside call: `--repo`, or the registered repo the cwd belongs to */
export function outsideRepo(flags: Parsed["flags"]): { repo: string } | { error: string } {
  const explicit = str(flags.repo);
  if (explicit) return { repo: explicit };
  try {
    const repo = repoForPath(process.cwd());
    if (repo?.github) return { repo: repo.github };
  } catch {
    /* the registry cannot be read: fall through to the refusal */
  }
  return { error: "repo を決められません。--repo を渡すか、登録済みの repo の中で呼んでください" };
}

// ---- the read verbs' text: what the planner needs, in one answer ----

/** a Place a lookup path met: the path asked, the Place's own path, and how they met (file・dir・module・root) */
interface LookupHit {
  path: string;
  place: string;
  kind: string;
  file?: string;
}

/** one Choice a lookup returns, read only for the fields the text shows (the door sends the whole record) */
interface LookupRow {
  id: string;
  purpose: string;
  forms?: { chosen?: string };
  why?: string;
  free?: string;
  status?: string;
  matched?: LookupHit[];
}

/** the one explanation of the unconfirmed mark, added once to an answer that holds such a Choice */
const UNCONFIRMED_NOTE = "（[unconfirmed] は移行で機械が移したもの。触る lane の計画役が、確認・Supersede・捨てるのどれかにする）";

/** how many sibling headings one answer lists before counting the rest: the rest is one more call away */
const SIBLING_LIMIT = 30;

function markOf(row: { status?: string }): string {
  return row.status === "unconfirmed" ? " [unconfirmed]" : "";
}

/** how a path met a Place, in the words the answer uses: the file a Place marks, a dir's own Choice, a module */
function hitWords(hit: LookupHit): string {
  const how = hit.kind === "file" ? "file の印" : hit.kind === "dir" ? "dir の Place" : hit.kind === "module" ? "同じ module" : "root";
  return `${hit.path}（${how}）`;
}

/**
 * `idd intent lookup`'s answer as text: the Choices whose Place is the file or dir itself come first, whole (id・the
 * unconfirmed mark・chosen・Purpose・how it was met・why・free). The other Choices of the same module follow as
 * headings (id and chosen), capped, and the root's Choices are a count with how to pull them. What an answer needs to
 * dispose of a Choice is here; anything more is one `--json` away.
 */
export function formatLookup(choices: LookupRow[]): string[] {
  const subject: LookupRow[] = [];
  const modules = new Map<string, LookupRow[]>();
  let roots = 0;
  for (const row of choices) {
    const hits = row.matched ?? [];
    if (hits.some((h) => h.kind === "file" || h.kind === "dir")) {
      subject.push(row);
    } else if (hits.some((h) => h.kind === "module")) {
      const at = hits.find((h) => h.kind === "module")?.place ?? "";
      modules.set(at, [...(modules.get(at) ?? []), row]);
    } else if (hits.some((h) => h.kind === "root")) {
      roots += 1;
    }
  }
  if (!choices.length) return ["この path に当たる Choice はありません。"];
  const lines = [`Choice ${choices.length} 件（このうち ${subject.length} 件は file か dir の Place に当たる。本文で出す）`];
  if (!subject.length) lines.push("この path を file か dir の Place に持つ Choice はありません。");
  for (const row of subject) {
    lines.push(`- ${row.id}${markOf(row)} ${row.forms?.chosen ?? ""}`);
    for (const hit of row.matched ?? []) {
      if (hit.kind !== "file" && hit.kind !== "dir") continue;
      lines.push(`  当たり: ${hitWords(hit)}${hit.file ? `。印 ${hit.file}` : ""}`);
    }
    lines.push(`  purpose: ${row.purpose}`);
    lines.push(`  why: ${row.why ?? ""}`);
    lines.push(`  free: ${row.free ?? ""}`);
  }
  for (const [at, rows] of modules) {
    lines.push(`同じ module（${at === "/" ? "repo の root" : at}）の Choice`);
    for (const row of rows.slice(0, SIBLING_LIMIT)) lines.push(`- ${row.id}${markOf(row)} ${row.forms?.chosen ?? ""}`);
    const rest = rows.length - SIBLING_LIMIT;
    if (rest > 0) lines.push(`（ほか ${rest} 件。\`--json\` で全部引ける）`);
  }
  if (roots) lines.push(`root の Choice ${roots} 件（\`--json\` で全部、本文は \`idd intent show <id>\`。変えるときは \`idd intent propose root-supersede|root-reanchor\`）`);
  if (choices.some((row) => row.status === "unconfirmed")) lines.push(UNCONFIRMED_NOTE);
  return lines;
}

/** the want of a Purpose: its statement's first sentence, cut the same way the injection cuts it */
export function wantOf(statement: string): string {
  const text = statement.trim();
  return /^[^。]*。/.exec(text)?.[0] ?? text;
}

/** one Purpose as the planner reads it to choose one: its id and its want, never the whole statement */
interface PurposeRow {
  id: string;
  statement?: string;
  status?: string;
}

/**
 * `idd intent purposes`'s answer as text: every active Purpose as one line, id and want. The full statements stay in
 * the state; the count line and the way to read one whole are here so the list is read in one call.
 */
export function formatPurposes(purposes: PurposeRow[]): string[] {
  const rows = [...purposes].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  if (!rows.length) return ["active な Purpose はありません。"];
  return [
    `Purpose ${rows.length} 件（active。want は statement の最初の文。全文は \`idd intent show <id>\`、触る Place の Choice は \`idd intent lookup <path>\`）`,
    ...rows.map((row) => `${row.id} ${wantOf(row.statement ?? "")}`),
  ];
}

/** the query of a read: a lane names itself from the environment, the lane's outside names a repo (and may look as a lane) */
export function readQueryFor(op: string, flags: Parsed["flags"]): URLSearchParams | { error: string } {
  const id = laneId();
  if (id) {
    const bad = laneFlagRefusal(flags);
    if (bad) return { error: bad };
    return new URLSearchParams({ op, lane: id });
  }
  const repo = outsideRepo(flags);
  if ("error" in repo) return repo;
  const query = new URLSearchParams({ op, repo: repo.repo });
  const viewer = str(flags["view-lane"]);
  if (viewer) query.set("lane", viewer);
  return query;
}

/** one read of the door: the answer's data, or the exit code with the refusal already printed */
export async function fetchIntent(query: URLSearchParams): Promise<{ data: Record<string, unknown> } | { code: number }> {
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl()}/api/idd/intent?${query.toString()}`);
  } catch (err) {
    return { code: refuse(`口を呼べませんでした: ${String(err)}`) };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    return { code: refuse(typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${res.status})`) };
  }
  return { data };
}

/** a read verb asks for no token and writes nothing; the repo is decided by whoever is calling */
async function readVerb(sub: string, parsed: Parsed): Promise<number> {
  const flags = parsed.flags;
  // the purpose list is a narrowing of the records the door already answers: it asks for records, not a new op
  const op = sub === "purposes" ? "records" : sub;
  const query = readQueryFor(op, flags);
  if ("error" in query) return refuse(query.error);
  if (sub === "lookup") {
    if (!parsed.positional.length) return refuse("引く path を 1 つ以上渡してください");
    for (const p of parsed.positional) query.append("path", p);
  } else if (sub === "show") {
    const target = parsed.positional[0];
    if (!target) return refuse("読む ID を渡してください");
    query.set("id", target);
  } else if (sub === "records" || sub === "purposes") {
    if (sub === "purposes") {
      query.set("kind", "purposes");
      query.set("status", "active");
    } else {
      if (str(flags.kind)) query.set("kind", str(flags.kind) as string);
      if (str(flags.status)) query.set("status", str(flags.status) as string);
    }
  } else if (sub === "risk") {
    // the repo's dangerous paths and its harm examples, from the one reader; nothing else is passed
  }
  const fetched = await fetchIntent(query);
  if ("code" in fetched) return fetched.code;
  const data = fetched.data;
  // the two reads the planner makes on its way into a plan answer as text; everything else stays the JSON it was
  if (flags.json) {
    out(data);
    return 0;
  }
  if (sub === "lookup") {
    const choices = Array.isArray(data.choices) ? (data.choices as LookupRow[]) : [];
    process.stdout.write(`${formatLookup(choices).join("\n")}\n`);
    return 0;
  }
  if (sub === "purposes") {
    const purposes = Array.isArray(data.purposes) ? (data.purposes as PurposeRow[]) : [];
    process.stdout.write(`${formatPurposes(purposes).join("\n")}\n`);
    return 0;
  }
  out(data);
  return 0;
}

export interface WriteCall {
  action: string;
  payload: Record<string, unknown>;
}

/** the body of a raise or a Supersede successor, checked here so an ill-shaped one never reaches the door */
function choiceBody(file: string): { body: Record<string, unknown> } | { error: string } {
  const read = readJsonFile(file);
  if ("error" in read) return read;
  const normalized = normalizeChoiceBody(read.json);
  if (!normalized.ok) return { error: normalized.error };
  return { body: normalized.value as unknown as Record<string, unknown> };
}

/** the write verbs, each turning its flags and file into one door call */
function buildWrite(sub: string, parsed: Parsed): WriteCall | { error: string } {
  const flags = parsed.flags;
  const [first] = parsed.positional;
  switch (sub) {
    case "raise": {
      const verb = first;
      if (verb !== "purpose" && verb !== "choice") return { error: "raise のあとは purpose か choice です" };
      const file = str(flags.file);
      if (!file) return { error: "本文の JSON を --file で渡してください" };
      const read = readJsonFile(file);
      if ("error" in read) return read;
      if (verb === "purpose") {
        const body = normalizePurposeBody(read.json);
        if (!body.ok) return { error: body.error };
        return { action: "raise_purpose", payload: body.value as unknown as Record<string, unknown> };
      }
      const body = choiceBody(file);
      if ("error" in body) return body;
      return { action: "raise_choice", payload: body.body };
    }
    case "supersede": {
      const ids = (first ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return { error: "置き換える Choice の ID を ID[,ID] で渡してください" };
      const grounds = str(flags.grounds);
      if (!grounds) return { error: "--grounds を渡してください" };
      const file = str(flags.file);
      const by = str(flags.by);
      if (file !== undefined && by !== undefined) return { error: "--file と --by はどちらか 1 つだけ渡してください" };
      if (file === undefined && by === undefined) return { error: "後継を --file（新しい Choice の本文）か --by（既にある Choice の ID）で 1 つ渡してください" };
      if (by !== undefined) {
        const successor = by.trim();
        if (!successor) return { error: "--by に後継の Choice の ID を渡してください" };
        return { action: "supersede", payload: { ids, grounds, by: successor } };
      }
      const body = choiceBody(file as string);
      if ("error" in body) return body;
      return { action: "supersede", payload: { ids, grounds, choice: body.body } };
    }
    case "reanchor": {
      if (!first) return { error: "Re-anchor する Choice の ID を渡してください" };
      const file = str(flags.file);
      if (!file) return { error: "新しい place か anchored を --file で渡してください" };
      const read = readJsonFile(file);
      if ("error" in read) return read;
      const body = normalizeReanchorBody(read.json);
      if (!body.ok) return { error: body.error };
      return { action: "reanchor", payload: { id: first, ...(body.value as unknown as Record<string, unknown>) } };
    }
    case "confirm": {
      if (!first) return { error: "確かめる ID を渡してください" };
      if (first.startsWith("P-")) {
        const name = str(flags.name);
        return { action: "confirm_purpose", payload: { id: first, ...(name ? { name } : {}) } };
      }
      return { action: "confirm_choice", payload: { id: first } };
    }
    case "drop": {
      if (!first) return { error: "捨てる Choice の ID を渡してください" };
      const grounds = str(flags.grounds);
      if (!grounds) return { error: "--grounds を渡してください" };
      return { action: "drop_choice", payload: { id: first, grounds } };
    }
    case "retire": {
      if (!first) return { error: "retire する Purpose の ID を渡してください" };
      const grounds = str(flags.grounds);
      if (!grounds) return { error: "--grounds を渡してください" };
      return { action: "retire_purpose", payload: { id: first, grounds } };
    }
    case "propose": {
      const names: Record<string, string> = { overview: "overview", "root-supersede": "root_supersede", "root-reanchor": "root_reanchor", harm: "harm_example" };
      const kind = first ? names[first] : undefined;
      if (!kind) return { error: "propose のあとは overview / root-supersede / root-reanchor / harm のどれかです" };
      const reason = str(flags.reason);
      if (!reason) return { error: "提案の理由を --reason で渡してください" };
      const file = str(flags.file);
      if (!file) return { error: "本文の JSON を --file で渡してください" };
      const read = readJsonFile(file);
      if ("error" in read) return read;
      const body = normalizeProposalBody(kind, read.json);
      if (!body.ok) return { error: body.error };
      return { action: "propose", payload: { kind, reason, body: body.value.body } };
    }
    case "waive": {
      const kind = str(flags.kind);
      const change = str(flags.change);
      if (kind === "applied") {
        const choices = list(flags.choice);
        if (!choices.length) return { error: "applied の Waive には --choice ID を 1 つ以上渡してください" };
        return { action: "waive", payload: { kind, choices, ...(change ? { change } : {}) } };
      }
      if (kind === "no-choice") {
        const reason = str(flags.reason);
        if (!reason) return { error: "no-choice の Waive には --reason を渡してください" };
        return { action: "waive", payload: { kind, reason, ...(change ? { change } : {}) } };
      }
      return { error: "--kind は applied か no-choice です" };
    }
    default:
      return { error: `未知の動詞: ${sub}` };
  }
}

/**
 * One write call sent to the door, as the lane (from the environment) or the lane's outside (a session and a repo)
 * names itself. The answer's data when the door accepted it; otherwise the exit code, with the refusal already printed.
 * The intent verbs and `idd project` send through this one function, so a Project row is written under the same rules
 * as a Choice row.
 */
export async function postWrite(call: WriteCall, flags: Parsed["flags"]): Promise<{ data: Record<string, unknown> } | { code: number }> {
  const id = laneId();
  let body: Record<string, unknown>;
  let token: string | undefined;
  if (id) {
    const bad = laneFlagRefusal(flags);
    if (bad) return { code: refuse(bad) };
    token = process.env.IDD_AGENT_TOKEN?.trim() || undefined;
    if (!token) return { code: refuse("IDD_AGENT_TOKEN がありません。意図の記録は、ハーネスが渡す環境でだけ書けます") };
    body = { action: call.action, idd_id: id, payload: call.payload };
  } else {
    const session = str(flags.session) ?? process.env.IDD_SESSION_ID?.trim();
    if (!session) return { code: refuse("lane の外から書くには --session（か IDD_SESSION_ID）が要ります") };
    const repo = outsideRepo(flags);
    if ("error" in repo) return { code: refuse(repo.error) };
    token = readAgentToken() ?? undefined;
    if (!token) return { code: refuse("agent token を読めませんでした") };
    body = { action: call.action, session, repo: repo.repo, payload: call.payload };
  }
  const posted = await postJsonWithRetry(`${agentBaseUrl()}/api/idd/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (posted.error !== undefined) return { code: refuse(`口を呼べませんでした: ${String(posted.error)}`) };
  const { response, data } = posted;
  if (!response?.ok || data.ok === false) {
    process.stderr.write(`${typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${response?.status ?? 0})`}\n`);
    return { code: 1 };
  }
  return { data };
}

async function writeVerb(sub: string, parsed: Parsed): Promise<number> {
  if (parsed.missing.length) {
    return refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`);
  }
  const call = buildWrite(sub, parsed);
  if ("error" in call) return refuse(call.error);
  const sent = await postWrite(call, parsed.flags);
  if ("code" in sent) return sent.code;
  out(sent.data);
  return 0;
}

/** how a repo-root relative path looks from the check's cwd, the worktree the caller is standing in */
function pathKindOf(root: string, rel: string): TreePathKind {
  try {
    const st = statSync(join(root, rel));
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "missing";
  } catch {
    return "missing";
  }
}

function countOf(findings: CheckFinding[], weight: FindingWeight): number {
  return findings.filter((f) => f.weight === weight).length;
}

// ---- the projection place in the caller's worktree ----

/** the first line of a file's body, as the mark check reads it */
function firstLineOf(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** a name the door may return: one `.md` segment, with no separator and no `..` */
function projectionNameOk(name: unknown): name is string {
  return typeof name === "string" && name.length > 3 && name.endsWith(".md")
    && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/** the git worktree root the call stands in, or null when cwd is not in a git checkout */
function worktreeRoot(): string | null {
  try {
    return git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch {
    return null;
  }
}

/** the first component of a repo-rooted path that is a symlink, or null; nothing is followed */
function symlinkOnTheWay(root: string, rel: string): string | null {
  let at = root;
  for (const part of rel.split("/").filter(Boolean)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null; // the rest does not exist yet
    }
  }
  return null;
}

/** the direct children of the projection place, seen with `lstat`; a missing place is empty */
function listProjectionDir(dir: string): { name: string; kind: ProjectionEntryKind }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; kind: ProjectionEntryKind }[] = [];
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      out.push({ name, kind: st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other" });
    } catch {
      /* a name that vanished between the listing and the lstat is not a projection */
    }
  }
  return out;
}

/** a regular file's body at the place; a symlink or a directory is never read */
function readProjectionFile(dir: string, name: string): string | null {
  try {
    if (!lstatSync(join(dir, name)).isFile()) return null;
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** the projection findings the door's drawn text gives against the caller's worktree */
function projectionFindingsFor(project: string, files: ProjectionFile[]): CheckFinding[] {
  const root = worktreeRoot() ?? process.cwd();
  const blocked = symlinkOnTheWay(root, ["_docs", "intent", project].join("/"));
  const dir = join(root, "_docs", "intent", project);
  return checkProjection({
    files,
    list: () => (blocked ? [] : listProjectionDir(dir)),
    read: (name) => (blocked ? null : readProjectionFile(dir, name)),
    ...(blocked ? { blocked: `${blocked} が symlink です` } : {}),
  });
}

/**
 * `idd intent check`: the state rules come from the door, the tree rules are applied here, in the worktree the
 * call is standing in. A lane names itself from the environment and the files it touched come from git against
 * the repo's base; with no base the check cannot see the touched Places, so it fails rather than report no
 * findings. A lane that is not claiming one still gets the tree rules, but no list of touched files, and the
 * output says so. The check writes nothing, so a repeated run answers the same.
 */
async function checkVerb(parsed: Parsed): Promise<number> {
  if (parsed.missing.length) {
    return refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`);
  }
  const flags = parsed.flags;
  const id = laneId();
  let query: URLSearchParams;
  let projQuery: URLSearchParams;
  let changed: string[] | null = null;
  let moves: { from: string; to: string }[] = [];
  let hasFileNamed: ((name: string) => boolean) | undefined;
  if (id) {
    const bad = laneFlagRefusal(flags);
    if (bad) return refuse(bad);
    query = new URLSearchParams({ op: "check", lane: id });
    projQuery = new URLSearchParams({ op: "projection", lane: id });
    let repo;
    try {
      repo = repoForPath(process.cwd());
    } catch (err) {
      return refuse(`repo の登録を読めませんでした: ${String(err)}`);
    }
    if (!repo) return refuse(`config/repos.yaml にこの path を含む repo がありません: ${process.cwd()}`);
    changed = touchedSinceBase(process.cwd(), repo);
    if (changed === null) return refuse(`変更の起点（${repo.base}）が見つかりません。触った Place を見られません`);
    // the same rename reading the landing uses: a Place on a file this lane moved is looked at where it went
    moves = placeMovesSinceBase(process.cwd(), repo) ?? [];
    hasFileNamed = fileNamesInTree(process.cwd());
  } else {
    if (str(flags["view-lane"])) return refuse("検査では --view-lane を使えません。lane を名乗る検査は、その lane の worktree で回します");
    const repo = outsideRepo(flags);
    if ("error" in repo) return refuse(repo.error);
    query = new URLSearchParams({ op: "check", repo: repo.repo });
    projQuery = new URLSearchParams({ op: "projection", repo: repo.repo });
    // a bare test name in a verification anchor is looked up in the caller's own tree, lane or not: the rule reads
    // the same tree either way, and a lane-named check is not the only one that can see the tests it names
    hasFileNamed = fileNamesInTree(process.cwd());
  }
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl()}/api/idd/intent?${query.toString()}`);
  } catch (err) {
    return refuse(`口を呼べませんでした: ${String(err)}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    return refuse(typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${res.status})`);
  }
  const state = Array.isArray(data.findings) ? (data.findings as CheckFinding[]) : [];
  const choices = Array.isArray(data.choices) ? (data.choices as CheckChoice[]) : [];
  const rounds = (data.rounds ?? { enteredImplementation: false }) as RoundView;
  const recordsShape = data.records_shape === "state" ? "state" : "docs";
  const tree = checkTree({
    choices,
    rounds,
    lane: id ?? null,
    changed: id ? changed : null,
    recordsShape,
    moves,
    hasFileNamed,
    kindOf: (path) => pathKindOf(process.cwd(), path),
    readFile: (path) => {
      try {
        return readFileSync(join(process.cwd(), path), "utf8");
      } catch {
        return null;
      }
    },
  });
  // The projections are drawn again at the landing from the merged state, so a lane never draws them and a
  // mismatch in the lane's own tree is not a defect the lane can fix: a lane-named check does not look at them
  // and says so (C-129-4). The outside sees the whole state and does look.
  let projectionSeen = false;
  const projectionFindings: CheckFinding[] = [];
  if (!id) {
    let projData: Record<string, unknown>;
    try {
      const projResponse = await fetch(`${agentBaseUrl()}/api/idd/intent?${projQuery.toString()}`);
      projData = (await projResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!projResponse.ok || projData.ok === false) {
        return refuse(typeof projData.error === "string" && projData.error ? projData.error : `写しの口が断りました (HTTP ${projResponse.status})`);
      }
    } catch (err) {
      return refuse(`写しの口を呼べませんでした: ${String(err)}`);
    }
    const projections = Array.isArray(projData.projections) ? projData.projections.map(String) : [];
    projectionSeen = projections.includes("A");
    const projectionFiles = Array.isArray(projData.files) ? (projData.files as ProjectionFile[]) : [];
    if (projectionSeen) projectionFindings.push(...projectionFindingsFor(String(projData.project ?? ""), projectionFiles));
    for (const kind of projections.filter((k) => k === "B" || k === "C")) {
      projectionFindings.push({ weight: "error", rule: "projection-kind", id: kind, reason: `${kind} はまだ描けません。設定から外すか、描けるようになるまで待ってください` });
    }
  }
  const findings = [...state, ...tree, ...projectionFindings];
  const errors = countOf(findings, "error");
  const notes = countOf(findings, "note");
  const marks = countOf(findings, "mark");
  if (flags.json) {
    out({ ok: true, lane: id ?? null, findings, counts: { error: errors, note: notes, mark: marks }, rounds, checked: { rounds: id !== null, touched: id !== null, projection: projectionSeen } });
    return errors > 0 ? 1 : 0;
  }
  for (const f of findings) process.stdout.write(`${f.weight} ${f.rule} ${f.id}: ${f.reason}\n`);
  if (id) process.stdout.write("写しは見ていない（着地で描き直すため、lane の tree の写しは比べない）\n");
  else if (!projectionSeen) process.stdout.write("この repo は写しを描かない\n");
  process.stdout.write(`error ${errors} 件、注記 ${notes} 件、印 ${marks} 件\n`);
  if (!id) process.stdout.write("巡と触った Place は見ていない\n");
  return errors > 0 ? 1 : 0;
}

/**
 * `idd intent draw`: the drawn text comes from the door's read op, and the writing and the comparison happen
 * here, in the worktree the call stands in. A lane names itself from the environment and draws nothing: its
 * projection is drawn again at the landing, so a lane-named call refuses unless `--out` names a place to look at
 * the text without touching the worktree. The outside names a repo. Nothing but a regular file whose first line
 * carries the mark is ever written or removed.
 */
async function drawVerb(parsed: Parsed): Promise<number> {
  if (parsed.missing.length) {
    return refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`);
  }
  const flags = parsed.flags;
  const id = laneId();
  if (str(flags["view-lane"])) return refuse("描くコマンドでは --view-lane を使えません");
  const outDir = str(flags.out);
  let query: URLSearchParams;
  if (id) {
    const bad = laneFlagRefusal(flags);
    if (bad) return refuse(bad);
    // a lane never draws into its worktree: the landing draws the projection again from the merged state, so the
    // lane's own tree is not the place for it. `--out` stays for reading the lane's text without touching it (C-129-5)
    if (!outDir) return refuse("lane は写しを描きません（着地で engine が描き直します）。下見には --out DIR を渡してください");
    query = new URLSearchParams({ op: "projection", lane: id });
  } else {
    const repo = outsideRepo(flags);
    if ("error" in repo) return refuse(repo.error);
    query = new URLSearchParams({ op: "projection", repo: repo.repo });
  }
  let res: Response;
  try {
    res = await fetch(`${agentBaseUrl()}/api/idd/intent?${query.toString()}`);
  } catch (err) {
    return refuse(`口を呼べませんでした: ${String(err)}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false) {
    return refuse(typeof data.error === "string" && data.error ? data.error : `API が断りました (HTTP ${res.status})`);
  }
  const files = Array.isArray(data.files) ? (data.files as ProjectionFile[]) : [];
  const badNames = files.map((f) => f.name).filter((name) => !projectionNameOk(name));
  if (badNames.length) return refuse(`口が描けない名前を返しました: ${badNames.join(", ")}`);
  const projections = Array.isArray(data.projections) ? data.projections.map(String) : [];
  let targetDir: string;
  if (outDir) {
    targetDir = resolve(expandHome(outDir));
  } else {
    if (!projections.includes("A")) {
      process.stderr.write("この repo は写しを描かない\n");
      return 1;
    }
    let repo;
    try {
      repo = repoForPath(process.cwd());
    } catch (err) {
      return refuse(`repo の登録を読めませんでした: ${String(err)}`);
    }
    if (!repo) return refuse(`config/repos.yaml にこの path を含む repo がありません: ${process.cwd()}`);
    const registered = repo.github ?? null;
    if (!registered) return refuse("cwd の登録の repo を決められません");
    if (typeof data.repo === "string" && data.repo !== registered) {
      return refuse(`cwd の repo（${registered}）と描く repo（${data.repo}）が違います。別の repo の写しはこの tree に描けません`);
    }
    const root = worktreeRoot();
    if (!root) return refuse("git の worktree の root を求められませんでした");
    const project = String(data.project ?? "");
    const blocked = symlinkOnTheWay(root, ["_docs", "intent", project].join("/"));
    if (blocked) return refuse(`${blocked} が symlink です。写しを書けません`);
    targetDir = join(root, "_docs", "intent", project);
  }
  // the names to be drawn are looked at before anything is written: one clash refuses the whole drawing
  const listing = listProjectionDir(targetDir);
  const kindOf = new Map(listing.map((e) => [e.name, e.kind]));
  const clashes: string[] = [];
  for (const f of files) {
    const kind = kindOf.get(f.name);
    if (kind === undefined) continue;
    if (kind !== "file" || firstLineOf(readProjectionFile(targetDir, f.name) ?? "") !== PROJECTION_MARK) clashes.push(f.name);
  }
  if (clashes.length) {
    process.stderr.write(`写しでないものがあるので、1 つも書きません: ${[...new Set(clashes)].join(", ")}\n`);
    return 2;
  }
  mkdirSync(targetDir, { recursive: true });
  const names = new Set(files.map((f) => f.name));
  const deleted: string[] = [];
  for (const e of listProjectionDir(targetDir)) {
    if (e.kind !== "file" || names.has(e.name) || !e.name.endsWith(".md")) continue;
    const content = readProjectionFile(targetDir, e.name);
    if (content !== null && firstLineOf(content) === PROJECTION_MARK) {
      unlinkSync(join(targetDir, e.name));
      deleted.push(e.name);
    }
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const f of files) {
    const current = kindOf.get(f.name) === "file" ? readProjectionFile(targetDir, f.name) : null;
    if (current === f.content) {
      unchanged.push(f.name);
      continue;
    }
    writeFileSync(join(targetDir, f.name), f.content, "utf8");
    written.push(f.name);
  }
  if (flags.json) {
    out({ ok: true, dir: targetDir, written, unchanged, deleted });
  } else {
    process.stdout.write(`書いた ${written.length} 件${written.length ? `: ${written.join(", ")}` : ""}\n`);
    process.stdout.write(`変わらなかった ${unchanged.length} 件${unchanged.length ? `: ${unchanged.join(", ")}` : ""}\n`);
    process.stdout.write(`消した ${deleted.length} 件${deleted.length ? `: ${deleted.join(", ")}` : ""}\n`);
  }
  if (!outDir) {
    const unsupported = projections.filter((k) => k === "B" || k === "C");
    if (unsupported.length) {
      process.stderr.write(`描けない種類が ON です: ${unsupported.join(", ")}\n`);
      return 1;
    }
  }
  return 0;
}

/**
 * The v2 intent verbs under `idd intent`. The read verbs (`lookup`・`show`・`records`) ask for no token and write
 * nothing; the write verbs send one call to `/api/idd/intent`. The old `decisions` and `anchors` are handled by
 * the caller. `undefined` means this is not one of the verbs here, so the caller prints the usage.
 */
export async function runIntentCommand(sub: string, parsed: Parsed): Promise<number | undefined> {
  if (sub === "lookup" || sub === "show" || sub === "records" || sub === "purposes" || sub === "risk") return await readVerb(sub, parsed);
  if (sub === "check") return await checkVerb(parsed);
  if (sub === "draw") return await drawVerb(parsed);
  if (["raise", "supersede", "reanchor", "confirm", "drop", "retire", "waive", "propose"].includes(sub)) return await writeVerb(sub, parsed);
  if (sub === "convert") return await runIntentConvert(parsed);
  if (sub === "hook") return await runIntentHook(str(parsed.flags.input));
  return undefined;
}
