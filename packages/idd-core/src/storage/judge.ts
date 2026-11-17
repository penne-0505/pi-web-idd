import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readAreas, readStorageConfig } from "../config/areas.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { deriveStage, withoutNotes } from "../ledger/derive.ts";
import { FINAL_ENDS } from "../plan/close.ts";
import { listReviewLanes } from "../review-lane/store.ts";
import { reviewLaneState } from "../review-lane/state.ts";
import { getAgentRunner } from "../agent/port.ts";
import { landChecksRunning } from "../overlay/land-run.ts";
import { stateDir } from "../paths.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { SizeCache } from "./measure.ts";
import type { Candidate, Evidence, Judgement, Kept, PlaceUsage, Removal } from "./types.ts";
import { STORAGE_PLACE_LABELS, type PlaceSettings, type StorageConfig, type StoragePlace } from "./config.ts";

type PlaceName = Candidate["place"];

interface Found {
  path: string;
  bytes: number;
  usedUpAt?: string;
  lane?: string;
  reason?: string;
}

interface PlaceResult {
  place: PlaceName;
  label: string;
  cleanup: boolean | null;
  sweepable?: boolean;
  note?: string;
  candidates: Candidate[];
  kept: Kept[];
  /** every item of the place, for the usage list */
  items: Found[];
}

export interface JudgeOptions {
  now?: number;
  /** the size cache; the sweep passes one and adds nothing to it */
  sizes?: SizeCache;
  /** measure the paths that are not cached (the API does; the sweep does not) */
  measure?: boolean;
}

const DATE = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
};

const later = (a: string | undefined, b: string | undefined): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Whether a path is strictly inside a root, both resolved to their real form (a place may itself be a symlink).
 * The root itself is not "inside": a record that names the place would otherwise let the sweep delete the whole
 * place and everything beside it.
 */
export function withinReal(path: string, root: string): boolean {
  const rel = relative(real(root), real(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** a real directory, not a symlink to one (lstat does not follow) */
export const isRealDir = (p: string): boolean => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

/** the clone a linked worktree was cut from, read from its own `.git` file */
function cloneOf(copy: string): string | undefined {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(copy, ".git"), "utf8"))?.[1]?.trim();
    if (!gitdir) return undefined;
    // <clone>/.git/worktrees/<name> → <clone>
    return resolve(copy, gitdir, "..", "..");
  } catch {
    return undefined;
  }
}

/** the IDD / REV lane a pipeline path segment names */
function laneIdOf(segment: string): string | undefined {
  return /^(IDD-\d+|REV-[0-9A-Za-z-]+)/.exec(segment)?.[1];
}

function laneIdFromSpec(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined;
  const m = /\/(review|plan-review|r2|feedback)\/([^/]+)/.exec(spec.replaceAll("\\", "/"));
  return m ? laneIdOf(m[2]) : undefined;
}

interface CloseTimes {
  events: LifecycleRecord[];
  reviewLanes: Map<string, { at: string; closed: boolean }>;
}

/** when a lane came to an end the sweep accepts, or null while it is open or unknown */
function laneEndedAt(laneId: string, ctx: CloseTimes): string | null {
  // a caller may pass an id the record never held (a line without `idd_id`): it names nothing, so nothing ends
  if (typeof laneId !== "string" || !laneId) return null;
  if (laneId.startsWith("REV-")) {
    const rec = ctx.reviewLanes.get(laneId);
    if (!rec || !rec.closed) return null;
    return rec.at;
  }
  if (!laneId.startsWith("IDD-")) return null;
  const e = ctx.events.find((x) => x.idd_id === laneId && FINAL_ENDS.includes(x.event));
  return e ? e.at : null;
}

/** when the lane came to the judge / waiting stretch it is in now, or undefined while it is not there */
function waitSince(all: LifecycleRecord[]): string | undefined {
  const evs = withoutNotes(all);
  const group = () => deriveStage(evs).group;
  if (group() !== "judge" && group() !== "waiting") return undefined;
  let i = evs.length;
  while (i > 1) {
    const g = deriveStage(evs.slice(0, i - 1)).group;
    if (g !== "judge" && g !== "waiting") break;
    i -= 1;
  }
  return evs[i - 1]?.at;
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as T]; } catch { return []; }
  });
}

interface RunMeta {
  lane_id: string;
  stage?: string;
  role?: string;
  copy?: string;
  source?: string;
  repo?: string;
  cleaned?: boolean;
}

interface LaneJson {
  id?: string;
  status?: string;
  idd_id?: string;
  spec?: string;
  mode?: string;
  started_at?: string;
  ended_at?: string;
}

/**
 * An ad-hoc run's own end, only when the record says it ended for good. A mode conversation (chat / idea) is
 * resumed from where it stopped, so no status closes it: its `ended_at` is written on every stop, and deleting
 * the record takes the conversation's own display and cost with it. For any other ad-hoc run, the record must
 * hold a closure it wrote: `done`, `failed` or `timeout`, with that `ended_at` (a merely stopped record is
 * left, whatever its age).
 */
function adHocEndedAt(lane: LaneJson): string | undefined {
  if (lane.mode === "conversation") return undefined;
  const ended = DATE(lane.ended_at);
  if (!ended) return undefined;
  return lane.status === "done" || lane.status === "failed" || lane.status === "timeout" ? ended : undefined;
}

interface ReviewLaneJson {
  id: string;
  repo: string;
  history: { event: string; at: string; attrs: Record<string, unknown> }[];
  created_at: string;
}

export class Judge {
  private readonly now: number;
  private readonly sizes: SizeCache;
  private readonly measure: boolean;
  private readonly config: StorageConfig;
  private readonly verdicts: Judgement;

  constructor(opts: JudgeOptions = {}) {
    this.now = opts.now ?? Date.now();
    this.sizes = opts.sizes ?? new SizeCache();
    this.measure = opts.measure ?? true;
    this.config = readStorageConfig();
    this.verdicts = { places: [], candidates: [], kept: [] };
  }

  private placeSettings(place: StoragePlace): PlaceSettings {
    return this.config.places[place];
  }

  private async size(path: string): Promise<number> {
    if (!this.measure) return this.sizes.cached(path) ?? 0;
    return this.sizes.sizeOf(path, this.now);
  }

  private due(usedUpAt: string, keepMs: number): string {
    return new Date(Date.parse(usedUpAt) + keepMs).toISOString();
  }

  async judge(): Promise<Judgement> {
    const events = readLifecycle();
    const ctx: CloseTimes = {
      events,
      reviewLanes: new Map(listReviewLanes().map((r) => [r.id, { at: r.history.at(-1)?.at ?? r.created_at, closed: reviewLaneState(r).state === "closed" }])),
    };

    const results: PlaceResult[] = [];
    results.push(await this.reviewRunCopies(ctx));
    results.push(await this.reviewLaneCopies(ctx));
    results.push(await this.manualCopies(ctx));
    results.push(await this.runRecords(ctx));
    results.push(await this.stageFiles(ctx));
    results.push(await this.outboxFiles(ctx));
    results.push(await this.cronRuns());
    results.push(await this.buildOutputs(events));

    for (const r of results) {
      this.verdicts.candidates.push(...r.candidates);
      this.verdicts.kept.push(...r.kept);
      this.verdicts.places.push({
        place: r.place,
        label: r.label,
        bytes: r.items.reduce((n, i) => n + i.bytes, 0),
        count: r.items.length,
        cleanup: r.cleanup,
        ...(r.sweepable !== undefined ? { sweepable: r.sweepable } : {}),
        ...(r.note ? { note: r.note } : {}),
      });
    }
    // an archive dir that is set but not visible keeps the run records and stage files: the records are
    // unreadable without it, and the sweep must not delete what it could not write (AC-039)
    if (this.config.archiveDir && !existsSync(this.config.archiveDir)) {
      const held = new Set<PlaceName>(["run_records", "stage_files"]);
      const keep = this.verdicts.candidates.filter((c) => held.has(c.place));
      this.verdicts.candidates = this.verdicts.candidates.filter((c) => !held.has(c.place));
      for (const c of keep) this.verdicts.kept.push({ place: c.place, path: c.path, ...(c.lane ? { lane: c.lane } : {}), reason: `保存先が見えません: ${this.config.archiveDir}` });
    }
    return this.verdicts;
  }

  /** a place's configurable cleanup flag: the whole sweep off means every place is off */
  private placeOn(place: StoragePlace): boolean {
    return this.config.cleanup && this.placeSettings(place).cleanup;
  }

  private candidate(place: PlaceName, found: Found, removal: Removal, evidence: Evidence, keepMs: number, clone?: string): Candidate {
    return {
      place,
      path: found.path,
      bytes: found.bytes,
      usedUpAt: found.usedUpAt as string,
      dueAt: this.due(found.usedUpAt as string, keepMs),
      ...(found.lane ? { lane: found.lane } : {}),
      removal,
      ...(clone ? { clone } : {}),
      evidence,
    };
  }

  /** the review runs' copies. The record that names one is `state/pipeline/review-runs/<run>.json`; a run still
   * running, or one whose record says it was cleaned, is left. The evidence is the record's `cleaned` flag. */
  private async reviewRunCopies(_ctx: CloseTimes): Promise<PlaceResult> {
    const metaDir = join(stateDir(), "pipeline", "review-runs");
    const settings = this.placeSettings("review_copies");
    const out: PlaceResult = { place: "review_run_copies", label: "レビューの run の複製", cleanup: this.placeOn("review_copies"), candidates: [], kept: [], items: [] };
    if (!existsSync(metaDir)) return out;
    // the runs cut their copies under the state's own review-wt (the reviewRoot review-runs hands to addWorktree),
    // not the repos.yaml review_root: the place to check against is that one
    const place = join(stateDir(), "pipeline", "review-wt");
    for (const name of readdirSync(metaDir)) {
      if (!name.endsWith(".json")) continue;
      const metaPath = join(metaDir, name);
      const meta = readJson<RunMeta>(metaPath);
      if (!meta?.copy) continue;
      // the record's copy is realpath'd and must sit inside the run copies' place: a broken record or a copy
      // moved outside must not let a directory outside the place be removed
      const path = resolve(meta.copy);
      const lane = readJson<LaneJson>(join(stateDir(), "lanes", meta.lane_id, "lane.json"));
      const bytes = await this.size(path);
      out.items.push({ path, bytes });
      if (meta.cleaned) continue;
      if (!existsSync(path)) continue;
      if (!withinReal(path, place)) {
        out.kept.push({ place: out.place, path, lane: meta.source, reason: "置き場の外にある複製です" });
        continue;
      }
      if (lane?.status === "running") {
        out.kept.push({ place: out.place, path, reason: "run が動いています" });
        continue;
      }
      if (!lane) {
        out.kept.push({ place: out.place, path, reason: "run の記録が読めません" });
        continue;
      }
      if (isLink(path) || !isRealDir(path)) {
        out.kept.push({ place: out.place, path, reason: "symlink か dir ではありません" });
        continue;
      }
      const usedUpAt = DATE(lane.ended_at) ?? DATE(lane.started_at) ?? new Date(this.now).toISOString();
      out.candidates.push(this.candidate(out.place, { path, bytes, usedUpAt, lane: meta.source }, "git-worktree", { kind: "review-run", path: metaPath }, settings.keepMs, cloneOf(path) ?? meta.source));
    }
    return out;
  }

  /** the review lanes' PR copies: the lane's record names the copy; a closed lane's copy is the sweep's */
  private async reviewLaneCopies(ctx: CloseTimes): Promise<PlaceResult> {
    const settings = this.placeSettings("review_copies");
    const out: PlaceResult = { place: "review_lane_copies", label: "レビュー lane の PR の複製", cleanup: this.placeOn("review_copies"), candidates: [], kept: [], items: [] };
    const areas = readAreas();
    for (const rec of listReviewLanes()) {
      const ready = [...rec.history].reverse().find((e) => e.event === "r_wt_ready");
      const p = ready?.attrs?.path;
      if (typeof p !== "string" || !p) continue;
      const path = resolve(p);
      const bytes = await this.size(path);
      out.items.push({ path, bytes, lane: rec.id });
      if (!existsSync(path)) continue;
      const closedAt = ctx.reviewLanes.get(rec.id)?.closed ? ctx.reviewLanes.get(rec.id)?.at : null;
      const roots = Object.values(areas.reviewRoots ?? {});
      const underRoot = roots.length === 0 ? false : roots.some((r) => withinReal(path, r));
      if (!underRoot) {
        out.kept.push({ place: out.place, path, lane: rec.id, reason: "置き場の外にある複製です" });
        continue;
      }
      if (!closedAt) {
        out.kept.push({ place: out.place, path, lane: rec.id, reason: "レビュー lane が閉じていません" });
        continue;
      }
      if (isLink(path) || !isRealDir(path)) {
        out.kept.push({ place: out.place, path, lane: rec.id, reason: "symlink か dir ではありません" });
        continue;
      }
      out.candidates.push(this.candidate(out.place, { path, bytes, usedUpAt: closedAt, lane: rec.id }, "git-worktree", { kind: "ledger" }, settings.keepMs, cloneOf(path)));
    }
    return out;
  }

  /** copies a person cut (`idd wt add`): shown with a size, never swept */
  private async manualCopies(ctx: CloseTimes): Promise<PlaceResult> {
    const out: PlaceResult = { place: "manual_copies", label: "手動のレビュー用の複製", cleanup: null, candidates: [], kept: [], items: [] };
    const areas = readAreas();
    const named = new Set(listReviewLanes().flatMap((r) => {
      const ready = [...r.history].reverse().find((e) => e.event === "r_wt_ready");
      return typeof ready?.attrs?.path === "string" ? [real(ready.attrs.path as string)] : [];
    }));
    const runCopies = new Set(readdirSyncSafe(join(stateDir(), "pipeline", "review-runs")).flatMap((n) => {
      const m = readJson<RunMeta>(join(stateDir(), "pipeline", "review-runs", n));
      return m?.copy ? [real(m.copy)] : [];
    }));
    for (const root of Object.values(areas.reviewRoots ?? {})) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (name.endsWith(".json")) continue;
        const path = join(root, name);
        if (!isRealDir(path)) continue;
        // a copy of this root that no record names is a person's
        if (named.has(real(path)) || runCopies.has(real(path))) continue;
        if (!existsSync(join(root, `${name}.json`))) continue;
        out.items.push({ path, bytes: await this.size(path) });
        out.kept.push({ place: out.place, path, reason: "手動の複製です（人が消す）" });
      }
    }
    return out;
  }

  /** the agents' run records under state/lanes: a lane's own runs wait for the lane; an ad-hoc run waits for its end */
  private async runRecords(ctx: CloseTimes): Promise<PlaceResult> {
    const settings = this.placeSettings("run_records");
    const out: PlaceResult = { place: "run_records", label: "役の実行の記録", cleanup: this.placeOn("run_records"), candidates: [], kept: [], items: [] };
    const root = join(stateDir(), "lanes");
    for (const name of readdirSyncSafe(root)) {
      const dir = join(root, name);
      const lanePath = join(dir, "lane.json");
      if (!existsSync(lanePath) || !isRealDir(dir)) continue;
      const lane = readJson<LaneJson>(lanePath);
      if (!lane) continue;
      const bytes = await this.size(dir);
      const laneId = (typeof lane.idd_id === "string" && lane.idd_id) || laneIdFromSpec(lane.spec);
      // a spec under the pipeline belongs to a lane even when its name cannot be read: such a run is never swept
      const inPipeline = typeof lane.spec === "string" && /\/pipeline\/(review|plan-review|r2|feedback)\//.test(lane.spec.replaceAll("\\", "/"));
      out.items.push({ path: dir, bytes, ...(laneId ? { lane: laneId } : {}) });
      if (isLink(dir)) { out.kept.push({ place: out.place, path: dir, reason: "symlink です" }); continue; }
      if (lane.status === "running") { out.kept.push({ place: out.place, path: dir, ...(laneId ? { lane: laneId } : {}), reason: "実行が動いています" }); continue; }
      const endedAt = laneId
        ? laneEndedAt(laneId, ctx)
        : inPipeline
          ? null
          : adHocEndedAt(lane);
      if (!endedAt) {
        const reason = laneId ? "属する lane が閉じていません" : inPipeline ? "属する lane を記録から決められません" : "実行の終わりが記録にありません";
        out.kept.push({ place: out.place, path: dir, ...(laneId ? { lane: laneId } : {}), reason });
        continue;
      }
      out.candidates.push(this.candidate(out.place, { path: dir, bytes, usedUpAt: endedAt, ...(laneId ? { lane: laneId } : {}) }, "contents-then-evidence", { kind: "lane-json", path: lanePath }, settings.keepMs));
    }
    return out;
  }

  /** the stages' own directories under state/pipeline: a lane's reports, named by the lane in the directory name */
  private async stageFiles(ctx: CloseTimes): Promise<PlaceResult> {
    const settings = this.placeSettings("stage_files");
    const out: PlaceResult = { place: "stage_files", label: "段の入出力", cleanup: this.placeOn("stage_files"), candidates: [], kept: [], items: [] };
    const pipeline = join(stateDir(), "pipeline");
    const roots: { dir: string; prefix: boolean }[] = [
      { dir: join(pipeline, "review"), prefix: false },
      { dir: join(pipeline, "plan-review"), prefix: true },
      // R2 wrote here until it was removed (2026-10-22): the past runs' files are still swept with their lanes
      { dir: join(pipeline, "r2"), prefix: false },
      { dir: join(pipeline, "feedback"), prefix: false },
      // the one-off plan run's inputs, named by lane id like the others: an open lane's stay (F-121-8)
      { dir: join(pipeline, "fix-plan"), prefix: false },
    ];
    for (const { dir, prefix } of roots) {
      for (const name of readdirSyncSafe(dir)) {
        const path = join(dir, name);
        if (!isRealDir(path)) continue;
        const laneId = laneIdOf(name);
        const bytes = await this.size(path);
        out.items.push({ path, bytes, ...(laneId ? { lane: laneId } : {}) });
        if (!laneId) { out.kept.push({ place: out.place, path, reason: "lane を名前から決められません" }); continue; }
        if (isLink(path)) { out.kept.push({ place: out.place, path, lane: laneId, reason: "symlink です" }); continue; }
        const endedAt = laneEndedAt(laneId, ctx);
        if (!endedAt) { out.kept.push({ place: out.place, path, lane: laneId, reason: "lane が閉じていません" }); continue; }
        // the directory's own lane is what the name says; a plan-review's suffix is trimmed by laneIdOf
        void prefix;
        out.candidates.push(this.candidate(out.place, { path, bytes, usedUpAt: endedAt, lane: laneId }, "dir", { kind: "ledger" }, settings.keepMs));
      }
    }
    return out;
  }

  /** the envelope bodies whose lane is closed; the outbox.jsonl line stays */
  private async outboxFiles(ctx: CloseTimes): Promise<PlaceResult> {
    const settings = this.placeSettings("outbox");
    const out: PlaceResult = { place: "outbox", label: "outbox の本文", cleanup: this.placeOn("outbox"), candidates: [], kept: [], items: [] };
    const dir = join(stateDir(), "outbox");
    const records = readJsonl<{ envelope_id?: unknown; idd_id?: unknown }>(join(stateDir(), "outbox.jsonl"));
    const latest = new Map<string, { envelope_id: string; idd_id: string }>();
    for (const r of records) {
      // a line that does not hold both ids names nothing the sweep can tie to a lane: it is skipped, and the
      // lines that do hold them are still judged (one bad line must not stop the whole judgement)
      if (typeof r.envelope_id !== "string" || !r.envelope_id) continue;
      if (typeof r.idd_id !== "string" || !r.idd_id) continue;
      latest.set(r.envelope_id, { envelope_id: r.envelope_id, idd_id: r.idd_id });
    }
    for (const r of latest.values()) {
      const path = join(dir, `${r.envelope_id}.xml`);
      if (!existsSync(path)) continue;
      const bytes = await this.size(path);
      out.items.push({ path, bytes, lane: r.idd_id });
      // the body the record names must really sit inside the outbox place: an `envelope_id` that climbs out with
      // `..` (a corrupt or hand-edited outbox.jsonl) must not turn into a path the sweep would delete
      if (!withinReal(path, dir)) {
        out.kept.push({ place: out.place, path, lane: r.idd_id, reason: "置き場の外にある本文です" });
        continue;
      }
      const endedAt = laneEndedAt(r.idd_id, ctx);
      if (!endedAt) { out.kept.push({ place: out.place, path, lane: r.idd_id, reason: "宛先の lane が閉じていません" }); continue; }
      out.candidates.push(this.candidate(out.place, { path, bytes, usedUpAt: endedAt, lane: r.idd_id }, "file", { kind: "ledger" }, settings.keepMs));
    }
    return out;
  }

  /** the tick runs' records: every one but the newest is used up */
  private async cronRuns(): Promise<PlaceResult> {
    const settings = this.placeSettings("cron_runs");
    const out: PlaceResult = { place: "cron_runs", label: "cron の実行の記録", cleanup: this.placeOn("cron_runs"), candidates: [], kept: [], items: [] };
    const dir = stateDir();
    const files = readdirSyncSafe(dir).filter((f) => f.startsWith("cron-run-") && f.endsWith(".json"));
    if (!files.length) return out;
    const withM = files.map((f) => {
      const path = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { /* unreadable: treated as oldest */ }
      return { f, path, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    const newest = withM[0];
    for (const item of withM) {
      const rec = readJson<{ cron_run_id?: string; started_at?: string; completed_at?: string }>(item.path);
      const bytes = await this.size(item.path);
      out.items.push({ path: item.path, bytes });
      if (item.path === newest.path) { out.kept.push({ place: out.place, path: item.path, reason: "最新の 1 個です" }); continue; }
      // the record itself must say the run closed: its own id and a completed_at. A file whose record cannot be
      // read, or says nothing about its end, is not something a name and an age may delete.
      const closed = DATE(rec?.completed_at);
      if (!closed || typeof rec?.cron_run_id !== "string" || !rec.cron_run_id) {
        out.kept.push({ place: out.place, path: item.path, reason: "実行の終わりが記録にありません" });
        continue;
      }
      out.candidates.push(this.candidate(out.place, { path: item.path, bytes, usedUpAt: closed }, "file", { kind: "none" }, settings.keepMs));
    }
    return out;
  }

  /** a declared build output of a worktree whose lane waits on a person, is not running, and is untracked */
  private async buildOutputs(events: LifecycleRecord[]): Promise<PlaceResult> {
    const settings = this.placeSettings("build_outputs");
    const runner = getAgentRunner();
    const declared = readAreas().buildOutputs ?? {};
    const anyDeclaration = Object.keys(declared).length > 0;
    const out: PlaceResult = {
      place: "build_outputs",
      label: "ビルド出力",
      cleanup: this.placeOn("build_outputs"),
      sweepable: anyDeclaration && Boolean(runner?.sessionStatus && runner?.cwdBusy),
      candidates: [],
      kept: [],
      items: [],
    };
    if (!anyDeclaration) { out.note = "repo の build_outputs の宣言がありません"; return out; }
    if (!runner?.sessionStatus || !runner?.cwdBusy) { out.note = "agent の runtime が無いので session の状態を確かめられません"; return out; }
    const planners = readSessions("planner");
    const executors = readSessions("executor");
    const byLane = new Map<string, LifecycleRecord[]>();
    for (const e of events) {
      const list = byLane.get(e.idd_id) ?? [];
      list.push(e);
      byLane.set(e.idd_id, list);
    }
    for (const [area, paths] of Object.entries(declared)) {
      for (const rec of readBacklog()) {
        if (rec.area !== area) continue;
        const evs = byLane.get(rec.idd_id) ?? [];
        const d = deriveStage(evs);
        if (d.group !== "judge" && d.group !== "waiting") continue;
        const session = executors.filter((r) => r.idd_id === rec.idd_id).pop() ?? planners.filter((r) => r.idd_id === rec.idd_id).pop();
        const worktree = session?.worktree_path;
        if (!worktree || !existsSync(worktree)) continue;
        const since = waitSince(evs);
        if (!since) continue;
        // the session's state, the worktree's own busy flag and any check running are asked before anything is
        // deleted; a state that cannot be told keeps the item (the same judgement is asked again just before the
        // delete, so something that changed since this listing is not swept)
        const busy = await worktreeBusyReason(rec.idd_id, worktree);
        for (const rel of paths) {
          const path = resolve(worktree, rel);
          if (!withinReal(path, worktree)) continue;
          if (!existsSync(path)) continue;
          const bytes = await this.size(path);
          out.items.push({ path, bytes, lane: rec.idd_id });
          if (isLink(path) || !isRealDir(path)) { out.kept.push({ place: out.place, path, lane: rec.idd_id, reason: "symlink か dir ではありません" }); continue; }
          if (busy) { out.kept.push({ place: out.place, path, lane: rec.idd_id, reason: busy }); continue; }
          if (trackedFiles(worktree, rel)) { out.kept.push({ place: out.place, path, lane: rec.idd_id, reason: "git が追跡するファイルを含みます" }); continue; }
          out.candidates.push(this.candidate(out.place, { path, bytes, usedUpAt: since, lane: rec.idd_id }, "dir", { kind: "none" }, settings.keepMs, worktree));
        }
      }
    }
    return out;
  }
}

/**
 * Why the lane's worktree must not be swept now, or undefined when it is free: the lane's sessions' states, any
 * session working in the directory, and any repo check running there. Asked both when a build output is listed as
 * a candidate and again just before it is deleted, so the same answer decides both (DEC-10042).
 */
async function worktreeBusyReason(laneId: string, worktree: string): Promise<string | undefined> {
  const runner = getAgentRunner();
  if (!runner?.sessionStatus) return "session の状態を確かめられません";
  if (!runner.cwdBusy) return "worktree の session の有無を確かめられません";
  const session = readSessions("executor").filter((r) => r.idd_id === laneId).pop() ?? readSessions("planner").filter((r) => r.idd_id === laneId).pop();
  if (!session) return "session の記録がありません";
  const ids = [session.executor_session_id, session.planner_session_id].filter((x): x is string => Boolean(x));
  for (const id of ids) {
    const st = await runner.sessionStatus(id).catch(() => ({ state: "unknown" } as const));
    if (st.state === "running") return "session が動いています";
    if (st.state !== "stopped") return `session の状態を確かめられません（${st.state}）`;
  }
  if (runner.cwdBusy(worktree)) return "この worktree で動いている session があります";
  if (landChecksRunning(worktree)) return "検査が走っています";
  return undefined;
}

/**
 * Whether a declared build output may be deleted right now. The conditions the judgement applied when the
 * candidate was listed are asked again here, because the sweep may delete minutes after that listing: the lane
 * still waits on a person, no session or check is at the worktree, and the target is still an untracked real
 * directory inside the worktree (DEC-10042, DEC-10046).
 */
export async function buildOutputStillFree(candidate: Candidate): Promise<{ ok: true } | { ok: false; reason: string }> {
  const laneId = candidate.lane;
  const worktree = candidate.clone;
  if (!laneId) return { ok: false, reason: "属する lane が分かりません" };
  if (!worktree) return { ok: false, reason: "worktree が分かりません" };
  const group = deriveStage(readLifecycle().filter((e) => e.idd_id === laneId)).group;
  if (group !== "judge" && group !== "waiting") return { ok: false, reason: "lane が動き出しました" };
  const busy = await worktreeBusyReason(laneId, worktree);
  if (busy) return { ok: false, reason: busy };
  if (!withinReal(candidate.path, worktree)) return { ok: false, reason: "置き場の外です" };
  if (isLink(candidate.path) || !isRealDir(candidate.path)) return { ok: false, reason: "symlink か dir ではありません" };
  if (trackedFiles(worktree, relative(worktree, candidate.path))) return { ok: false, reason: "git が追跡するファイルを含みます" };
  return { ok: true };
}

function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** whether git tracks any file under a worktree-relative path (a declared build output must hold none) */
export function trackedFiles(worktree: string, rel: string): boolean {
  try {
    const out = execFileSync("git", ["-C", worktree, "ls-files", "--", rel], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return out.trim() !== "";
  } catch {
    // a worktree git cannot read is treated as holding tracked files: the sweep must not delete there
    return true;
  }
}

export async function judge(opts: JudgeOptions = {}): Promise<Judgement> {
  return new Judge(opts).judge();
}

export { STORAGE_PLACE_LABELS };
