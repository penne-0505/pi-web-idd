import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { readAreas } from "../config/areas.ts";
import {
  SYNC_SESSION, attachIssues, detachIssues, projectStatuses, recordExternalIssueState, updateProject,
} from "../intent/project-store.ts";
import type { IntentActor } from "../intent/records.ts";
import { trackerSyncOf, trackerSyncRepos } from "./config.ts";
import { createGithubReader } from "./github.ts";
import { createLinearReader } from "./linear.ts";
import { TICK_TIMER_RANDOM_DELAY_SEC } from "./parse.ts";
import { conflictId, planSync, syncedRefs } from "./plan.ts";
import type { TrackerReader } from "./reader.ts";
import {
  patchBaseline, readBaseline, readConflicts, slug, syncDir, writeConflicts, type ConflictRecord,
} from "./store.ts";
import type { BaselinePatch, ExtSnapshot, IntakeOp, PropterSide, SyncPlan, TrackerSyncConfig } from "./types.ts";

/**
 * The one function a tick's stage and `idd project sync` both go through. It reads the outside, compares it with
 * propter and the baseline, takes in what only the outside changed, and keeps the conflicts open. It never writes to
 * the outside: the only things it holds of an outside tracker are a `TrackerReader` and the values that reader returned.
 */

const actor: IntentActor = { session: SYNC_SESSION };

export interface SyncDeps {
  /** the reader of the repo's tracker; the real one by default (a test hands in a fake) */
  readerFor?: (repo: string, cfg: TrackerSyncConfig) => TrackerReader;
  now?: () => Date;
}

export interface SyncRepoResult {
  repo: string;
  skipped?: string;
  error?: string;
  /** the outside's changes propter took in */
  intaken: number;
  /** the units both sides changed, left open for a person to read */
  conflicts: number;
  notes: string[];
}

function emptyResult(repo: string): SyncRepoResult {
  return { repo, intaken: 0, conflicts: 0, notes: [] };
}

export function defaultReader(repo: string, cfg: TrackerSyncConfig): TrackerReader {
  if (cfg.target === "github") return createGithubReader(readAreas().areas[repo]?.linked_repo ?? repo);
  if (!cfg.linearTeam) throw new Error(`repos.${repo}.tracker_sync.linear_team がありません`);
  return createLinearReader(cfg.linearTeam);
}

/**
 * propter's side of the compare, read from the state alone. It includes what a running lane has changed and not yet
 * landed: the lane's change is propter's own, and the outside's value is not taken over it.
 */
export function readPropterSide(repo: string): PropterSide {
  const statuses = projectStatuses(repo, null, { pending: true });
  const closed = new Map<string, boolean>();
  for (const p of statuses) for (const s of p.issueStatuses) closed.set(s.issue, s.closed);
  return {
    projects: statuses.map((p) => ({ id: p.id, name: p.name, body: p.body, issues: p.issues })),
    closed: (ref) => closed.get(ref) ?? false,
  };
}

// ---- one at a time per repo, across processes: two syncs never write one baseline ----

async function withRepoLock<T>(repo: string, wait: boolean, work: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const target = join(syncDir(), `${slug(repo)}.lock`);
  mkdirSync(syncDir(), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, "");
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { retries: wait ? { retries: 40, minTimeout: 250, maxTimeout: 2000 } : 0, stale: 10 * 60 * 1000 });
  } catch {
    return { ran: false };
  }
  try {
    return { ran: true, value: await work() };
  } finally {
    await release();
  }
}

// ---- taking the outside's change into propter ----

/**
 * Each write names the value the compare read in the same call that writes it, and is refused inside the column's lock
 * when propter's value moved since. An outside value is never put over a change that came in between.
 */
async function applyIntake(repo: string, op: IntakeOp, side: PropterSide): Promise<string | null> {
  if (op.op === "project_body") {
    const was = side.projects.find((p) => p.id === op.project)?.body.trim();
    const r = await updateProject({ repo, actor, id: op.project, patch: { body: op.value }, ...(was !== undefined ? { expectBody: was } : {}) });
    return r.ok ? null : `${op.project} の本文を取り込めません: ${r.error}`;
  }
  if (op.op === "issue_closed") {
    const r = await recordExternalIssueState({ repo, actor, issue: op.ref, closed: op.closed });
    return r.ok ? null : `${op.ref} の状態を取り込めません: ${r.error}`;
  }
  const owner = side.projects.find((p) => p.issues.includes(op.ref))?.id ?? "";
  if (op.project) {
    const r = await attachIssues({ repo, actor, id: op.project, issues: [op.ref], expectOwner: owner });
    return r.ok ? null : `${op.ref} の所属を取り込めません: ${r.error}`;
  }
  if (!owner) return null;
  const r = await detachIssues({ repo, actor, id: owner, issues: [op.ref], expectOwner: owner });
  return r.ok ? null : `${op.ref} の所属を外せません: ${r.error}`;
}

/** the conflict id of the unit an intake write is about, or null for a unit that is never a conflict */
function unitOf(repo: string, op: IntakeOp): string | null {
  if (op.op === "project_body") return conflictId(repo, "project_body", op.project);
  if (op.op === "issue_project") return conflictId(repo, "issue_project", op.ref);
  return null;
}

/**
 * The plan, with the units whose take-in was refused judged again against propter as it stands now. A refused write means
 * propter moved after the compare, so the outside and propter now differ from each other and from the baseline: the same
 * outside read is compared once more for those units, and the ones that conflict now are shown. A unit that still does not
 * conflict keeps the card it had, which only a compare that settled it may drop.
 */
export function withRefused(
  repo: string, plan: SyncPlan, refused: ReadonlySet<string>,
  input: { cfg: TrackerSyncConfig; baseline: Parameters<typeof planSync>[0]["baseline"]; ext: ExtSnapshot; owns: (ref: string) => boolean },
): SyncPlan {
  if (refused.size === 0) return plan;
  const again = planSync({ repo, ...input, prop: readPropterSide(repo) });
  return {
    ...plan,
    conflicts: [...plan.conflicts, ...again.conflicts.filter((c) => refused.has(c.id))],
    compared: plan.compared.filter((id) => !refused.has(id)),
    uncertain: [...plan.uncertain, ...refused],
  };
}

/**
 * The conflicts the plan found, kept as open records; the ones that moved are refreshed and the rest keep the time they
 * were raised. An open one is dropped when this sync compared that very unit and it no longer conflicts (a side went back
 * to the same value), and, when the outside was read whole, when the unit is no longer one the plan can compare. With
 * a cut-off read, a unit the outside did not show stays open: nothing was seen that settles it.
 */
function keepConflicts(open: readonly ConflictRecord[], repo: string, plan: SyncPlan, truncated: boolean, now: string): ConflictRecord[] {
  const compared = new Set(plan.compared);
  const found = new Set(plan.conflicts.map((c) => c.id));
  const byId = new Map(open.map((c) => [c.id, c]));
  const out: ConflictRecord[] = plan.conflicts.map((c) => ({ ...c, repo, raisedAt: byId.get(c.id)?.raisedAt ?? now }));
  const uncertain = new Set(plan.uncertain);
  for (const c of open) if (!found.has(c.id) && !compared.has(c.id) && (truncated || uncertain.has(c.id))) out.push(c);
  return out.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id.localeCompare(b.id));
}

/**
 * How long after a run the next one is due. The tick timer starts up to `RandomizedDelaySec` late, so two ticks a full
 * interval apart can be a little less than the interval apart; asking for the full interval would skip the tick that
 * comes right on time. The slack is the timer's own delay, and at most half the interval for a short one.
 */
function dueAfterMs(intervalMinutes: number): number {
  const interval = intervalMinutes * 60_000;
  return interval - Math.min(TICK_TIMER_RANDOM_DELAY_SEC * 1000, interval / 2);
}

/** how many times the outside is read again when propter moved during the read */
const READ_ATTEMPTS = 3;

/** propter's side in one string, to see whether it moved: the Projects as read, and which of their Issues count closed */
function fingerprintOf(side: PropterSide): string {
  const refs = [...new Set(side.projects.flatMap((p) => p.issues))].sort();
  return JSON.stringify([side.projects, refs.map((r) => [r, side.closed(r)])]);
}

export async function syncRepo(repo: string, opts: { force?: boolean } = {}, deps: SyncDeps = {}): Promise<SyncRepoResult> {
  const result = emptyResult(repo);
  if (!trackerSyncOf(repo)) return { ...result, skipped: "repo の設定に tracker_sync がありません" };
  try {
    const locked = await withRepoLock(repo, Boolean(opts.force), () => syncRepoOnce(repo, opts, deps));
    return locked.ran ? locked.value : { ...result, skipped: "別の同期が動いているので、次の同期に回します" };
  } catch (err) {
    return { ...result, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) };
  }
}

async function syncRepoOnce(repo: string, opts: { force?: boolean }, deps: SyncDeps): Promise<SyncRepoResult> {
  const result = emptyResult(repo);
  const cfg = trackerSyncOf(repo);
  if (!cfg) return { ...result, skipped: "repo の設定に tracker_sync がありません" };
  const now = (deps.now ?? (() => new Date()))();
  // a baseline that is there and cannot be read stops the sync here (the caller's catch says so); it is never read as empty
  const base0 = readBaseline(repo);
  const open0 = readConflicts(repo);
  if (!opts.force && base0.lastRunAt && now.getTime() - new Date(base0.lastRunAt).getTime() < dueAfterMs(cfg.intervalMinutes)) {
    return { ...result, skipped: `前の同期から ${cfg.intervalMinutes} 分が経っていません` };
  }
  const reader = (deps.readerFor ?? defaultReader)(repo, cfg);
  // Reading the outside is the slow step, and propter can change while it runs. The compare uses propter's side as it
  // stands after the read: when it moved meanwhile, the outside is read again against the new state, so an edit made
  // during the read is a change of propter's to compare, never a value the outside's older copy overwrites.
  let side = readPropterSide(repo);
  let ext: ExtSnapshot | null = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS && !ext; attempt += 1) {
    const refs = [...new Set([...side.projects.flatMap((p) => p.issues).filter((r) => reader.owns(r)), ...syncedRefs(base0, reader.owns)])];
    const read = await reader.read(refs);
    const after = readPropterSide(repo);
    if (fingerprintOf(after) === fingerprintOf(side)) ext = read;
    side = after;
  }
  if (!ext) return { ...result, skipped: "外を読んでいる間に propter が変わり続けたので、次の同期に回します" };
  const plan: SyncPlan = planSync({ repo, cfg, baseline: base0, ext, prop: side, owns: reader.owns });
  result.notes.push(...plan.notes);
  if (ext.truncated) result.notes.push("外の一覧が上限で切れています。propter が追う Issue は一覧に無くても個別に読み、読めなかったものは消えたとは扱いません");

  // what is already in step, and what only the outside changed
  const settled: BaselinePatch[] = [...plan.settled];
  const patches: BaselinePatch[] = [];
  let failures = 0;
  const refused = new Set<string>();
  for (const op of plan.intake) {
    const failed = await applyIntake(repo, op, side);
    if (failed) {
      failures += 1;
      const id = unitOf(repo, op);
      if (id) refused.add(id);
      result.notes.push(`${failed}。次の同期でもう一度比べます`);
      continue;
    }
    patches.push(...op.base);
    result.intaken += 1;
  }
  // letting go of a gone Project's pair also drops the baseline of every Issue that was in it: with a take-in refused,
  // that baseline is still needed to compare again next time
  patches.unshift(...settled.filter((p) => failures === 0 || p.unit !== "unlink"));
  patchBaseline(repo, patches, { lastRunAt: now.toISOString() });

  // what both changed waits, and neither value is taken
  const kept = withRefused(repo, plan, refused, { cfg, baseline: base0, ext, owns: reader.owns });
  writeConflicts(repo, keepConflicts(open0, repo, kept, Boolean(ext.truncated), now.toISOString()));
  result.conflicts = kept.conflicts.length;
  return result;
}

/** every synced repo, or the one named; one repo's failure (Linear being slow, say) never stops another's sync */
export async function runTrackerSync(opts: { repo?: string; force?: boolean } = {}, deps: SyncDeps = {}): Promise<SyncRepoResult[]> {
  const repos = opts.repo ? [opts.repo] : trackerSyncRepos();
  const out: SyncRepoResult[] = [];
  for (const repo of repos) out.push(await syncRepo(repo, { force: opts.force }, deps));
  return out;
}
