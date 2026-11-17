import {
  areaSegment, changedFiles, decisionIndex, deriveStage, laneActivity, laneBaseMissing, laneBranchSource, laneForkPoint,
  laneStageSpans, lanesAwaitingPrep, parseDecisionFields, laneIntent, laneRecordShape, lookupChoices, readAreas, readBacklog, readArchivedDecisionDocs, readDecisionDocs, readIntakeHolds, readLifecycle,
  readSessions, readyIntentImpactOf, resolveWorktree, reviewBaseOf, reviewLaneState, reviewLaneStageSpans, slotWaits, slugOf, withoutNotes,
  listReviewLanes,
  acStatesForLane, buildVerificationLog, criterionKey, findingsForPaths, findingsOfLane, readWorkRows, workColumnPath,
  awaitingQuestion,
} from "@idd/core";
import type { BacklogRecord, DecisionKind, HeldIssue, LifecycleRecord, StageSpan } from "@idd/core";
import { laneRootOf, REAL_DERIVED, type DerivedDeps } from "./derived";
import { laneSlotWait } from "../../../../lib/idd-ui/slot-wait.ts";
import type { SourceRef } from "../../../../lib/idd-ui/types.ts";

import type {
  DecisionTabView, WorkAcceptanceView, WorkDecisionsView, WorkDoneView, WorkFindingView, WorkFindingsView,
  WorkLaneView, WorkRepoView, WorkRecordView, WorkVerificationEntryView, WorkView, WorkWaitRef,
} from "../../../../lib/idd-ui/work-types.ts";

/** at most this many closed lanes are read for their DEC count (the plan's 目安 20) */
const DONE_LIMIT = 20;

function sourceOf(rec: BacklogRecord): SourceRef | undefined {
  if (rec.linear_issue_url) {
    const id = rec.linear_issue_url.split("/").filter(Boolean).pop() ?? "linear";
    return { kind: "linear", label: id.toUpperCase(), url: rec.linear_issue_url };
  }
  if (rec.gh_issue_url) {
    const m = rec.gh_issue_url.match(/github\.com\/[^/]+\/([^/]+)\/issues\/(\d+)/);
    return { kind: "github", label: m ? `${m[1]}#${m[2]}` : "github", url: rec.gh_issue_url };
  }
  return undefined;
}

/** the lane's worktree, from its last session: the place its records are read from */
function laneRoot(iddId: string): string | undefined {
  return laneRootOf(iddId);
}

/** the lane's branch, read from a rev when its worktree was retired */
function laneRefOf(rec: BacklogRecord): { repo: string; ref: string } | undefined {
  const executor = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop();
  const planner = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop();
  const worktree = executor?.worktree_path ?? planner?.worktree_path;
  return laneBranchSource(rec.area, worktree, executor?.branch ?? planner?.branch);
}

function repoName(area: string): string {
  const names = readAreas().names ?? {};
  return names[area] ?? area.split("/").pop() ?? area;
}

/** the repo row a review lane belongs to: the setting that names its repo, else the repo's own name */
function reviewRepoKey(repo: string): string {
  const areas = readAreas().areas;
  for (const [key, cfg] of Object.entries(areas)) if ((cfg.linked_repo ?? key) === repo) return key;
  return repo;
}

/** the last event that says what the lane waits on, notes left out */
function lastStageEvent(evs: LifecycleRecord[]): string | undefined {
  const clean = withoutNotes(evs);
  return clean[clean.length - 1]?.event;
}

/** the refs a `blocked_by_dependency` record names */
function dependsOn(evs: LifecycleRecord[]): string[] {
  const e = [...evs].reverse().find((x) => x.event === "blocked_by_dependency");
  const dep = e?.attrs?.depends_on;
  return Array.isArray(dep) ? dep.map(String).filter(Boolean) : [];
}

/** a dependency ref as a row reads it: the lane it names when one exists, else the tracker's own words */
function waitRefFor(dep: string, backlog: BacklogRecord[]): WorkWaitRef {
  const lane = backlog.find((r) => r.idd_id === dep || sourceOf(r)?.label === dep || sourceOf(r)?.label?.endsWith(dep));
  return lane ? { ref: sourceOf(lane) ?? { kind: "lane", label: dep }, lane: lane.idd_id, title: lane.title } : { ref: { kind: "lane", label: dep } };
}

function waitRefOfBlocker(b: { ref: string; title: string; url: string; scope: string; outOfScope: boolean }, backlog: BacklogRecord[]): WorkWaitRef {
  const kind: SourceRef["kind"] = b.ref.startsWith("#") ? "github" : "linear";
  const lane = backlog.find((r) => sourceOf(r)?.label === b.ref);
  return { ref: { kind, label: b.ref, url: b.url }, ...(lane ? { lane: lane.idd_id } : {}), title: b.title };
}

/** how long the lane has waited at its current stage: the same reader the lane list and the deck use */
function laneSince(evs: LifecycleRecord[], fallback: string): string {
  return evs[0]?.at ?? fallback;
}

/**
 * The Work screen's one read: the lane column split into what runs and what the engine wakes next, the closed lanes
 * newest first, and the dependency waits. The bundles are decided here, in one place (DEC-103-1): a closed lane is
 * done, a lane whose planner never woke and a lane waiting on a declared dependency are next, and every other lane
 * runs. A cap wait stays a running lane with a note. No cost is read and nothing is written.
 */
export function buildWork(opts: { liveSessions?: Set<string>; now?: Date } = {}, injected?: DerivedDeps): WorkView {
  const derived = injected ?? REAL_DERIVED;
  const backlog = readBacklog();
  const events = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const live = opts.liveSessions ?? new Set<string>();
  const planners = new Set(readSessions("planner").map((r) => r.idd_id));
  const executors = new Set(readSessions("executor").map((r) => r.idd_id));
  const holds = readIntakeHolds().holds;
  const prepOrder = new Map(lanesAwaitingPrep().map((r, i) => [r.idd_id, i]));
  let waits: ReturnType<typeof slotWaits> = [];
  try { waits = slotWaits({ backlog, events }); } catch (err) { console.warn(`[idd work] 上限待ちを数えられませんでした: ${String(err).slice(0, 400)}`); }

  const rows: { row: WorkLaneView; created: string; rank: number }[] = [];
  const doneRows: { view: WorkDoneView; count?: () => number }[] = [];

  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    const closes = new Set(["lane_close", "s1_defer", "s3_defer", "lane_abort", "lane_drop"]);
    const closing = d.group === "closed" ? [...evs].reverse().find((e) => closes.has(e.event)) : undefined;
    if (closing || d.group === "closed") {
      doneRows.push({
        view: {
          id: rec.idd_id,
          repo: rec.area,
          ref: sourceOf(rec),
          title: rec.title,
          closedAt: closing?.at,
          outcome: String(closing?.attrs?.outcome ?? (closing?.event === "lane_close" ? "closed" : closing?.event ?? "closed")),
          decisions: 0,
        },
        // the count is read only if this row survives the screen's cut, so the read does not happen here
        count: () => doneDecisions(rec, derived),
      });
      continue;
    }
    const depWait = lastStageEvent(evs) === "blocked_by_dependency";
    const woke = planners.has(rec.idd_id) || executors.has(rec.idd_id);
    const bundle = !woke || depWait || d.decision === "requeue" ? "next" : "running";
    const slot = laneSlotWait(waits, rec.idd_id);
    const note = depWait ? undefined : (slot ? `${slot.label}の上限待ち（${slot.minutes} 分）` : d.blockedBy);
    // a question the lane is waiting on is penne's, whatever stage it came from: the row carries the same mark
    const turn: DecisionKind | undefined = d.decision ?? (awaitingQuestion(evs) ? "question" : undefined);
    rows.push({
      created: laneSince(evs, rec.created_at),
      rank: prepOrder.get(rec.idd_id) ?? Number.MAX_SAFE_INTEGER,
      row: {
        kind: "issue",
        id: rec.idd_id,
        repo: rec.area,
        ref: sourceOf(rec),
        title: rec.title,
        bundle,
        ...(turn && turn !== "duplicate" ? { turn } : {}),
        ...(d.group === "prep" || d.group === "impl" ? { activity: laneActivity(rec.idd_id, d.group, live) } : {}),
        ...(note ? { note } : {}),
        spans: laneStageSpans(evs),
        waitsFor: depWait ? dependsOn(evs).map((dep) => waitRefFor(dep, backlog)) : [],
      },
    });
  }

  // the review lanes (someone else's PR): running work like any other, its own record shape
  for (const rev of listReviewLanes()) {
    const st = reviewLaneState(rev);
    const group = st.state === "closed" ? "closed" : st.state === "stuck" ? "judge" : st.state === "awaiting_penne" ? "judge" : "impl";
    const repoKey = reviewRepoKey(rev.repo);
    const title = `PR レビュー: ${String(rev.history.find((e) => e.event === "r_wt_ready")?.attrs?.title ?? rev.title)}`;
    const ref: SourceRef = { kind: "pr", label: `${rev.repo.split("/").pop()}#${rev.pr}`, url: rev.url };
    if (group === "closed") {
      doneRows.push({ view: { id: rev.id, repo: repoKey, ref, title, closedAt: rev.history[rev.history.length - 1]?.at, outcome: String(rev.history[rev.history.length - 1]?.attrs?.reason ?? "closed"), decisions: 0 } });
      continue;
    }
    const turn: DecisionKind | undefined = st.state === "awaiting_penne" ? "review" : st.state === "stuck" ? "stuck" : undefined;
    rows.push({
      created: rev.created_at,
      rank: Number.MAX_SAFE_INTEGER,
      row: {
        kind: "review",
        id: rev.id,
        repo: repoKey,
        ref,
        title,
        bundle: group === "impl" ? "running" : "next",
        ...(turn ? { turn } : {}),
        activity: "live",
        note: st.state === "stuck" ? `要判断: ${st.reason}` : st.state === "awaiting_penne" ? "投稿カードの確認待ち" : undefined,
        spans: reviewLaneStageSpans(rev),
        waitsFor: [],
      },
    });
  }

  // the Issues held for a declared dependency, with or without a lane of their own: a next row each (DEC-1769)
  const holdRows: WorkLaneView[] = holds.map((h) => ({
    kind: "hold",
    id: `hold:${h.source}:${h.ref}`,
    repo: h.area,
    ref: { kind: h.source === "github" ? "github" : "linear", label: h.ref, url: h.url },
    title: h.title,
    bundle: "next",
    note: h.reason,
    spans: [],
    waitsFor: h.blockers.map((b) => waitRefOfBlocker(b, backlog)),
  }));

  const running = rows.filter((r) => r.row.bundle === "running").sort((a, b) => a.created.localeCompare(b.created));
  const next = rows.filter((r) => r.row.bundle === "next").sort((a, b) => a.rank - b.rank || a.created.localeCompare(b.created));
  const lanes = [...running, ...next].map((r) => r.row).concat(holdRows);

  const repos = repoRows(lanes, readAreas().areas);
  return { now: (opts.now ?? new Date()).toISOString(), repos, lanes, done: selectDone(doneRows), holds };
}

/**
 * The closed lanes the screen shows: the newest `DONE_LIMIT` of them. An Issue lane's DEC count is read here, after
 * the cut, so a poll's reads do not grow with the number of closed lanes. A review lane keeps no DECs and brings no
 * reader of its own.
 */
export function selectDone(rows: { view: WorkDoneView; count?: () => number }[]): WorkDoneView[] {
  return [...rows]
    .sort((a, b) => (b.view.closedAt ?? "").localeCompare(a.view.closedAt ?? ""))
    .slice(0, DONE_LIMIT)
    .map((r) => (r.count ? { ...r.view, decisions: r.count() } : r.view));
}

/** the DECs a lane made: its own document's decisions, read from the worktree or its branch */
function doneDecisions(rec: BacklogRecord, derived: DerivedDeps): number {
  const root = laneRoot(rec.idd_id);
  const branch = derived.laneRef(rec);
  try {
    const intent = derived.intent(rec, { ...(root ? { root } : {}), ...(branch ? { branch } : {}) });
    return intent.decisions.length;
  } catch {
    return 0;
  }
}

/** one row per repos.yaml entry, with the lanes it carries; a repo with no lane still appears */
function repoRows(lanes: WorkLaneView[], areas: Record<string, unknown>): WorkRepoView[] {
  const out = new Map<string, WorkRepoView>();
  for (const key of Object.keys(areas)) out.set(key, { id: key, name: repoName(key), running: 0, waiting: 0, attention: false });
  for (const lane of lanes) {
    const p = out.get(lane.repo) ?? { id: lane.repo, name: repoName(lane.repo), running: 0, waiting: 0, attention: false };
    if (lane.bundle === "running") p.running += 1;
    if (lane.turn) { p.waiting += 1; p.attention = true; }
    out.set(lane.repo, p);
  }
  return [...out.values()];
}

/** whether the lane's records name an existing DEC's place: the paths its change touched, else the plan's report */
function lanePaths(rec: BacklogRecord, evs: LifecycleRecord[]): string[] {
  const root = laneRoot(rec.idd_id);
  const tree = root ? resolveWorktree(root) : null;
  const branch = laneRefOf(rec);
  const baseMissing = laneBaseMissing(rec.idd_id);
  const forkPoint = baseMissing ? null : tree ? laneForkPoint(rec.idd_id, tree) : branch ? laneForkPoint(rec.idd_id, branch.repo, branch.ref) : null;
  const from = forkPoint ?? (reviewBaseOf(evs) || undefined);
  const files = root && !baseMissing ? changedFiles(root, from, branch) : [];
  if (files.length) return files.map((f) => f.path);
  return readyIntentImpactOf(evs)?.paths ?? [];
}

function toTab(fields: ReturnType<typeof parseDecisionFields>[number]): DecisionTabView {
  return {
    id: fields.id,
    title: fields.title,
    place: fields.place,
    why: fields.why,
    whyNot: fields.whyNot,
    anchored: fields.anchored,
    free: fields.free,
    hasPlace: fields.hasPlace,
  };
}

/**
 * The DECs of one lane: the ones its own document made, and the ones already in the repo whose Anchors hold a path
 * the lane changed (not narrowed, DEC-2801). The lane id is resolved against the ledger first: an id no lane has
 * is refused before any file is read, so a request value never becomes a path. A review lane keeps no DECs, so it
 * has none here.
 */
export function buildWorkDecisions(iddId: string): WorkDecisionsView | null {
  const backlog = readBacklog();
  const rec = backlog.find((r) => r.idd_id === iddId);
  if (!rec || iddId.startsWith("REV-")) return null;
  const evs = readLifecycle().filter((e) => e.idd_id === iddId);
  const root = laneRoot(iddId);
  const branch = laneRefOf(rec);
  const paths = lanePaths(rec, evs);

  // a v2 lane keeps its Choices in the state: `own` is what it raised, `existing` the others the paths pull
  if (laneRecordShape(iddId, evs) === "state") {
    const intent = laneIntent(rec, { events: evs });
    const own = intent.decisions.map((c) => ({
      id: c.id,
      title: c.text,
      place: (c.place ?? []).filter((p) => p.kind !== "root").map((p) => `${p.kind} ${p.path}${p.file ? `（file ${p.file}）` : ""}`).join(", "),
      why: c.why,
      whyNot: (c.forms?.rejected ?? []).map((r) => ({ form: r.form, reason: r.fails_because })),
      anchored: c.anchored ? [{ id: "", text: c.anchored }] : [],
      free: c.free ?? "",
      hasPlace: (c.place ?? []).some((p) => p.kind !== "root"),
    }));
    const ownIds = new Set(intent.decisions.map((d) => d.id));
    const existing = lookupChoices({ repo: rec.area, actor: { lane: iddId }, paths })
      .filter((c) => !ownIds.has(c.id))
      .map((c) => ({
        id: c.id,
        title: c.forms?.chosen ?? "",
        place: c.matched.filter((m) => m.kind !== "root").map((m) => `${m.kind} ${m.path}`).join(", "),
        why: c.why,
        whyNot: (c.forms?.rejected ?? []).map((r) => ({ form: r.form, reason: r.fails_because })),
        anchored: c.anchored ? [{ id: "", text: c.anchored }] : [],
        free: c.free ?? "",
        hasPlace: c.place.some((p) => p.kind !== "root"),
      }));
    return { lane: iddId, own, existing, dropped: 0, paths };
  }

  const sources = [...(root ? [{ root }] : []), ...(branch ? [branch] : [])];
  const seg = areaSegment(rec.area);
  const doc = `_docs/intent/${seg}/${slugOf(rec)}/decision.md`;
  // a closed lane's document may have moved to the archive at the same relative path (DEC-120-11)
  const archivedDoc = doc.replace(/^_docs\/intent\//, "_docs/archives/intent/");

  const docs = sources.flatMap((s) => [...readDecisionDocs(s), ...readArchivedDecisionDocs(s)]);
  const ownText = docs.find((d) => d.doc === doc)?.text ?? docs.find((d) => d.doc === archivedDoc)?.text ?? null;
  const own = ownText ? parseDecisionFields(ownText).map(toTab) : [];

  const source = root ? { root } : branch ?? { root: process.cwd() };
  // the lane's own DECs are neither `existing` (they are `own`) nor doubled when the document moved
  const index = decisionIndex({ source, ...(root ? { root } : {}), paths, excludeDocs: [doc, archivedDoc] });
  const byId = new Map<string, DecisionTabView>();
  for (const { text } of docs) for (const f of parseDecisionFields(text)) if (!byId.has(f.id)) byId.set(f.id, toTab(f));
  const existing = index.candidates.map((c) => byId.get(c.id) ?? { id: c.id, title: c.title, place: "", why: c.why, whyNot: [], anchored: [], free: "", hasPlace: false });

  return { lane: iddId, own, existing, dropped: index.dropped, paths };
}

/** the paths a lane's plan said it would touch, from its ready; empty when it reported none */
function plannedPaths(evs: LifecycleRecord[]): string[] {
  return readyIntentImpactOf(evs)?.paths ?? [];
}

/**
 * One lane's record: the qa.md statements with the AC states folded from its reports, the verification log built
 * from its lifecycle, the findings it placed and the findings handed to its planner with its own dispositions.
 * Nothing is written. Null for an id no ledger lane has, or one that is not a lane id at all.
 */
export function buildWorkRecord(iddId: string): WorkRecordView | null {
  if (!iddId || iddId.includes("..") || iddId.includes("/") || iddId.startsWith("REV-")) return null;
  const rec = readBacklog().find((r) => r.idd_id === iddId);
  if (!rec) return null;
  const events = readLifecycle();
  const laneEvs = events.filter((e) => e.idd_id === iddId);
  const rows = readWorkRows(workColumnPath(rec.area));
  const intent = laneIntent(rec, { root: laneRoot(iddId), events: laneEvs });
  const states = acStatesForLane({ lane: iddId, rows, events: laneEvs });
  const byId = new Map(states.map((s) => [criterionKey(s.id), s]));
  const acceptance: WorkAcceptanceView[] = intent.criteria.map((c) => {
    const s = byId.get(criterionKey(c.id));
    return {
      id: c.id,
      statement: c.text,
      status: s?.status ?? "planned",
      ...(s?.evidence ? { evidence: s.evidence } : {}),
      ...(s?.at ? { at: s.at } : {}),
    };
  });
  const log: WorkVerificationEntryView[] = buildVerificationLog({ lane: iddId, criteria: intent.criteria, events: laneEvs, rows });
  const placed: WorkFindingView[] = findingsOfLane({ rows, events, lane: iddId }).map(toFindingView);
  const delivered: WorkFindingView[] = findingsForPaths({
    rows, events, paths: plannedPaths(laneEvs), viewLane: iddId,
  }).map(toFindingView);
  const disposals = rows
    .filter((r) => r.event === "finding_disposed" && r.lane === iddId)
    .map((r) => ({ id: String(r.id ?? ""), action: String(r.action ?? ""), ...(typeof r.reason === "string" && r.reason ? { reason: r.reason } : {}) }));
  return { lane: iddId, acceptance, log, findings: { placed, delivered, disposals } };
}

function toFindingView(f: {
  id: string; lane: string; round?: number; path: string; lines: [number, number] | null; commit: string; severity: string;
  claim: string; status: "open" | "dropped"; reason?: string; fixLane?: string; disposedBy?: string;
}): WorkFindingView {
  return {
    id: f.id, lane: f.lane, ...(f.round !== undefined ? { round: f.round } : {}), path: f.path, lines: f.lines,
    commit: f.commit, severity: f.severity, claim: f.claim, status: f.status,
    ...(f.reason ? { reason: f.reason } : {}), ...(f.fixLane ? { fixLane: f.fixLane } : {}), ...(f.disposedBy ? { disposedBy: f.disposedBy } : {}),
  };
}

/**
 * The open findings that hold one of the paths of one repo. Refused (null) for a repo the settings do not have,
 * before any file is read. Nothing is written.
 */
export function buildWorkFindings(input: { repo: string; paths: string[]; viewLane?: string }): WorkFindingsView | null {
  if (!input.repo || !(input.repo in readAreas().areas)) return null;
  const rows = readWorkRows(workColumnPath(input.repo));
  const events = readLifecycle();
  const findings = findingsForPaths({ rows, events, paths: input.paths, viewLane: input.viewLane ?? null }).map(toFindingView);
  return { repo: input.repo, paths: input.paths, findings };
}
