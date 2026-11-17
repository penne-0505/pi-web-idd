import { readFileSync } from "node:fs";

import { normalizeDecisionBody, normalizeProjectBody, normalizeProjectPatch } from "../../idd-core/src/intent/project.ts";
import type { ProjectStatusView } from "../../idd-core/src/intent/project-store.ts";
import { fetchIntent, out, postWrite, readJsonFile, readQueryFor, refuse, str, type Parsed, type WriteCall } from "./intent-commands.ts";
import { parseArgs } from "./lane-commands.ts";

/**
 * `idd project`: the Projects of a repo. Reads ask for no token and write nothing; every write is one call to the
 * intent door (`postWrite`), so a Project row is written under the same rules as a Choice row: a lane writes into
 * its own side until it lands, and only the lane's outside closes a Project or records that an Issue is closed.
 * Nothing here talks to GitHub or Linear: the Issues are names the state holds.
 */

export const PROJECT_USAGE = [
  "usage:",
  "  書き込み（new / set / decide / promote / attach / detach / issue-closed / issue-open / complete / cancel）は、lane の外では --session S（か IDD_SESSION_ID）が要り、登録 repo の外では --repo R が要る。lane の中では --session・--repo を付けない",
  "  idd project list [--json] [--repo R] [--view-lane ID]      # Project を並べる（Issue の閉じた数と、完了の候補の印）",
  "  idd project show ID [--json] [--repo R] [--view-lane ID]   # 1 つの Project を、決定と Issue ごとの閉じ方まで読む",
  "  idd project new --file F.json                              # {name, purpose, done_when, state?, body?}",
  "  idd project set ID [--name N] [--purpose P] [--done-when T] [--state S] [--body-file F]   # 変える（--file F.json も可）",
  "  idd project decide ID --file F.json [--decision PD-n-m]    # 決定 {chosen, why, rejected[], no_why_not?} を足す。--decision で直す",
  "  idd project promote ID PD-n-m --file F.json                # 決定を Choice に移す。F.json は {place, anchored, ...}。選んだ形・why・捨てた形は決定から写る",
  "  idd project attach ID ISSUE...    idd project detach ID ISSUE...   # Issue は URL・owner/name#N・APP-1234・番号。1 つの Issue は 1 つの Project にだけ属す",
  "  idd project issue-closed ISSUE...    idd project issue-open ISSUE...   # Issue が閉じた（開き直した）ことを人が記録する（lane の外だけ）",
  "  idd project sync [--session S]   # 外の tracker（tracker_sync を書いた repo）の変化を今すぐ取り込む。外へは何も書かない（lane の外だけ）",
  "  idd project complete ID [--force]   idd project cancel ID    # Project を閉じる（lane の外だけ。complete は完了の候補でなければ --force が要る）",
  "",
].join("\n");

const LIST_KEYS = ["issue"];

/** how an Issue came to count closed, in the words of the detail view */
function closedBy(i: { via?: string; lane?: string }): string {
  if (i.via === "landing") return `着地 ${i.lane ?? ""}`;
  return i.via === "external" ? "外で閉じた" : "記録";
}

/** one line of the list: the id, the state, the name, how many Issues are closed, and the candidate mark */
export function formatProjectLine(p: ProjectStatusView): string {
  const issues = p.issues.length ? `Issue ${p.closedCount}/${p.issues.length} 閉` : "Issue なし";
  return `${p.id} [${p.state}] ${p.name} — ${issues}${p.completionCandidate ? " ★完了の候補（人が complete で閉じる）" : ""}`;
}

/** the list as text: the same reading as `--json`, one line each */
export function formatProjectList(projects: ProjectStatusView[]): string[] {
  if (!projects.length) return ["Project はありません。"];
  return [`Project ${projects.length} 件`, ...projects.map(formatProjectLine)];
}

/** one Project as text: its fields, its Issues with how each is closed, and its decisions as headings */
export function formatProjectDetail(p: ProjectStatusView): string[] {
  const lines = [
    `${p.id} [${p.state}] ${p.name}`,
    `Purpose: ${p.purpose}`,
    `完了の形: ${p.doneWhen}`,
    `文書: ${p.document}`,
    `Issue ${p.closedCount}/${p.issues.length} 閉${p.completionCandidate ? "（完了の候補）" : ""}`,
    ...p.issueStatuses.map((i) => `  ${i.issue} ${i.closed ? `閉（${closedBy(i)}）` : "開"}${i.title ? ` ${i.title}` : ""}`),
    `決定 ${p.decisions.length} 件`,
    ...p.decisions.map((d) => `  ${d.id} ${d.chosen}${d.movedTo ? ` → ${d.movedTo}` : ""}`),
  ];
  if (p.body) lines.push("本文:", ...p.body.split("\n").map((l) => `  ${l}`));
  return lines;
}

function refuseMissing(parsed: Parsed): number | null {
  return parsed.missing.length ? refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`) : null;
}

async function readProjects(op: "projects" | "project", parsed: Parsed, id?: string): Promise<{ data: Record<string, unknown> } | { code: number }> {
  const query = readQueryFor(op, parsed.flags);
  if ("error" in query) return { code: refuse(query.error) };
  if (id) query.set("id", id);
  return fetchIntent(query);
}

async function listVerb(parsed: Parsed): Promise<number> {
  const read = await readProjects("projects", parsed);
  if ("code" in read) return read.code;
  if (parsed.flags.json) { out(read.data); return 0; }
  const projects = Array.isArray(read.data.projects) ? (read.data.projects as ProjectStatusView[]) : [];
  process.stdout.write(`${formatProjectList(projects).join("\n")}\n`);
  return 0;
}

async function showVerb(parsed: Parsed): Promise<number> {
  const id = parsed.positional[0];
  if (!id) return refuse("読む Project の ID を渡してください");
  const read = await readProjects("project", parsed, id);
  if ("code" in read) return read.code;
  if (parsed.flags.json) { out(read.data); return 0; }
  process.stdout.write(`${formatProjectDetail(read.data.project as ProjectStatusView).join("\n")}\n`);
  return 0;
}

/** the body of a write that comes from a JSON file, checked here so an ill-shaped one never reaches the door */
function bodyFile(file: string | undefined): { json: unknown } | { error: string } {
  if (!file) return { error: "本文の JSON を --file で渡してください" };
  return readJsonFile(file);
}

function textFile(path: string): { text: string } | { error: string } {
  try {
    return { text: readFileSync(path, "utf8") };
  } catch (err) {
    return { error: `ファイルを読めませんでした: ${String(err)}` };
  }
}

/** the call a write verb makes, or the refusal that stops it before anything is sent */
function buildCall(sub: string, parsed: Parsed): WriteCall | { error: string } {
  const flags = parsed.flags;
  const [first, second] = parsed.positional;
  switch (sub) {
    case "new": {
      const read = bodyFile(str(flags.file));
      if ("error" in read) return read;
      const body = normalizeProjectBody(read.json);
      if (!body.ok) return { error: body.error };
      return { action: "project_raise", payload: read.json as Record<string, unknown> };
    }
    case "set": {
      if (!first) return { error: "変える Project の ID を渡してください" };
      let patch: Record<string, unknown> = {};
      if (str(flags.file)) {
        const read = bodyFile(str(flags.file));
        if ("error" in read) return read;
        if (read.json === null || typeof read.json !== "object" || Array.isArray(read.json)) return { error: "変更は表で書いてください" };
        patch = { ...(read.json as Record<string, unknown>) };
      }
      for (const [flag, key] of [["name", "name"], ["purpose", "purpose"], ["done-when", "done_when"], ["state", "state"]] as const) {
        if (str(flags[flag]) !== undefined) patch[key] = str(flags[flag]);
      }
      if (str(flags["body-file"])) {
        const read = textFile(str(flags["body-file"]) as string);
        if ("error" in read) return read;
        patch.body = read.text;
      }
      const checked = normalizeProjectPatch(patch);
      if (!checked.ok) return { error: checked.error };
      return { action: "project_update", payload: { id: first, patch } };
    }
    case "decide": {
      if (!first) return { error: "決定を足す Project の ID を渡してください" };
      const read = bodyFile(str(flags.file));
      if ("error" in read) return read;
      const body = normalizeDecisionBody(read.json);
      if (!body.ok) return { error: body.error };
      const decision = str(flags.decision);
      return { action: "project_decide", payload: { id: first, ...(decision ? { decision } : {}), body: read.json } };
    }
    case "promote": {
      if (!first || !second) return { error: "idd project promote ID PD-n-m --file F.json の形で渡してください" };
      const read = bodyFile(str(flags.file));
      if ("error" in read) return read;
      return { action: "project_promote", payload: { id: first, decision: second, body: read.json } };
    }
    case "attach":
    case "detach": {
      const [id, ...issues] = parsed.positional;
      if (!id || !issues.length) return { error: `idd project ${sub} ID ISSUE... の形で渡してください` };
      return { action: sub === "attach" ? "project_attach" : "project_detach", payload: { id, issues } };
    }
    case "cancel":
      if (!first) return { error: "閉じる Project の ID を渡してください" };
      return { action: "project_update", payload: { id: first, patch: { state: "canceled" } } };
    case "sync":
      return { action: "project_sync", payload: {} };
    default:
      return { error: `未知の動詞: ${sub}` };
  }
}

/** `issue-closed` and `issue-open` are one fact each about an Issue: one call per ref */
async function issueStateVerb(parsed: Parsed, closed: boolean): Promise<number> {
  if (!parsed.positional.length) return refuse("Issue の参照を 1 つ以上渡してください");
  const done: unknown[] = [];
  for (const issue of parsed.positional) {
    const sent = await postWrite({ action: "project_issue_state", payload: { issue, closed } }, parsed.flags);
    if ("code" in sent) return sent.code;
    done.push(sent.data);
  }
  out(done.length === 1 ? done[0] : done);
  return 0;
}

/**
 * `complete` is a person's word, and a Project that is not a candidate needs `--force`: the candidate is what the
 * state can say (every Issue closed), and the person may still know better. A lane is refused by the door.
 */
async function completeVerb(parsed: Parsed): Promise<number> {
  const id = parsed.positional[0];
  if (!id) return refuse("閉じる Project の ID を渡してください");
  if (!parsed.flags.force) {
    const read = await readProjects("project", parsed, id);
    if ("code" in read) return read.code;
    const project = read.data.project as ProjectStatusView;
    if (!project.completionCandidate) {
      return refuse(`Project ${id} は完了の候補ではありません（Issue ${project.closedCount}/${project.issues.length} 閉）。それでも閉じるなら --force を付けてください`);
    }
  }
  const sent = await postWrite({ action: "project_update", payload: { id, patch: { state: "completed" } } }, parsed.flags);
  if ("code" in sent) return sent.code;
  out(sent.data);
  return 0;
}

export async function runProjectCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) { process.stdout.write(PROJECT_USAGE); return 2; }
  const parsed = parseArgs(argv.slice(1), LIST_KEYS);
  const bad = refuseMissing(parsed);
  if (bad !== null) return bad;
  if (sub === "list") return listVerb(parsed);
  if (sub === "show") return showVerb(parsed);
  if (sub === "issue-closed") return issueStateVerb(parsed, true);
  if (sub === "issue-open") return issueStateVerb(parsed, false);
  if (sub === "complete") return completeVerb(parsed);
  if (["new", "set", "decide", "promote", "attach", "detach", "cancel", "sync"].includes(sub)) {
    const call = buildCall(sub, parsed);
    if ("error" in call) return refuse(call.error);
    const sent = await postWrite(call, parsed.flags);
    if ("code" in sent) return sent.code;
    out(sent.data);
    return 0;
  }
  process.stdout.write(PROJECT_USAGE);
  return sub === "help" ? 0 : 2;
}
