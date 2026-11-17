
import {
  acceptedAt, acceptedFindings, stuckOutcomes, s4Triage, fixesNow, checksStopOf, oscillationsOf, questionAnsweredByNote, shouldFixCounts, areaSegment, listReviewLanes, planReviewMustUnconfirmed, returnsToPlan, reviewLaneLabel, reviewLaneState, changedFiles, countUndelivered, deriveStage, elapsedLabel, laneActivity, laneHalt, laneOverBudget, laneStall,
  laneBranchSource, laneCost, laneForkPoint, laneIntent, lifecycleByLane, readBacklog, readLatestCronRun, readLifecycle,
  readOpenQuestions, readPendingReviews, readProgress, readSessions, readAnswerColumns, readySummaryOf, readyRiskTableOf, readyIntentImpactOf, decisionRecords, RISK_LABELS, resolveWorktree, reviewBaseOf, reviewLoopState, reviewRounds, slotWaits, slugOf, prOf,
  acStatesForLane, criteriaStates, readWorkRows, workColumnPath,
  recordedRiskMatch,
  currentBaseAdvance, jstDay, listIgnored, subscriptionTotal, withoutNotes, laneBaseMissing, readAreas, publishes, currentLandApproval, lastLandHold, readIntakeHolds, reviewLoopLabel, orderRankOf,
  storageStatus, laneStartHold, lanesAwaitingPrep, lanesAwaitingExec, laneBlockerWait,
  foldRows, intentColumnPath, laneStates, openProposals, OVERVIEW_PURPOSE_ID, proposedPurposesForLane, readRows, resolveAreaKey,
  GRANULARITY_CHILD_LIMIT, granularityApprovable, granularityProposalOf,
  openDeclarations, overlapsOf, openConflicts, trackerSyncRepos,
} from "@idd/core";
import type { BacklogRecord, CostPart, DailyCost, HeldIssue, LaneGroup, LifecycleRecord, Place, ProposalView, UndeliveredCount } from "@idd/core";
import { batchRunning, landForecastFor, readBatch, readBatchOffers, readBatches, readLandForecast, runningLandRuns } from "@idd/core";
import { ROUTED_BY, shapeRecommendationOf, executorConcurrency, plannerConcurrency, runningExecutors, runningPlanners, stateDir, autoGoDecision, laneDepth, laneDepthFromEvents, decisionSince as decisionSinceOf } from "@idd/core";
import { existsSync } from "node:fs";
import type {
  AnsweredCard, CriterionState, EngineStaleView, GoItem, GuiStaleView, IgnoredIssueView, InboxItem, IntentImpactView, LaneDetailView, LaneRow, LaneSection, ProposalItem, PurposeProposalView, RiskMatchView, RiskTableRow, SourceRef, StateFact, StorageItem, SyncConflictItem, TodayCost,
} from "../../../../lib/idd-ui/types.ts";
import { LANE_SECTION_LABEL } from "../../../../lib/idd-ui/types.ts";
import { blockingWhy, nonBlockingFailures } from "../../../../lib/idd-ui/check-warning.ts";
import { laneSlotWait, sectionSlots } from "../../../../lib/idd-ui/slot-wait.ts";
import { agoLabel, buildTimeline, eventLabel } from "./events-display";
import { engineStaleView, guiStaleView, openConversationsView, reloadWaitLimitMs, reloadWaitSinceValue, waitingRequestsView } from "./staleness";
import { claudeQuotaView, claudeRunsView, conversationView, runIdsOf, shownCost } from "./claude-view";
import { cardTextOf } from "./card-text.ts";
import { withDecisions } from "./card-decision.ts";
import { reviewGroup } from "./review-detail";
import { instructionProposalItems } from "./instruction-cards.ts";
import { laneRootOf, REAL_DERIVED, type DerivedDeps } from "./derived";
import { listOutbound, pendingOutbound, proposedBody, proposedTitle, reviewLabelRegistry, reviewLabelRules } from "@idd/lane";

type PlanReviewView = NonNullable<GoItem["planReview"]>;

/** the last ready's six-kind table as the card reads it (labels for penne); undefined for a ready that came without one */
function riskTableOf(evs: LifecycleRecord[]): RiskTableRow[] | undefined {
  const table = readyRiskTableOf(evs);
  return table?.map((r) => ({ kind: r.kind, label: RISK_LABELS[r.kind], touches: r.touches, reason: r.reason }));
}

/**
 * The last ready's report of the impact on existing intent, as the card reads it: the planner's rows, with each DEC's
 * title read from the records (a DEC of another lane is defined in that lane's document). Undefined for a ready that
 * came without one, so an older lane shows no field rather than an empty "no impact".
 */
function intentImpactOf(evs: LifecycleRecord[], rec: BacklogRecord): IntentImpactView | undefined {
  const report = readyIntentImpactOf(evs);
  if (!report) return undefined;
  const root = laneRoot(rec.idd_id);
  const titles = decisionRecords(root ? { root } : { root: process.cwd() }, report.rows.map((r) => r.id), root);
  // a v2 lane's Choice has no decision.md line: its title is the chosen form, read from the lane's own view of the state
  let seen: ReturnType<typeof foldRows> | undefined;
  const choiceTitle = (id: string): string | undefined => {
    try {
      seen ??= foldRows(readRows(intentColumnPath(rec.area)), rec.idd_id, laneStates(readLifecycle()));
    } catch {
      return undefined;
    }
    return seen.choices.find((c) => c.id === id)?.forms.chosen;
  };
  return {
    count: report.candidate_count,
    paths: report.paths,
    rows: report.rows.map((r) => {
      const title = titles.get(r.id)?.title ?? choiceTitle(r.id);
      return {
        id: r.id,
        ...(title ? { title } : {}),
        effect: r.effect,
        reason: r.reason,
        ...(r.outside_candidates ? { outsideCandidates: true } : {}),
      };
    }),
  };
}

/**
 * The last review round's hit of the repo's declaration, as the card and the lane detail read it: the kinds and
 * paths the lane's own change touched, with the risk the lane declared on that round. Undefined for a lane whose
 * rounds never hit one (the lane's rounds carry no such field either).
 */
function riskMatchOf(evs: LifecycleRecord[]): RiskMatchView | undefined {
  const found = recordedRiskMatch(evs);
  if (!found) return undefined;
  return {
    declared: found.risk,
    hits: found.match.hits.map((h) => ({ kind: h.kind, label: RISK_LABELS[h.kind], paths: h.paths, total: h.total })),
  };
}

function planReviewRuns(attrs: Record<string, unknown>): NonNullable<PlanReviewView["runs"]> {
  const raw = Array.isArray(attrs.runs) ? (attrs.runs as Record<string, unknown>[]) : [];
  return raw.map((r, i) => ({
    role: String(r.role || r.model || `run-${i + 1}`),
    ...(typeof r.model === "string" ? { model: r.model } : {}),
    failed: Boolean(r.failed),
    ...(r.failed && r.error ? { error: String(r.error).slice(0, 200) } : {}),
  }));
}

type PlanReviewRound = NonNullable<NonNullable<GoItem["planReview"]>["rounds"]>[number];

/** one recorded review as a round: what it counted and the must / should it left (a nit is a count only) */
function planReviewRound(e: LifecycleRecord): PlanReviewRound {
  const a = e.attrs ?? {};
  if (e.event === "s1_plan_review_skipped") return { state: "skipped", must: 0, should: 0, nit: 0, findings: [], note: String(a.reason ?? "") };
  if (a.failed) return { state: "failed", must: 0, should: 0, nit: 0, findings: [], note: String(a.error ?? "").slice(0, 200) };
  const findings = Array.isArray(a.findings) ? (a.findings as PlanReviewRound["findings"]) : [];
  return {
    state: "reviewed",
    must: Number(a.must ?? 0),
    should: Number(a.should ?? 0),
    nit: Number(a.nit ?? 0),
    findings: findings.filter((f) => f.severity !== "nit"),
  };
}

/** the reviews and the send-backs of the whole lane in the order they were recorded; sentBack only where a finished review recorded it */
function planReviewHistory(evs: LifecycleRecord[]): NonNullable<PlanReviewView["history"]> {
  return evs.flatMap((e): NonNullable<PlanReviewView["history"]> => {
    if (e.event === "s1_revise_requested") return [{ kind: "revise" }];
    if (e.event !== "s1_plan_review_done" && e.event !== "s1_plan_review_skipped") return [];
    const round = planReviewRound(e);
    const sentBack = round.state === "reviewed" && typeof e.attrs?.sent_back === "boolean" ? { sentBack: e.attrs.sent_back } : {};
    return [{ kind: "round", state: round.state, must: round.must, should: round.should, ...sentBack }];
  });
}

function planReviewSummary(evs: LifecycleRecord[]): GoItem["planReview"] {
  const last = [...evs].reverse().find((e) => e.event === "s1_plan_review_done" || e.event === "s1_plan_review_skipped");
  if (!last) return undefined;
  // the rounds the lane's count holds: since it began, or since penne last sent the plan back
  const sentBack = evs.reduce((at, e, i) => (e.event === "s1_revise_requested" || returnsToPlan(e) ? i : at), -1);
  const rounds = evs
    .slice(sentBack + 1)
    .filter((e) => e.event === "s1_plan_review_done" || e.event === "s1_plan_review_skipped")
    .map(planReviewRound);
  // a must an earlier round raised stays unconfirmed when the last review did not answer: the GO then needs its reason
  const needsReason = planReviewMustUnconfirmed(evs) ? { needsReason: true as const } : {};
  const history = planReviewHistory(evs);
  if (last.event === "s1_plan_review_skipped") {
    return { state: "skipped", must: 0, should: 0, nit: 0, findings: [], note: String(last.attrs?.reason ?? ""), rounds, history, ...needsReason };
  }
  const a = last.attrs ?? {};
  const runs = planReviewRuns(a);
  if (a.failed) return { state: "failed", must: 0, should: 0, nit: 0, findings: [], runs, note: String(a.error ?? "").slice(0, 200), rounds, history, ...needsReason };
  // a GO card only exists once derive says "reviewed": findings still raised there are what the rounds left unfixed
  const findings = Array.isArray(a.findings) ? (a.findings as PlanReviewView["findings"]) : [];
  return {
    state: "reviewed",
    must: Number(a.must ?? 0),
    should: Number(a.should ?? 0),
    nit: Number(a.nit ?? 0),
    findings,
    runs,
    rounds,
    history,
    ...needsReason,
  };
}

/** someone else's PR under review: listed with the Issue lanes, the gate itself is the outbound card */
function reviewRows(): LaneRow[] {
  return listReviewLanes().map((r) => {
    const st = reviewLaneState(r);
    const group: LaneGroup = reviewGroup(st);
    const lastAt = r.history[r.history.length - 1]?.at ?? r.created_at;
    return {
      iddId: r.id,
      title: `PR レビュー: ${String(r.history.find((e) => e.event === "r_wt_ready")?.attrs?.title ?? r.title)}`,
      group,
      stageDone: 0,
      stageCurrent: null,
      elapsed: elapsedLabel(lastAt),
      source: { kind: "pr", label: `${r.repo.split("/").pop()}#${r.pr}`, url: r.url },
      blockedBy: st.state === "stuck" ? `要判断: ${st.reason}` : reviewLaneLabel(st),
      faded: group === "closed",
      activity: group === "impl" ? "live" : "unstarted",
      reviewRounds: [],
    } as LaneRow;
  });
}

/**
 * The open lanes waiting, before their first review, for this lane to land: the ship card tells penne whose
 * approval would release them. Read from the wait records alone; nothing is written here.
 */
function lanesWaitingOn(iddId: string, backlog: BacklogRecord[], byLane: Map<string, LifecycleRecord[]>): { lane: string; files: string[]; rank: number }[] {
  const out: { lane: string; files: string[]; rank: number }[] = [];
  for (const rec of backlog) {
    if (rec.idd_id === iddId) continue;
    const s = reviewLoopState(byLane.get(rec.idd_id) ?? []);
    if (s.state !== "awaiting_order") continue;
    const opp = s.opponents.find((o) => o.lane === iddId);
    if (opp) out.push({ lane: rec.idd_id, files: opp.files, rank: orderRankOf(rec.idd_id, byLane) });
  }
  return out;
}

/** how long an ended batch's card stays for reading what the harness converted after the signature */
const SETTLED_BATCH_MS = 24 * 60 * 60 * 1000;

/**
 * The batch cards (C-247-1): one for each work clone's mainline that two or more lanes wait on, built from the same
 * readings the signature is over, as the tick last took them (`readBatchOffers`: the state does no git reads of its own), and one for a signed batch still under way, which offers no signature
 * and says where it is. The last signed batch's outcome rides on the card while lanes it left out still wait there; when
 * none wait, the outcome stays on a card of its own for a day when the harness converted something or left a lane out,
 * so the diff and the grounds of a resolution can be read after the landing (C-247-6). A card's `appearedAt` is when
 * the lanes it now offers last changed (the latest of them to come to the confirmation, or the batch before it ending),
 * so a snooze belongs to the batch it was made on and a later batch comes to the front on its own.
 */
function landBatchItems(now: number = Date.now()): InboxItem[] {
  const items: InboxItem[] = [];
  const byLane = lifecycleByLane(readLifecycle());
  const outcomeOf = (b: ReturnType<typeof readBatch>): Extract<InboxItem, { kind: "land-batch" }>["last"] => {
    // a batch still under way tells what it has left out and converted so far; the card reads the reasons while it goes
    if (!b || (!b.dropped.length && !b.conversions.length && !b.rebuildFailures?.length && b.phase !== "stopped")) return undefined;
    return {
      landed: b.landed?.lanes ?? [],
      dropped: b.dropped.map((d) => ({ iddId: d.iddId, kind: d.kind, reason: d.reason })),
      conversions: b.conversions.map((c) => ({ iddId: c.iddId, kind: c.kind, files: c.files, rationale: c.rationale })),
      ...(b.rebuildFailures?.length ? { rebuildFailures: b.rebuildFailures.map((f) => ({ iddId: f.iddId, cause: f.cause, reason: f.reason, paths: f.paths })) } : {}),
      ...(b.phase === "stopped" && b.reason ? { reason: b.reason } : {}),
    };
  };
  const endedAt = (b: ReturnType<typeof readBatch>): string | undefined => (b && !batchRunning(b) ? b.landed?.at ?? b.approvedAt : undefined);
  // the card's head (which mainline of which clone) is the same for an offer, a batch under way and one that ended
  const headOf = (id: string, from: { repo: string; repoName?: string; workBase: string }) => ({ kind: "land-batch" as const, iddId: id, repo: from.repo, repoName: from.repoName ?? "", workBase: from.workBase });
  const closeOf = (l: { close?: { repo: string; issue: number; comment: string } }) => (l.close ? { close: { repo: l.close.repo, issue: l.close.issue, comment: l.close.comment } } : {});
  const settledCard = (b: NonNullable<ReturnType<typeof readBatch>>, last: NonNullable<ReturnType<typeof outcomeOf>>, at: string): InboxItem => ({
    ...headOf(b.id, b),
    // a batch that stopped before the mainline moved landed nothing: its card says it stopped, not that lanes were taken in
    title: b.landed && b.phase !== "stopped" ? `${b.workBase} へまとめて取り込んだ（${b.landed.lanes.length} 本）` : `${b.workBase} へのまとめた取り込みを止めた`,
    appearedAt: at,
    lanes: [],
    last,
    settled: true,
  });
  const seen = new Set<string>();
  for (const group of readBatchOffers()) {
    seen.add(group.id);
    const running = readBatch(group.id);
    const active = batchRunning(running) ? running : null;
    if (group.lanes.length < 2 && !active) {
      // fewer than two lanes wait again: no signature to offer, but what the last batch left out is still to be read
      const last = outcomeOf(running);
      const at = endedAt(running);
      if (running && last && at && now - Date.parse(at) <= SETTLED_BATCH_MS) items.push(settledCard(running, last, at));
      continue;
    }
    const forecast = readLandForecast(group.repo);
    const tip = group.mainTip;
    const last = outcomeOf(running);
    const appearedAt = [...group.lanes.map((l) => decisionSince(byLane.get(l.iddId) ?? [])), last ? endedAt(running) : undefined]
      .filter((t): t is string => Boolean(t)).sort().pop();
    items.push({
      ...headOf(group.id, group),
      title: `${group.workBase} へまとめて取り込む（${group.lanes.length} 本）`,
      ...(appearedAt ? { appearedAt } : {}),
      lanes: group.lanes.map((l) => {
        const conflictForecast = forecast && tip ? landForecastFor(forecast, l.iddId, l.head, tip) : undefined;
        return {
          iddId: l.iddId, title: l.title, head: l.head, branch: l.branch,
          ...(l.source ? { source: { kind: l.source.includes("linear") ? "linear" as const : "github" as const, label: l.source.split("/").filter(Boolean).slice(-2).join("#"), url: l.source } } : {}),
          ...closeOf(l),
          ...(conflictForecast ? { conflictForecast } : {}),
        };
      }),
      ...(active ? { running: { phase: active.phase, lanes: active.lanes, checking: runningLandRuns().some((r) => r.lane === active.id), ...(active.reason ? { reason: active.reason } : {}) } } : {}),
      ...(last ? { last } : {}),
    });
  }
  // a batch with no lane waiting on its mainline: one still under way (every lane of it is past the confirmation), or one that ended
  for (const b of readBatches()) {
    if (seen.has(b.id)) continue;
    const last = outcomeOf(b);
    if (batchRunning(b)) {
      items.push({
        ...headOf(b.id, b),
        title: `${b.workBase} へまとめて取り込み中（${b.lanes.length} 本）`,
        appearedAt: b.approvedAt,
        lanes: b.approved.filter((l) => b.lanes.includes(l.iddId)).map((l) => ({ iddId: l.iddId, title: l.title, head: l.head, branch: l.branch, ...closeOf(l) })),
        running: { phase: b.phase, lanes: b.lanes, checking: runningLandRuns().some((r) => r.lane === b.id), ...(b.reason ? { reason: b.reason } : {}) },
        ...(last ? { last } : {}),
      });
      continue;
    }
    const at = endedAt(b);
    if (!last || !at || now - Date.parse(at) > SETTLED_BATCH_MS) continue;
    items.push(settledCard(b, last, at));
  }
  return items;
}

function outboundItems(): InboxItem[] {
  // the card shows what the post will do to the PR's labels; the registry is read once per inbox, and an unreadable one shows none (the post refuses then)
  let registry: ReturnType<typeof reviewLabelRegistry> | null | undefined;
  const labelRulesOf = (repo: string): ReturnType<typeof reviewLabelRules> => {
    if (registry === undefined) {
      try { registry = reviewLabelRegistry(); } catch { registry = null; }
    }
    return registry ? reviewLabelRules(repo, registry) : {};
  };
  return pendingOutbound().map((r) => ({
    kind: "outbound" as const,
    iddId: r.id,
    outKind: r.kind,
    targetLabel: r.kind === "gh-issue-close"
      ? `GitHub Issue を閉じる · ${r.target.repo}#${r.target.issue}`
      : r.kind === "gh-issue"
      ? `GitHub Issue · ${r.target.repo}${r.target.labels?.length ? ` · ラベル ${r.target.labels.join(", ")}` : ""}`
      : r.kind === "gh-pr-review"
        ? `PR レビュー · ${r.target.repo}#${r.target.pr} · head ${String(r.target.expectHead ?? "").slice(0, 9)}`
        : r.kind === "gh-pr-replies"
          ? `PR の指摘への返信 · ${r.target.repo}#${r.target.pr} · head ${String(r.target.expectHead ?? "").slice(0, 9)}`
        : r.kind === "gh-pr-body"
          ? `PR の本文の更新 · ${r.target.repo}#${r.target.pr}`
        : `GitHub リポジトリを作成 · ${r.target.visibility === "public" ? "public" : "private"}`,
    ...(r.kind === "gh-pr-body" ? { baseTitle: r.target.baseTitle ?? "", baseBody: r.target.baseBody ?? "" } : {}),
    ...(r.kind === "gh-pr-review" && r.target.event ? { event: r.target.event } : {}),
    ...(r.kind === "gh-pr-review" ? { labelRules: labelRulesOf(String(r.target.repo ?? "")) } : {}),
    ...(r.kind === "gh-pr-replies" ? {
      replies: (r.parts ?? []).map((p) => {
        const final = r.final?.parts?.find((f) => f.ref === p.ref);
        return { ref: p.ref, label: p.label, quote: p.quote, ...(p.url ? { url: p.url } : {}), thread: Boolean(p.thread_id), draft: p.draft, proposed: final?.body ?? p.rewritten ?? p.draft, resolve: final ? final.resolve : p.resolve, posted: Boolean(p.posted_url) };
      }),
    } : {}),
    title: r.final?.title ?? proposedTitle(r),
    draft: r.draft,
    proposed: r.final?.body ?? proposedBody(r),
    ...(r.rewrite && !r.rewrite.error ? { rewrittenBy: r.rewrite.model } : {}),
    ...(r.rewrite?.error ? { rewriteError: r.rewrite.error } : {}),
    ...(r.error ? { lastError: r.error } : r.status === "posting" ? { lastError: "前回の投稿が途中で止まりました。投稿先に二重に出ていないか確かめてから投稿してください" } : {}),
    ...(r.source ? { handoffNote: r.source } : {}),
    createdAt: r.created_at,
  }));
}

function laneRoot(iddId: string): string | undefined {
  return laneRootOf(iddId);
}

/** a cost breakdown from lifecycle attrs, which are untyped: only the well-formed entries */
function costParts(raw: unknown): { label: string; cost: number }[] {
  return (Array.isArray(raw) ? raw : []).flatMap((p) => (p && typeof p.label === "string" && typeof p.cost === "number" ? [{ label: p.label, cost: p.cost }] : []));
}

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


export interface ShouldFixLaneRow { lane: string; accepted: number; fix: number; fixWithoutBasis: number; /** the time of the lane's last counted judgement (blind / final / confirm / device) */ at: string }

export interface ShouldFixView {
  /** the lanes whose judgements carry a counted should, latest judgement first, at most 20 */
  lanes: ShouldFixLaneRow[];
  /** the sums over those lanes, and the ratio of the recommended fixes to the accepted shoulds (absent when none) */
  total: { accepted: number; fix: number; fixWithoutBasis: number; ratio?: number };
}

export interface IddState {
  source: "state" | "empty";
  stateDir: string;
  /** whether the running engine matches the checkout it started from */
  engine: EngineStaleView;
  /** whether the build the screen runs was made from the head's code */
  gui: GuiStaleView;
  cron: { startedAt: string; finishedAt: string; failures: { iddId: string; reason: string }[] } | null;
  sections: LaneSection[];
  lanes: LaneRow[];
  items: InboxItem[];
  undelivered: UndeliveredCount;
  /** the answers' / questions' columns that cannot be read now, by name (empty when both can): the lanes in the question stage show no card meanwhile, and this says why */
  unreadableColumns: string[];
  /** the accepted shoulds and the fixes the judgements recommended, per lane and in total (DEC-10081/10082) */
  shouldFix: ShouldFixView;
  /** the Issues intake leaves out (shown under the lanes; no lane reads it) */
  ignores: IgnoredIssueView[];
  /** the Issues a filtered intake held back for an open tracker dependency (shown under the lanes; no lane reads it) */
  holds: HeldIssue[];
  /** the cards penne answered today, oldest first */
  answered: AnsweredCard[];
  /** the inbox's today: `done` is the answered cards, `open` the cards still waiting */
  progress: { done: number; open: number };
  /** the day's spend over the lanes, added by `buildStateWithCosts` (the sync `buildState` does not read costs) */
  today?: TodayCost;
}

/**
 * The lifecycle records penne's own operation wrote, and the card kind each answers. The same event name written by the
 * harness without penne's operation is left out where it sits (an automatic `s3_ok`, a land conflict's send-back).
 */
const ANSWER_KIND: Record<string, AnsweredCard["kind"]> = {
  s1_go: "go",
  s1_revise_requested: "go",
  question_batch_answered: "question",
  s1_granularity_answered: "granularity",
  s0_requeue_go: "requeue",
  s2_review_resumed: "stuck",
  s1_replan_requested: "stuck",
  lane_budget_extended: "stuck",
  lane_stall_resumed: "stuck",
  pending_review_resolved: "duplicate",
  s3_ok: "review",
  s3_reject: "review",
  s4_push_approved: "ship",
  s4_land_approved: "ship",
  s4_verify_user_judgment_answered: "ship",
};

/**
 * The cards penne answered on the JST day `now` falls in. Read from the records penne's operation wrote (never from a
 * card that merely left the inbox), plus the posts approved or discarded today. A lane taken out (ignore) or started
 * over (redo) counts as the card the lane stood at just before the close; "later" and "sleep" move a card, so they
 * are not answers.
 */
export function answeredCards(events: LifecycleRecord[], backlog: BacklogRecord[], now: Date = new Date()): AnsweredCard[] {
  const today = jstDay(now);
  if (!today) return [];
  const titles = new Map(backlog.map((b) => [b.idd_id, b.title]));
  const out: AnsweredCard[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (jstDay(e.at) !== today) continue;
    const title = titles.has(e.idd_id) ? { title: titles.get(e.idd_id) } : {};
    const kind = ANSWER_KIND[e.event];
    if (kind) {
      if (e.event === "s3_ok" && e.attrs?.at_by === "auto") continue;
      if (e.event === "s4_verify_user_judgment_answered" && e.attrs?.by === "harness") continue;
      // a batch the mechanism alone answered carries its mark: no person decided it, so it is no answer of the day
      if (e.event === "question_batch_answered" && e.attrs?.answered_by === ROUTED_BY) continue;
      out.push({ kind, iddId: e.idd_id, ...title, at: e.at });
      continue;
    }
    if (e.event === "lane_close" && (e.attrs?.via === "ignore" || e.attrs?.outcome === "redone")) {
      // the card the lane stood at when penne took it out, read from the lane's own records before the close
      const prior = deriveStage(events.slice(0, i).filter((x) => x.idd_id === e.idd_id)).decision;
      if (prior) out.push({ kind: prior, iddId: e.idd_id, ...title, at: e.at });
    }
  }
  // a post penne approved or discarded is an answer too, and lives in the post's own record rather than the lifecycle
  try {
    for (const r of listOutbound()) {
      const at = r.status === "posted" ? r.posted?.at : r.status === "discarded" ? r.updated_at : undefined;
      if (at && jstDay(at) === today) out.push({ kind: "outbound", title: r.title, at });
    }
  } catch (err) {
    console.warn(`[idd state] 投稿の記録を読めませんでした: ${String(err).slice(0, 400)}`);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** the fixed id of the reload card: only one such card exists at a time */
export const RELOAD_CARD_ID = "engine-reload";

/**
 * The card that asks penne to make way for a replacement. Two waits share it and are never up at once (the judgment
 * returns one hold): the open conversations penne can close, and the requests only their handlers can finish. Both
 * take the same fixed id; `appearedAt` is when the limit was passed, so a card put off or put to sleep does not
 * carry over to the next wait. The request wait is measured from the oldest request, because one long-held request
 * is what keeps the restart off (a run of short ones would otherwise count too). It carries no lane: nothing on
 * record is decided by it.
 */
function reloadCards(): InboxItem[] {
  const limit = reloadWaitLimitMs();
  const since = reloadWaitSinceValue();
  if (since !== null) {
    const waited = Date.now() - since;
    const open = openConversationsView();
    if (waited >= limit && open.length > 0) {
      return [{
        kind: "reload",
        iddId: RELOAD_CARD_ID,
        title: "エンジンを入れ替えるために、開いている会話を閉じますか",
        waiting: "conversations",
        open,
        requests: [],
        waitedMs: waited,
        appearedAt: new Date(since + limit).toISOString(),
      }];
    }
  }
  const requests = waitingRequestsView();
  if (requests.length === 0) return [];
  let oldest = requests[0];
  for (const request of requests) if (Date.parse(request.startedAt) < Date.parse(oldest.startedAt)) oldest = request;
  const oldestAt = Date.parse(oldest.startedAt);
  const waited = Date.now() - oldestAt;
  if (waited < limit) return [];
  return [{
    kind: "reload",
    iddId: RELOAD_CARD_ID,
    title: "エンジンの入れ替えが、処理中の要求を待っています",
    waiting: "requests",
    open: [],
    requests,
    waitedMs: waited,
    appearedAt: new Date(oldestAt + limit).toISOString(),
  }];
}

/** the ignore list as the screen shows it; an unreadable list shows as empty */
function ignoresView(): IgnoredIssueView[] {
  try {
    return listIgnored();
  } catch (err) {
    console.warn(`[idd state] 無視リストを読めませんでした: ${String(err).slice(0, 400)}`);
    return [];
  }
}

/** the dependency waits as the screen shows them; an unreadable holds file shows as empty */
function holdsView(): HeldIssue[] {
  const r = readIntakeHolds();
  if (r.error) console.warn(`[idd state] 依存待ちを読めませんでした: ${r.error.slice(0, 400)}`);
  return r.holds;
}

const SHOULD_FIX_KINDS = new Set(["blind", "final", "confirm", "device", "kept"]);

/**
 * The accepted shoulds and the fixes the judgements recommended, per lane and in total: the last 20 lanes whose
 * judgements carry a counted should, latest judgement first (a lane with no such judgement is left out). DEC-10081/10082.
 */
function shouldFixView(byLane: Map<string, LifecycleRecord[]>, backlog: BacklogRecord[]): ShouldFixView {
  const rows: ShouldFixLaneRow[] = [];
  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    let at = "";
    let counted = false;
    for (const e of evs) {
      if (e.event !== "s2_triage_done" || e.attrs?.failed) continue;
      // the PR feedback's judgements are not part of a lane's review loop counts
      if (!SHOULD_FIX_KINDS.has(String(e.attrs?.kind ?? "blind"))) continue;
      counted = true;
      at = e.at;
    }
    if (!counted) continue;
    rows.push({ lane: rec.idd_id, ...shouldFixCounts(evs), at });
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const lanes = rows.slice(0, 20);
  const total = lanes.reduce(
    (acc, r) => ({ accepted: acc.accepted + r.accepted, fix: acc.fix + r.fix, fixWithoutBasis: acc.fixWithoutBasis + r.fixWithoutBasis }),
    { accepted: 0, fix: 0, fixWithoutBasis: 0 },
  );
  return { lanes, total: { ...total, ...(total.accepted > 0 ? { ratio: total.fix / total.accepted } : {}) } };
}

const EMPTY_SHOULD_FIX: ShouldFixView = { lanes: [], total: { accepted: 0, fix: 0, fixWithoutBasis: 0 } };

/** when a lane last moved: its last event that is not a note (a note moves no lane) */
function lastMovedAt(evs: LifecycleRecord[], fallback: string): string {
  const moved = withoutNotes(evs);
  return moved[moved.length - 1]?.at ?? fallback;
}

/**
 * When the lane came to the decision it waits at: the time of the event its last stretch at that decision began
 * with. A later card of the same kind on the lane (a plan made again, a second stop) has a later time. The reading
 * is the one the ledger's `decisionSince` reads, so the card's start and the lane's card cannot differ (C-199-1).
 */
function decisionSince(evs: LifecycleRecord[]): string | undefined {
  return decisionSinceOf(evs);
}

/**
 * The low-space card, when the state's filesystem is below the threshold and the pass's own sweep did not bring it
 * back. It is tied to no lane; its content comes from the settings, the free space, the last judgment (a display
 * hint) and which lanes the start hold keeps. Nothing is saved: the card follows the space.
 */
function storageCardItems(): StorageItem[] {
  const st = storageStatus();
  if (!st.belowThreshold) return [];
  const held: string[] = [];
  for (const rec of [...lanesAwaitingPrep(), ...lanesAwaitingExec()]) {
    if (laneStartHold(rec.area)) held.push(rec.idd_id);
  }
  const judged = st.judgement;
  const topPlaces = (judged?.places ?? [])
    .filter((p) => p.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((p) => ({ label: p.label, bytes: p.bytes }));
  const candidateCount = judged ? judged.candidates.length : st.lastSweep?.removed.length ?? 0;
  const candidateBytes = judged
    ? judged.candidates.reduce((n, c) => n + c.bytes, 0)
    : st.lastSweep?.removed.reduce((n, r) => n + r.bytes, 0) ?? 0;
  return [{
    kind: "storage",
    cleanup: st.cleanup,
    minFreeGb: st.minFreeGb,
    freeBytes: st.freeBytes,
    totalBytes: st.totalBytes,
    topPlaces,
    candidateCount,
    candidateBytes,
    heldLanes: held,
    ...(st.archive ? { archive: st.archive } : {}),
  }];
}

/**
 * One card per open conflict between propter and an outside tracker, across the repos that read one. A card with no
 * answer: it shows the three values and closes by itself at the sync that finds the sides agreeing again. A list that
 * cannot be read leaves the cards out with a warning; the other cards still come back.
 */
function syncConflictCardItems(): SyncConflictItem[] {
  try {
    return openConflicts(trackerSyncRepos()).map((c) => ({
      kind: "sync_conflict" as const,
      repo: c.repo,
      conflictId: c.id,
      unit: c.unit,
      subject: c.subject,
      label: c.label,
      external: c.external,
      base: c.base,
      propter: c.propter,
      appearedAt: c.raisedAt,
    }));
  } catch (err) {
    console.warn(`[idd state] 外とのぶつかりを読めませんでした: ${String(err).slice(0, 200)}`);
    return [];
  }
}

/** the most a proposal card's one-line handle holds; a longer one is cut with an ellipsis */
const PROPOSAL_HANDLE_MAX = 40;

function cutHandle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > PROPOSAL_HANDLE_MAX ? `${t.slice(0, PROPOSAL_HANDLE_MAX - 1)}…` : t;
}

function placeText(place: Place[]): string {
  return place.map((p) => `${p.path}（${p.kind}${p.file ? `, file: ${p.file}` : ""}）`).join(", ");
}

/** one open proposal as the card that carries it: the handle, the current content beside the proposed one, and when it takes effect */
function proposalItem(proposal: ProposalView): ProposalItem {
  // the card reads the current content from the raiser's own side: a lane's records are visible to that lane before they merge
  const folded = foldRows(readRows(intentColumnPath(proposal.repo)), proposal.origin.lane ?? null, laneStates(readLifecycle()));
  const body = proposal.body;
  let handle = "";
  let before: { label: string; value: string }[] = [];
  let after: { label: string; value: string }[] = [];
  if (proposal.kind === "overview") {
    handle = "概要を変える案";
    before = [{ label: "今の概要", value: folded.purposes.find((p) => p.id === OVERVIEW_PURPOSE_ID)?.statement ?? "" }];
    after = [{ label: "案の概要", value: body.statement ?? "" }];
  } else if (proposal.kind === "root_supersede") {
    const olds = (body.ids ?? []).flatMap((id) => {
      const c = folded.choices.find((x) => x.id === id);
      return c ? [{ label: `今の ${id}`, value: c.forms.chosen }] : [];
    });
    before = olds;
    handle = cutHandle(body.choice?.forms.chosen ?? "");
    after = [
      { label: "後継", value: body.choice?.forms.chosen ?? "" },
      { label: "Why", value: body.choice?.why ?? "" },
      { label: "Anchored", value: body.choice?.anchored ?? "" },
      { label: "Place", value: placeText(body.choice?.place ?? []) },
      { label: "Grounds", value: body.grounds ?? "" },
    ];
  } else if (proposal.kind === "root_reanchor") {
    const c = folded.choices.find((x) => x.id === body.id);
    handle = cutHandle(c?.forms.chosen ?? String(body.id ?? ""));
    before = [
      { label: "今の Place", value: placeText(c?.place ?? []) },
      { label: "今の Anchored", value: c?.anchored ?? "" },
    ];
    after = [
      { label: "案の Place", value: placeText(body.place ?? c?.place ?? []) },
      { label: "案の Anchored", value: body.anchored ?? c?.anchored ?? "" },
    ];
  } else {
    handle = cutHandle((body.statement ?? "").split("\n")[0] ?? "");
    after = [
      { label: "害の例", value: body.statement ?? "" },
      { label: "重さ", value: String(body.harm ?? "") },
      { label: "must", value: body.always_must ? "はい" : "いいえ" },
    ];
  }
  const effect = proposal.origin.lane && proposal.kind !== "harm_example" ? "on_merge" : "now";
  return {
    kind: "proposal",
    proposalId: proposal.id,
    proposalKind: proposal.kind,
    repo: proposal.repo,
    ...(proposal.origin.lane ? { iddId: proposal.origin.lane } : {}),
    handle,
    reason: proposal.reason,
    before,
    after,
    from: { ...proposal.origin, at: proposal.at },
    appearedAt: proposal.at,
    effect,
  };
}

/**
 * One card per open proposal, across the registered repos. A repo whose column cannot be read is left out with a
 * warning: the other repos' cards still come back, and a card is never lost to another repo's fault.
 */
function proposalCardItems(): InboxItem[] {
  // the user's instruction proposals belong to no repo, and a repo registry that cannot be read does not hide them
  const out: InboxItem[] = [...instructionProposalItems()];
  let repos: string[];
  try {
    repos = Object.keys(readAreas().areas);
  } catch (err) {
    console.warn(`[idd state] repo の登録を読めませんでした: ${String(err).slice(0, 200)}`);
    return out;
  }
  for (const repo of repos) {
    try {
      for (const proposal of openProposals(repo)) out.push(proposalItem(proposal));
    } catch (err) {
      console.warn(`[idd state] ${repo} の案を読めませんでした: ${String(err).slice(0, 200)}`);
    }
  }
  return out;
}

/** the proposed Purposes of one lane, as the GO card and the lane detail show them */
function purposeProposalsOf(area: string, iddId: string): PurposeProposalView[] {
  const key = resolveAreaKey(area);
  if ("error" in key) return [];
  return proposedPurposesForLane(key.key, iddId).map((p) => ({ id: p.id, statement: p.statement, origin: p.origin, ...(p.name ? { name: p.name } : {}), raisedStatement: p.raised_statement }));
}

/**
 * The notice the stall watch recorded for the card that began at `since`, if any. The browser shows it once, so the
 * card carries the record's time; the question card has no `appearedAt` (its batch id tells it apart), but it is a
 * card penne waits on like any other and gets the notice just the same.
 */
function noticeAtOf(evs: LifecycleRecord[], since: string | undefined): string | undefined {
  return since ? evs.filter((e) => e.event === "lane_wait_notified" && Date.parse(e.at) > Date.parse(since)).pop()?.at : undefined;
}

/** the column the open-questions list last said it could not read, so a column that stays unreadable is said once and not at every request */
let questionsUnreadableSaid: string | null = null;

export function buildState(opts: { liveSessions?: Set<string>; now?: Date } = {}, injected?: DerivedDeps): IddState {
  const derived = injected ?? REAL_DERIVED;
  const dir = stateDir();
  const backlog = readBacklog();
  const machine = { engine: engineStaleView(), gui: guiStaleView() };
  if (!existsSync(dir) || backlog.length === 0) {
    const reviews = reviewRows();
    const items = [...outboundItems(), ...storageCardItems(), ...proposalCardItems(), ...syncConflictCardItems()];
    const answered = answeredCards([], backlog, opts.now ?? new Date());
    const reload = reloadCards();
    const all = withDecisions([...items, ...reload]);
    return { source: reviews.length || reload.length ? "state" : "empty", stateDir: dir, ...machine, cron: null, sections: [], lanes: reviews, items: all, undelivered: { total: 0, failed: 0 }, unreadableColumns: [], shouldFix: EMPTY_SHOULD_FIX, ignores: ignoresView(), holds: holdsView(), answered, progress: { done: answered.length, open: all.length } };
  }

  const events = readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }

  // the columns that cannot be read are said on the state itself and on each lane in the question stage: that lane has
  // questions the list below leaves out, and a screen with neither would read it as a lane that asks nothing
  const answerColumns = readAnswerColumns();
  const unreadableColumns = answerColumns.unreadable;
  const unreadableNote = unreadableColumns.length ? `${unreadableColumns.join("と")}を読めないので、この lane の質問を表示できません（読めるようになると表示されます）` : undefined;

  const live = opts.liveSessions ?? new Set<string>();
  const lanes: LaneRow[] = backlog.map((rec) => {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    const lastAt = lastMovedAt(evs, rec.created_at);
    // a waiting lane's line carries its place among the lanes it collides with; every other lane keeps its own label
    const loop = reviewLoopState(evs);
    const blockedBy = loop.state === "awaiting_order" ? reviewLoopLabel(loop, orderRankOf(rec.idd_id, byLane))
      : d.decision === "question" && unreadableNote ? unreadableNote
      : d.blockedBy;
    return {
      iddId: rec.idd_id,
      title: rec.title,
      group: d.group,
      decision: d.decision,
      stageDone: d.stageDone,
      stageCurrent: d.stageCurrent,
      elapsed: elapsedLabel(lastAt),
      source: sourceOf(rec),
      blockedBy,
      faded: d.group === "closed",
      activity: laneActivity(rec.idd_id, d.group, live),
      reviewRounds: reviewRounds(evs),
    };
  });
  lanes.push(...reviewRows());

  const answeredReviews = new Set(
    events.filter((e) => e.event === "pending_review_resolved").map((e) => String(e.attrs?.review_id ?? "")),
  );
  const reviews = readPendingReviews().filter((r) => !answeredReviews.has(r.review_id));

  const items: InboxItem[] = outboundItems();
  items.push(...reloadCards());

  for (const r of reviews) {
    items.push({
      kind: "duplicate",
      iddId: r.review_id,
      reviewId: r.review_id,
      incoming: {
        title: r.candidate.title,
        ref: r.candidate.linear_issue_url
          ? { kind: "linear", label: (r.candidate.linear_issue_url.split("/").pop() ?? "").toUpperCase(), url: r.candidate.linear_issue_url }
          : { kind: "github", label: "github", url: r.candidate.gh_issue_url },
      },
      existing: {
        title: backlog.find((b) => b.idd_id === r.suspected_duplicate_of[0])?.title ?? r.suspected_duplicate_of[0],
        ref: { kind: "lane", label: r.suspected_duplicate_of[0] },
      },
      similarity: r.detection_method === "url" ? 1 : 0.85,
      reason: r.detection_reason,
    });
  }

  // a column that cannot be read lists no batch as open: read as no answers it would list answered questions, and a
  // press on one is refused as a second answer. The rest of the state is still answered (a GO card and a GO's refusal
  // name the column themselves), and the list is whole again on the first read that finds the columns readable.
  let openQuestions: ReturnType<typeof readOpenQuestions> = [];
  if (unreadableColumns.length) {
    const said = unreadableColumns.join("と");
    if (questionsUnreadableSaid !== said) {
      questionsUnreadableSaid = said;
      console.warn(`[state] ${said}を読めないので、答え待ちの質問の一覧を出しません`);
    }
  } else {
    openQuestions = readOpenQuestions(answerColumns);
    questionsUnreadableSaid = null;
  }
  const answeredIds = new Set(answerColumns.answers.map((a) => `${a.idd_id}/${a.batch_id}/${a.question_id}`));
  for (const b of openQuestions) {
    const rec = backlog.find((x) => x.idd_id === b.idd_id);
    const open = b.questions
      .filter((q) => !answeredIds.has(`${b.idd_id}/${b.batch_id}/${q.question_id}`))
      .map((q) => ({
        questionId: q.question_id,
        question: q.question,
        facts: q.context ? [{ label: "context", value: q.context }] : [],
        options: q.options.map((o) => ({
          index: o.index,
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
          ...(o.recommendation ? { recommendation: o.recommendation } : {}),
          ...(o.rationale ? { rationale: o.rationale } : {}),
        })),
      }));
    if (!open.length) continue;
    const evs = byLane.get(b.idd_id) ?? [];
    const noticeAt = noticeAtOf(evs, deriveStage(evs).decision === "question" ? decisionSince(evs) : undefined);
    items.push({
      kind: "question",
      iddId: b.idd_id,
      laneTitle: rec?.title,
      source: rec ? sourceOf(rec) : undefined,
      batchId: b.batch_id,
      open,
      askedTotal: b.questions.length,
      answeredCount: b.questions.length - open.length,
      ...(noticeAt ? { waitNoticeAt: noticeAt } : {}),
    });
  }



  // the open lanes' declared places, read once from the records the card is built from (no git, no other worktree)
  let declarations: ReturnType<typeof openDeclarations> | undefined;
  for (const rec of backlog) {
    const evs = byLane.get(rec.idd_id) ?? [];
    const d = deriveStage(evs);
    const since = d.decision && d.decision !== "question" ? decisionSince(evs) : undefined;
    // the notice the stall watch recorded for this card, after the decision began: the browser shows it once
    const noticeAt = noticeAtOf(evs, since);
    const appeared = since ? { appearedAt: since, ...(noticeAt ? { waitNoticeAt: noticeAt } : {}) } : {};
    if (d.decision === "go") {
      const intent = derived.intent(rec, { root: laneRoot(rec.idd_id), events: evs });
      const summary = readySummaryOf(evs);
      const riskTable = riskTableOf(evs);
      const intentImpact = intentImpactOf(evs, rec);
      const advance = currentBaseAdvance(evs);
      // the other open lanes that declared a place this lane declared: shown on the card, and no gate reads it
      declarations ??= openDeclarations(backlog, byLane);
      const overlaps = overlapsOf(declarations, rec.idd_id);
      // the depth the plan declared, raised by the lane's own Risk: the same reader the auto GO reads (F-113-2)
      const plannerWorktree = readSessions("planner").filter((s) => s.idd_id === rec.idd_id).pop()?.worktree_path;
      const depth = plannerWorktree ? laneDepth(rec, plannerWorktree) : laneDepthFromEvents(evs);
      // why the engine left this shallow lane to a person: the same conditions auto-go reads (an unreadable one
      // is handed over too, never read as clear)
      let notAuto: string | undefined;
      if (depth === "shallow") {
        try {
          const rows = readRows(intentColumnPath(rec.area));
          const folded = foldRows(rows, rec.idd_id, laneStates(readLifecycle()));
          const decision = autoGoDecision({ lane: rec.idd_id, events: evs, depth, purposes: folded.purposes, choices: folded.choices, rows });
          if (!decision.auto) notAuto = decision.reason;
        } catch {
          notAuto = "条件を読めないので人に回した";
        }
      }
      const purposeProposals = purposeProposalsOf(rec.area, rec.idd_id);
      // a recorded dependency not landed: the write side refuses the GO, so the card shows the wait in place of the
      // button. The tracker is not read here (the tick reads it and keeps the reading); the card reads what is kept
      const blockedBy = laneBlockerWait(rec, { backlog, byLane });
      const goItem: GoItem = {
        kind: "go",
        iddId: rec.idd_id,
        ...appeared,
        title: rec.title,
        depth,
        ...(blockedBy ? { blockedBy: { reason: blockedBy.reason, items: blockedBy.items } } : {}),
        ...(notAuto ? { notAuto } : {}),
        ...(summary ? { summary } : {}),
        ...(riskTable ? { riskTable } : {}),
        ...(intentImpact ? { intentImpact } : {}),
        ...(purposeProposals.length ? { purposeProposals } : {}),
        source: sourceOf(rec),
        decisions: intent.decisions,
        criteria: intent.criteria,
        intentPath: intent.decisions.length || intent.criteria.length
          ? undefined
          : `_docs/intent/${areaSegment(rec.area)}/${slugOf(rec)}/`,
        planPath: `_docs/plan/${areaSegment(rec.area)}/${slugOf(rec)}/plan.md`,
        planReview: planReviewSummary(evs),
        ...(advance ? { baseAdvance: advance } : {}),
        ...(overlaps.length ? { overlaps } : {}),
      };
      // the six fields are read from the record the writer left (or put together from the raw material): no wait here
      const text = cardTextOf(goItem);
      items.push(text ? { ...goItem, text } : goItem);
    }
    if (d.decision === "granularity") {
      const proposal = granularityProposalOf(evs);
      if (proposal && proposal.kind !== "single") {
        items.push({
          kind: "granularity",
          iddId: rec.idd_id,
          ...appeared,
          title: rec.title,
          source: sourceOf(rec),
          proposal: {
            kind: proposal.kind,
            reason: proposal.reason,
            ...(proposal.children ? { children: proposal.children } : {}),
            ...(proposal.mergeTarget ? { mergeTarget: proposal.mergeTarget } : {}),
            approvable: granularityApprovable(proposal),
            limit: GRANULARITY_CHILD_LIMIT,
          },
        });
      }
    }
    if (d.decision === "requeue") {
      const from = String(evs.find((e) => e.event === "lane_open")?.attrs?.requeued_from ?? "");
      const end = [...(byLane.get(from) ?? [])].reverse().find((e) => e.event === "lane_close" || e.event === "s1_defer" || e.event === "s3_defer");
      items.push({
        kind: "requeue",
        iddId: rec.idd_id,
        ...appeared,
        title: rec.title,
        source: sourceOf(rec),
        from,
        ...(end ? { closed: { outcome: String(end.attrs?.outcome ?? (end.event === "lane_close" ? "closed" : "deferred")), ...(end.attrs?.reason ? { reason: String(end.attrs.reason) } : {}), at: end.at } } : {}),
        context: rec.context.slice(0, 600),
      });
    }
    if (d.decision === "stuck") {
      const stall = laneStall(evs);
      const halt = laneHalt(evs);
      const over = laneOverBudget(evs);
      const overAttrs = [...evs].reverse().find((e) => e.event === "lane_over_budget")?.attrs;
      const triage = [...evs].reverse().find((e) => e.event === "s2_triage_done");
      const triageAt = triage ? evs.lastIndexOf(triage) : -1;
      // the same母数 the loop, the stall and the fix read: what the judgement accepted, with penne's corrections in place
      const accepted = triageAt >= 0 ? acceptedAt(evs, triageAt) : [];
      // a stop over the checks before the convergence answers no judgement: what it holds is what the checks found (the
      // failures the lane made, or the checks that could not be compared; nothing for a run that could not run)
      const checksStop = checksStopOf(evs);
      const checkItems = checksStop ? checksStopItems(checksStop) : [];
      // the reversals of the last judgement, until penne has answered them
      const answered = triage ? evs.slice(triageAt + 1).some((e) => e.event === "s2_review_resumed") : true;
      const oscillations = answered ? [] : oscillationsOf(triage?.attrs);
      // an S4 pass takes the accepted items whose action is fix, nits included; the review loop keeps nits back
      const s4 = triageAt >= 0 ? s4Triage(evs, triageAt) : false;
      // what each button does is read from the transition the loop then runs, not guessed apart from it
      const outcomes = stall || over ? undefined : stuckOutcomes(rec, evs);
      // how many items a plain continue sends to the fix as the record stands (penne's corrections already given): the
      // findings and the reversals the fix carries, 0 when the answer leads to no fix. A continue that retries a stage,
      // or a lane with no answer to read, has no count
      const go = outcomes?.continue;
      const continueFixes = go?.to === "fix" ? go.refs.length + go.boundaries : go?.to === "close" || go?.to === "final" || go?.to === "checks" ? 0 : undefined;
      // the judge's recommendation rides on the card of a lane the review loop holds; a stop for the budget, a stall or a halt has none
      const recommendation = stall || over || halt ? undefined : shapeRecommendationOf(evs);
      // penne took the code: the lane waits at its hand turn, with only the "直した" answer
      const handTurn = reviewLoopState(evs).state === "awaiting_hand_fix";
      // the history the card shows: what the last fix did
      const lastFixAt = evs.map((e) => e.event).lastIndexOf("s2_fix_sent");
      const lastResult = lastFixAt >= 0 ? evs.slice(lastFixAt + 1).find((e) => e.event === "s2_result") : undefined;
      const sideFindings = Array.isArray(lastResult?.attrs?.side_findings) ? (lastResult!.attrs!.side_findings as unknown[]).map(String) : [];
      items.push({
        kind: "stuck",
        iddId: rec.idd_id,
        ...appeared,
        title: rec.title,
        source: sourceOf(rec),
        reason: d.blockedBy ?? "",
        ...(handTurn ? { handTurn: true } : {}),
        ...(sideFindings.length ? { history: { sideFindings } } : {}),
        // the same母数 the stall and the fix read: what the judgement sent to this change's fix
        open: checksStop ? checkItems : accepted.filter((a) => (s4 ? fixesNow(a) : a.severity !== "nit" && fixesNow(a))).map((a) => ({ ref: a.ref, severity: a.severity, claim: a.claim, path: a.path })),
        // every finding the judgement accepted, with what each handling does to the fix: the new screen lists and decides these.
        // A stop outside the review loop (a stall, the budget, a halt, the hand turn, the checks) has no judgement to decide
        ...(stall || over || halt || handTurn || checksStop ? {} : { accepted: acceptedFindings(evs) }),
        escalated: Array.isArray(triage?.attrs?.escalated_claims) ? (triage.attrs.escalated_claims as string[]) : [],
        // the note of this stop is recorded as the answer to the judgement's one question, read as the write reads it:
        // the card then names its one line the answer, which reaches later judgements and spec checks
        ...(questionAnsweredByNote(evs).length ? { noteAnswersQuestion: true } : {}),
        oscillations: oscillations.map((o) => ({ ref: o.ref, claim: o.claim, ...(o.path ? { path: o.path } : {}), priorRef: o.prior_ref, prior: o.prior, current: o.current })),
        rejected: Array.isArray(triage?.attrs?.rejected) ? (triage.attrs.rejected as { claim: string; reason?: string }[]) : [],
        fixRounds: evs.filter((e) => e.event === "s2_fix_sent").length,
        ...(continueFixes !== undefined ? { continueFixes } : {}),
        ...(recommendation ? { recommendation } : {}),
        ...(outcomes ? { onContinue: outcomes.continue, onContinueWithNote: outcomes.continueWithNote, onAccept: outcomes.accept, onHandFix: outcomes.handFix, onReplan: outcomes.replan } : {}),
        ...(stall ? { stall: { role: stall.role, reason: stall.reason } } : {}),
        ...(halt ? { halt: { stage: halt.stage, since: halt.since, lastEvent: { name: eventLabel(halt.lastEvent.event), at: halt.lastEvent.at }, reason: halt.reason, causes: halt.causes, canSendBack: halt.canSendBack } } : {}),
        ...(over ? { budget: { ...over, parts: costParts(overAttrs?.parts), subscription: costParts(overAttrs?.subscription_parts) } } : {}),
      });
    }
    if (d.decision === "ship") {
      const submit = derived.submit(rec.idd_id);
      const riskMatch = riskMatchOf(evs);
      if (submit) {
        const waitingLanes = lanesWaitingOn(rec.idd_id, backlog, byLane);
        // the non-blocking checks that failed, with why: the card warns with them near the heading, and they hold
        // neither the signature nor the landing (they are folded from whichever record this card carries)
        const checkWarnings = nonBlockingFailures(submit.land ? submit.land.checks : submit.proposal?.checks);
        // why the card cannot be signed as it stands: the same holds the tick is under
        const blockedReasons = [
          submit.landBlocked,
          submit.recordsOnly?.reason,
          submit.pushHeld,
          submit.proposal && submit.proposal.blocking > 0 ? blockingWhy(submit.proposal.blocking, submit.proposal.checks) : "",
          submit.land && submit.land.blocking > 0 ? blockingWhy(submit.land.blocking, submit.land.checks) : "",
        ].filter((x): x is string => Boolean(x));
        items.push({
          kind: "ship",
          iddId: rec.idd_id,
          ...appeared,
          ...(blockedReasons.length ? { blocked: { reasons: blockedReasons } } : {}),
          ...(checkWarnings.length ? { checkWarnings } : {}),
          title: submit.title,
          ...(riskMatch ? { riskMatch } : {}),
          source: sourceOf(rec),
          branch: submit.branch,
          pr: submit.pr,
          checks: submit.checks,
          ...(submit.commitConvention ? { commitConvention: submit.commitConvention } : {}),
          proposal: submit.proposal,
          ...(submit.review ? { review: submit.review } : {}),
          ...(submit.pushed ? { pushed: submit.pushed } : {}),
          ...(submit.pushHeld ? { pushHeld: submit.pushHeld } : {}),
          ...(submit.existingPr ? { existingPr: submit.existingPr } : {}),
          ...(submit.prCheckFailed ? { prCheckFailed: submit.prCheckFailed } : {}),
          ...(submit.recheck ? { recheck: submit.recheck } : {}),
          ...(submit.commit ? { commit: submit.commit } : {}),
          ...(submit.branchGone ? { branchGone: submit.branchGone } : {}),
          ...(submit.head ? { head: submit.head } : {}),
          ...(submit.land !== undefined ? { land: submit.land } : {}),
          ...(submit.landBlocked ? { landBlocked: submit.landBlocked } : {}),
          ...(submit.recordsOnly ? { recordsOnly: submit.recordsOnly } : {}),
          ...(submit.landChecking ? { landChecking: submit.landChecking } : {}),
          ...(submit.landPending ? { landPending: submit.landPending } : {}),
          ...(submit.conflictForecast ? { conflictForecast: submit.conflictForecast } : {}),
          ...(waitingLanes.length ? { waitingLanes } : {}),
        });
      }
    }
    if (d.decision === "review") {
      const intent = derived.intent(rec, { root: laneRoot(rec.idd_id), events: evs });
      const shown = derived.reviewDiff(rec.idd_id, evs);
      const conflict = evs.filter((e) => e.event === "s3_check_conflict").pop();
      const conflictFiles = Array.isArray(conflict?.attrs?.conflict_files)
        ? (conflict.attrs.conflict_files as string[])
        : [];
      // a stacked lane is checked against its base lane's work, not the upstream
      const against = typeof conflict?.attrs?.against === "string" ? conflict.attrs.against : "";
      const againstLabel = /^[0-9a-f]{40,64}$/.test(against) ? against.slice(0, 9) : against.replace(/^refs\/heads\//, "");
      const conflictTitle = conflict?.attrs?.conflict_type === "vs_base_lane"
        ? `${conflictFiles.length} ファイルが base の lane の作業${againstLabel ? `（${againstLabel}）` : ""}と衝突`
        : `${conflictFiles.length} ファイルが upstream と衝突`;
      items.push({
        kind: "review",
        iddId: rec.idd_id,
        ...appeared,
        target: { title: rec.title, ref: sourceOf(rec) ?? { kind: "lane", label: rec.idd_id } },
        conflictWith: conflictFiles.length
          ? { title: conflictTitle, ref: { kind: "file", label: conflictFiles[0] } }
          : undefined,
        diffFiles: shown.compared ? shown.diffFiles : undefined,
        ...(shown.diffs?.length
          ? {
            diffs: shown.diffs.map((d) => ({
              ...d,
              before: d.before.map((l) => ({ ...l, marker: (l.marker ?? null) as "+" | "-" | null })),
              after: d.after.map((l) => ({ ...l, marker: (l.marker ?? null) as "+" | "-" | null })),
            })),
          }
          : {}),
        ...(shown.baseNote ? { baseNote: shown.baseNote } : {}),
        ...(shown.branch ? { diffBranch: shown.branch } : {}),
        criteria: criteriaStates(intent.criteria, acStatesForLane({ lane: rec.idd_id, rows: readWorkRows(workColumnPath(rec.area)), events: evs })),
      });
    }
  }

  const count = (g: LaneGroup) => lanes.filter((l) => l.group === g).length;
  // each capped stage's slots and the lanes it holds back, counted the way the next tick would take them;
  // when that cannot be counted, the heading keeps the running count and the cap alone
  let slots: Record<"prep" | "impl", Pick<LaneSection, "running" | "cap" | "wait" | "stages">>;
  try {
    const waits = slotWaits({ backlog, events });
    slots = { prep: sectionSlots(waits, "prep"), impl: sectionSlots(waits, "impl") };
  } catch (err) {
    console.warn(`[idd state] 上限待ちを数えられませんでした: ${String(err).slice(0, 400)}`);
    slots = { prep: { running: runningPlanners(), cap: plannerConcurrency() }, impl: { running: runningExecutors(), cap: executorConcurrency() } };
  }
  const sections: LaneSection[] = [
    { group: "judge", label: LANE_SECTION_LABEL.judge, count: count("judge") },
    { group: "prep", label: LANE_SECTION_LABEL.prep, count: count("prep"), ...slots.prep },
    { group: "impl", label: LANE_SECTION_LABEL.impl, count: count("impl"), ...slots.impl },
    { group: "waiting", label: LANE_SECTION_LABEL.waiting, count: count("waiting") },
    { group: "closed", label: LANE_SECTION_LABEL.closed, count: count("closed"), collapsed: true },
  ];

  items.push(...landBatchItems((opts.now ?? new Date()).getTime()));
  items.push(...storageCardItems());
  items.push(...proposalCardItems());
  items.push(...syncConflictCardItems());

  const run = readLatestCronRun();
  // every card carries the judgment it waits for and the operations that answer it, in the response it is sent in (C-265-1)
  const decided = withDecisions(items);
  return {
    source: "state",
    stateDir: dir,
    ...machine,
    cron: run
      ? {
        startedAt: run.started_at.slice(11, 16),
        finishedAt: run.completed_at.slice(11, 16),
        failures: (run.failure_details ?? []).map((f) => ({ iddId: String(f.idd_id ?? ""), reason: String(f.reason ?? "") })),
      }
      : null,
    sections,
    lanes,
    items: decided,
    undelivered: countUndelivered(),
    unreadableColumns,
    shouldFix: shouldFixView(byLane, backlog),
    ignores: ignoresView(),
    holds: holdsView(),
    ...(() => {
      const answered = answeredCards(events, backlog, opts.now ?? new Date());
      return { answered, progress: { done: answered.length, open: decided.length } };
    })(),
  };
}

/**
 * `buildState` plus the lane costs and today's total. The sync `buildState` stays as it is (its callers and tests read
 * it synchronously); the costs need the async session reader, so the route calls this instead and attaches the
 * snoozes after. A lane's `cost` is read from the same `laneCost` the budget uses, so the row and the budget agree.
 */
export async function buildStateWithCosts(opts: { liveSessions?: Set<string>; now?: Date } = {}, injected?: DerivedDeps): Promise<IddState> {
  const derived = injected ?? REAL_DERIVED;
  const state = buildState(opts, derived);
  const events = state.source === "empty" ? [] : readLifecycle();
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of events) {
    const list = byLane.get(e.idd_id) ?? [];
    list.push(e);
    byLane.set(e.idd_id, list);
  }
  const today = jstDay(opts.now ?? new Date());
  const day: { budget: number; subscription: number } = { budget: 0, subscription: 0 };
  let reviews: Map<string, ReturnType<typeof listReviewLanes>[number]> | undefined;
  for (const row of state.lanes) {
    let cost: { total: number; subscription: CostPart[]; daily: DailyCost[] };
    if (row.iddId.startsWith("REV-")) {
      if (!reviews) reviews = new Map(listReviewLanes().map((r) => [r.id, r]));
      const rec = reviews.get(row.iddId);
      if (!rec) continue;
      cost = await derived.cost(row.iddId, rec.history.map((e) => ({ ...e, idd_id: row.iddId })));
    } else {
      cost = await derived.cost(row.iddId, byLane.get(row.iddId) ?? []);
    }
    row.cost = { budget: cost.total, subscription: subscriptionTotal(cost) };
    for (const d of cost.daily) {
      if (d.day !== today) continue;
      day.budget += d.budget;
      day.subscription += d.subscription;
    }
  }
  state.today = { day: today, ...day };
  return state;
}

/**
 * An Issue lane's detail. A lane whose planner / executor or short stages ran on Claude Code also gets their
 * conversation, its spend (the subscription's API equivalent, apart from the budget) and the windows' use;
 * a pi lane shows as it did.
 */
export async function buildLaneDetail(iddId: string, opts: { liveSessions?: Set<string> } = {}): Promise<LaneDetailView | null> {
  const backlog = readBacklog();
  const rec = backlog.find((b) => b.idd_id === iddId);
  if (!rec) return null;
  const all = readLifecycle();
  const evs = all.filter((e) => e.idd_id === iddId);
  const byLane = new Map<string, LifecycleRecord[]>();
  for (const e of all) byLane.set(e.idd_id, [...(byLane.get(e.idd_id) ?? []), e]);
  const live = opts.liveSessions ?? new Set<string>();
  const d = deriveStage(evs);
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  const worktree = executor?.worktree_path ?? planner?.worktree_path;
  // an ended lane whose worktree was retired still shows its plan and files, from its branch
  const branch = laneBranchSource(rec.area, worktree, executor?.branch ?? planner?.branch);
  const intent = laneIntent(rec, { root: laneRoot(rec.idd_id), events: evs, ...(branch ? { branch } : {}) });
  const progress = readProgress(iddId);
  const criteria = criteriaStates(intent.criteria, acStatesForLane({ lane: iddId, rows: readWorkRows(workColumnPath(rec.area)), events: evs }));
  // a repo that does not publish: an approved landing the tick still owes is said on the lane's own screen too
  const landWait = (() => {
    if (d.group === "closed") return undefined;
    const area = readAreas().areas[rec.area];
    if (!area || publishes(area)) return undefined;
    if (!currentLandApproval(evs)) return undefined;
    return lastLandHold(evs) || "承認は記録済みで、次の tick が本流へ merge します";
  })();

  // the lane's own changes start at its fork point from its base, which a base taken in moves on (the review
  // range's start when the fork point cannot be read)
  const tree = worktree ? resolveWorktree(worktree) : null;
  // a base that cannot be read (the parent ended and left nothing) counts nothing, rather than the work branch
  const baseMissing = laneBaseMissing(iddId);
  const forkPoint = baseMissing ? null : tree ? laneForkPoint(iddId, tree) : branch ? laneForkPoint(iddId, branch.repo, branch.ref) : null;
  const changedFrom = forkPoint ?? (reviewBaseOf(evs) || undefined);
  const claudeHarness = (h?: string) => (h === "claude" ? { harness: "claude" as const } : {});
  const summary = readySummaryOf(evs);
  const riskTable = riskTableOf(evs);
  const intentImpact = intentImpactOf(evs, rec);
  const riskMatch = riskMatchOf(evs);
  const purposeProposals = d.decision === "go" ? purposeProposalsOf(rec.area, iddId) : [];

  const agents: LaneDetailView["agents"] = [];
  if (planner?.planner_session_id) {
    agents.push({
      role: "下調べ",
      sessionId: planner.planner_session_id,
      state: d.group === "prep" ? "稼働中" : "終了",
      ...claudeHarness(planner.harness),
    });
  }
  if (executor?.executor_session_id) {
    agents.push({
      role: "実装",
      sessionId: executor.executor_session_id,
      state: d.group === "impl" ? "稼働中" : "終了",
      ...claudeHarness(executor.harness),
    });
  }

  // every executor session the lane ran, in the order it started them: a fix round has its own conversation
  const executors = readSessions("executor").filter((r) => r.idd_id === iddId);
  const claude = [
    planner?.harness === "claude" ? conversationView("下調べ", planner.planner_session_id, live) : null,
    ...executors.map((e, i) => (e.harness === "claude" ? conversationView(i === 0 ? "実装" : `修正 ${i}`, e.executor_session_id, live) : null)),
    claudeRunsView(runIdsOf(evs)),
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  const loop = reviewLoopState(evs);
  // the lane's spend is read from the same reader the budget uses, for every lane; the Claude Code `cost`
  // below still shows only for a lane whose stages ran on it (the screen keys the cost section on that)
  const spend = await laneCost(iddId, evs);
  const quota = claude.length ? claudeQuotaView() : undefined;

  return {
    iddId,
    title: rec.title,
    group: d.group,
    phaseLabel: d.decision === "stuck" ? "要判断" : d.decision === "requeue" ? "再開待ち" : d.group === "impl" ? "実装中" : d.decision === "go" ? "GO 待ち" : d.decision === "ship" ? "提出前確認" : d.group === "waiting" ? "待機中" : "下調べ中",
    source: sourceOf(rec),
    branch: executor?.branch ?? planner?.branch ?? `idd/${iddId}`,
    area: rec.area,
    since: agoLabel(elapsedLabel(lastMovedAt(evs, rec.created_at))),
    ...(summary ? { summary } : {}),
    ...(riskTable ? { riskTable } : {}),
    ...(intentImpact ? { intentImpact } : {}),
    ...(riskMatch ? { riskMatch } : {}),
    // an open lane with a PR can ask for a body update at any time (a card, nothing is written until penne approves it)
    ...((() => {
      const pr = d.group !== "closed" ? prOf(evs) : null;
      return pr ? { pr: { url: pr.url, number: pr.pr } } : {};
    })()),
    contract: {
      decisions: intent.decisions,
      criteria,
      invariants: d.decision === "go" ? intent.invariants : undefined,
    },
    work: progress
      ? {
        files: worktree && !baseMissing ? changedFiles(worktree, changedFrom, branch) : [],
        ...(baseMissing ? { note: baseMissing } : {}),
        stream: progress.recent_activity.map((a) => ({ time: progress.updated_at.slice(11, 16), kind: "…", body: a })),
      }
      : undefined,
    references: d.decision === "go" ? intent.references : undefined,
    ...(purposeProposals.length ? { purposeProposals } : {}),
    timeline: buildTimeline(evs),
    agents,
    pending: d.decision,
    ...(landWait ? { landWait } : {}),
    ...(loop.state === "awaiting_order" ? { orderWait: { opponents: loop.opponents.map((o) => ({ lane: o.lane, files: o.files })), rank: orderRankOf(iddId, byLane) } } : {}),
    undelivered: countUndelivered(iddId),
    ...(claude.length ? { claude, cost: shownCost(spend), ...(quota ? { quota } : {}) } : {}),
    spend: { budget: spend.total, subscription: subscriptionTotal(spend) },
    reviewRounds: reviewRounds(evs),
    ...(d.group === "prep" || d.group === "impl" ? {
      activity: laneActivity(iddId, d.group, live),
      ...((d.group === "prep" ? planner : executor)?.started_at ? { stageSince: (d.group === "prep" ? planner : executor)?.started_at } : {}),
      // the stage's own count only while the lane holds or waits for one of its slots (a lane in the review loop is not the executor's)
      ...(inStageSlot(evs, d.group) ? { concurrency: stageConcurrency(d.group) } : {}),
    } : {}),
    ...slotWaitOf(iddId, { backlog, events: all }),
  };
}

/** a lane held back by a stage's cap says which cap and for how long; when that cannot be counted it says nothing */
export function slotWaitOf(id: string, ledger: Parameters<typeof slotWaits>[0] = {}): { slotWait?: NonNullable<LaneDetailView["slotWait"]> } {
  try {
    const wait = laneSlotWait(slotWaits(ledger), id);
    return wait ? { slotWait: wait } : {};
  } catch (err) {
    console.warn(`[idd state] 上限待ちを数えられませんでした: ${String(err).slice(0, 400)}`);
    return {};
  }
}

/** a planner holds its slot until its ready, an executor until its result; before they start, the lane waits for one */
function inStageSlot(evs: LifecycleRecord[], group: "prep" | "impl"): boolean {
  const ends = group === "prep" ? ["s1_ready", "s1_defer", "lane_close"] : ["s2_result", "lane_close"];
  return !evs.some((e) => ends.includes(e.event));
}

/** the lanes holding a working stage's slots against its cap, counted as the cap counts them (started, not finished) */
function stageConcurrency(group: "prep" | "impl"): NonNullable<LaneDetailView["concurrency"]> {
  return group === "prep"
    ? { label: LANE_SECTION_LABEL.prep, count: runningPlanners(), cap: plannerConcurrency() }
    : { label: LANE_SECTION_LABEL.impl, count: runningExecutors(), cap: executorConcurrency() };
}

/**
 * What a stop over the checks before the convergence holds, as the stuck card's open items: the failures the lane made
 * (the musts a continue sends to the fix), or each check that could not be compared with what the run said of it. A
 * run that could not run holds none.
 */
function checksStopItems(stop: Record<string, unknown>): { ref: string; severity: string; claim: string; path?: string }[] {
  if (stop.failed) return [];
  if (stop.outcome === "new") {
    const findings = Array.isArray(stop.findings) ? (stop.findings as Record<string, unknown>[]) : [];
    return findings.map((f) => ({ ref: String(f.ref ?? ""), severity: String(f.severity ?? "must"), claim: String(f.claim ?? "") }));
  }
  const rows = Array.isArray(stop.checks) ? (stop.checks as Record<string, unknown>[]) : [];
  return rows
    .filter((r) => r.status !== "pass" && r.status !== "not-applicable" && !(r.status === "fail" && r.verdict === "preexisting"))
    .map((r) => ({ ref: `checks/${String(r.name ?? "")}`, severity: "must", claim: `${String(r.name ?? "")}（${String(r.phrase ?? r.status ?? "")}）` }));
}
