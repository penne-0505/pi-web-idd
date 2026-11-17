import { statSync } from "node:fs";
import { join } from "node:path";

import { agentBaseUrl } from "../../idd-core/src/agent/token.ts";
import { pendingOps, planConversion, readLegacyRecords, type Blocker, type ConvertOp, type PurposeSeed, type ReviewEntry, type StateRecords } from "../../idd-core/src/intent/convert.ts";
import { readAgentToken } from "../../idd-lane/src/agent-token.ts";
import { outsideRepo, readJsonFile, type Parsed } from "./intent-commands.ts";
import { postJsonWithRetry } from "./lane-commands.ts";

/**
 * `idd intent convert`: read the old decision documents, plan the records they become, and send the plan through
 * the same door every other write goes through. The verb lives here, not in `idd migrate`: `idd migrate` runs the
 * machine's own steps, and this one is the lane's outside turning a person's assignment into records.
 *
 * The verb is refused inside a lane before it reads a single file: the migration mark it carries can claim a
 * person's review and a document's date, so only the lane's outside may write it.
 */

const str = (v: string | boolean | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** whether the root holds a directory at the repo-relative path (a trailing `/` is the only marker a Place carries) */
function isDirectoryUnder(root: string, path: string): boolean {
  try {
    return statSync(join(root, path.replace(/\/$/, ""))).isDirectory();
  } catch {
    return false;
  }
}

/** the door body of one op: the write verbs' own shape, with the session and the repo at the top */
function doorBody(op: ConvertOp, session: string, repo: string): Record<string, unknown> {
  switch (op.type) {
    case "raise_purpose":
      return { action: "raise_purpose", session, repo, payload: { id: op.id, name: op.name, statement: op.statement, origin: op.origin } };
    case "raise_choice":
      return { action: "raise_choice", session, repo, payload: op.body };
    case "supersede":
      return { action: "supersede", session, repo, payload: { ids: op.ids, grounds: op.grounds, choice: op.body } };
    case "drop_choice":
      return { action: "drop_choice", session, repo, payload: { id: op.id, grounds: op.grounds } };
  }
}

/**
 * Read the plan's two tables, plan the conversion against the state the read door folds, and either show the plan
 * (`--dry-run`) or send it one call at a time. A blocker stops the whole run before any POST: a record whose
 * Purpose is unsettled is never written, and half a column is not a state a person can pick apart.
 */
export async function runIntentConvert(parsed: Parsed): Promise<number> {
  if (process.env.IDD_ID?.trim()) {
    return refuse("idd intent convert は lane の中からは使えません。lane の外のセッションで流してください");
  }
  if (parsed.missing.length) {
    return refuse(`値の付いていない flag があります: ${parsed.missing.map((f) => `--${f}`).join(" ")}`);
  }
  const purposesFile = str(parsed.flags.purposes);
  const assignmentFile = str(parsed.flags.assignment);
  if (!purposesFile) return refuse("--purposes で Purpose の一覧の JSON を渡してください");
  if (!assignmentFile) return refuse("--assignment で割り当ての JSON を渡してください");
  const purposesRead = readJsonFile(purposesFile);
  if ("error" in purposesRead) return refuse(purposesRead.error);
  if (!Array.isArray(purposesRead.json)) return refuse("--purposes の JSON は一覧で書いてください");
  const assignmentRead = readJsonFile(assignmentFile);
  if ("error" in assignmentRead) return refuse(assignmentRead.error);
  if (!isRecord(assignmentRead.json)) return refuse("--assignment の JSON は { ID: P-n } の表で書いてください");
  let review: Record<string, ReviewEntry> | undefined;
  const reviewFile = str(parsed.flags.review);
  if (reviewFile) {
    const read = readJsonFile(reviewFile);
    if ("error" in read) return refuse(read.error);
    if (!isRecord(read.json)) return refuse("--review の JSON は { ID: { … } } の表で書いてください");
    review = read.json as Record<string, ReviewEntry>;
  }
  const repo = outsideRepo(parsed.flags);
  if ("error" in repo) return refuse(repo.error);
  const dryRun = Boolean(parsed.flags["dry-run"]);

  let state: StateRecords;
  try {
    const query = new URLSearchParams({ op: "records", repo: repo.repo });
    const res = await fetch(`${agentBaseUrl()}/api/idd/intent?${query.toString()}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      return refuse(`今の状態を読めませんでした: ${typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`}`);
    }
    state = {
      purposes: Array.isArray(data.purposes) ? (data.purposes as StateRecords["purposes"]) : [],
      choices: Array.isArray(data.choices) ? (data.choices as StateRecords["choices"]) : [],
    };
  } catch (err) {
    return refuse(`口を呼べませんでした: ${String(err)}`);
  }

  const root = process.cwd();
  const records = readLegacyRecords({ root });
  const plan = planConversion({
    records,
    purposes: purposesRead.json as PurposeSeed[],
    assignment: assignmentRead.json as Record<string, string>,
    ...(review ? { review } : {}),
    isDir: (path: string) => isDirectoryUnder(root, path),
  });
  const pending = pendingOps({ plan, state });
  const blockers: Blocker[] = pending.blockers;
  // the report's superseded list and the skipped pairs come from the state comparison, not the plan: a pair the
  // state no longer takes must not read as a replacement this run sends. Both the dry run and the real run build
  // the report and the ops from the same `pending`, so their output can never drift
  const report = {
    ...plan.report,
    superseded: pending.superseded,
    supersede_skipped: pending.supersede_skipped,
    differing: pending.differing,
  };

  if (dryRun) {
    out({ blocked: pending.blocked, blockers, report, ops: pending.ops });
    return pending.blocked ? 1 : 0;
  }
  if (pending.blocked) {
    out({ blocked: true, blockers, report, sent: 0 });
    return 1;
  }

  const session = str(parsed.flags.session) ?? process.env.IDD_SESSION_ID?.trim();
  if (!session) return refuse("lane の外から流すには --session（か IDD_SESSION_ID）が要ります");
  const token = readAgentToken();
  if (!token) return refuse("agent token を読めませんでした");
  let sent = 0;
  for (const op of pending.ops) {
    const posted = await postJsonWithRetry(`${agentBaseUrl()}/api/idd/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(doorBody(op, session, repo.repo)),
    });
    if (posted.error !== undefined) {
      process.stderr.write(`口を呼べませんでした: ${String(posted.error)}（送り済み ${sent} 件）\n`);
      return 1;
    }
    if (!posted.response?.ok || posted.data.ok === false) {
      const reason = typeof posted.data.error === "string" && posted.data.error ? posted.data.error : `API が断りました (HTTP ${posted.response?.status ?? 0})`;
      process.stderr.write(`${reason}（送り済み ${sent} 件）\n`);
      return 1;
    }
    sent += 1;
  }
  out({ ok: true, sent, report });
  return 0;
}
