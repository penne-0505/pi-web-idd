import { join } from "node:path";

import { getAgentRunner, type RiskRoute } from "../agent/port.ts";
import { resolveGithubAreaKey } from "../config/areas.ts";
import { writeHarmExamplesFile } from "../config/harm-examples.ts";
import { pipelineConcurrency, pipelineSlotDeclared, pipelineSlotSize, pipelineSnapshot } from "../config/pipeline.ts";
import { BlindGate, mapSkipReasonOf, reviewLaneBlindCount } from "../plan/blind-count.ts";
import { quotaWaitOf } from "../plan/quota-wait.ts";
import { judgementCopy, reportedSeverities } from "../plan/review-loop.ts";
import { reviewLaneState, renderReviewDraft, type DraftItem, type ReviewLaneRecord, type ReviewLaneState } from "./state.ts";
import { appendReviewEvent, listReviewLanes, reviewsDir } from "./store.ts";

export interface ReviewLaneResult {
  advanced: { id: string; to: string }[];
  errors: { id: string; error: string }[];
}

function last(rec: ReviewLaneRecord, name: string) {
  for (let i = rec.history.length - 1; i >= 0; i -= 1) if (rec.history[i].event === name) return rec.history[i];
  return undefined;
}

/**
 * Advance every open review lane by at most one step. Posting stays with penne: the draft goes to
 * the outbound card, and the lane only reads back whether it was posted (and with which event).
 */
export async function runReviewLanes(): Promise<ReviewLaneResult> {
  const result: ReviewLaneResult = { advanced: [], errors: [] };
  const runner = getAgentRunner();
  if (!runner) return result;
  if (!pipelineSlotDeclared("review_blind")) return result;
  // each blind or confirm round cuts copies of the PR with their own setup and tests: only this many lanes at once
  const cap = pipelineConcurrency("review_blind");
  // counted in copies: a blind round holds one per run (a mapped round one per place and a generic one), a confirm
  // holds a lane's worth. With usual rounds only this is the old count of lanes; a round larger than the cap waits for an empty cap
  const pipe = pipelineSnapshot();
  const size = pipelineSlotSize("review_blind");
  // the lanes that run at once are held too, as in the Issue lanes' review loop (plan/blind-count.ts)
  const holding = listReviewLanes().flatMap((r) => {
    const s = reviewLaneState(r);
    return s.state === "running_blind" ? [s.runIds.length] : s.state === "running_confirm" ? [size] : [];
  });
  const gate = new BlindGate(cap, size, holding.reduce((n, copies) => n + copies, 0), holding.length);
  // a large diff is mapped before its blind round; the map only reads, in the PR's review copy
  const mapOn = pipelineSlotDeclared("risk_map");
  const mapCap = pipelineConcurrency("risk_map");
  let mapping = listReviewLanes().filter((r) => reviewLaneState(r).state === "running_map").length;

  for (const rec of listReviewLanes()) {
    const st = reviewLaneState(rec);
    const note = (to: string) => result.advanced.push({ id: rec.id, to });
    const wt = last(rec, "r_wt_ready")?.attrs;
    const path = String(wt?.path ?? "");
    // the lane's copy is done with: a copy that cannot be taken down is noted on the record that ends it, not swallowed
    const dropCopy = (): { copy_left?: { path: string; reason: string } } => {
      if (!runner.removePrWorktree || !path) return {};
      try {
        runner.removePrWorktree({ repo: rec.repo, pr: rec.pr, path, name: rec.id });
        return {};
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        console.warn(`[review lane ${rec.id}] 複製を消せませんでした: ${path}: ${reason}`);
        return { copy_left: { path, reason } };
      }
    };
    const fail = (error: string, retry: ReviewLaneState) => {
      appendReviewEvent(rec.id, "r_failed", { error: error.slice(0, 400), retry_state: retry });
      result.errors.push({ id: rec.id, error });
    };
    try {
      switch (st.state) {
        case "prepare": {
          if (!runner.preparePrWorktree || !runner.prStatus) break;
          const pr = runner.prStatus(rec.repo, rec.pr);
          if (pr.state !== "OPEN") { appendReviewEvent(rec.id, "r_closed", { reason: `PR が ${pr.state}` }); note("closed"); break; }
          const w = await runner.preparePrWorktree({ repo: rec.repo, pr: rec.pr, name: rec.id });
          appendReviewEvent(rec.id, "r_wt_ready", { path: w.path, head: w.head, base: w.base, title: pr.title });
          note("worktree");
          break;
        }
        case "start_blind": {
          // the copies the round holds, counted the way the wait list counts them (plan/blind-count.ts)
          const count = reviewLaneBlindCount(pipe, st.map?.routes.length ?? 0);
          if (!runner.startReviewRun) break;
          // below the threshold, or when the map cannot start, the round runs as it always did.
          // Whether the diff is large enough is asked first: a small one does not wait for a map slot it will not use
          let mapSkipped = !st.map && mapOn ? mapSkipReasonOf(runner, { worktree: path, base: st.base, head: st.head }) : undefined;
          // the map drawn first holds none of the blind's copies: the blind's cap is asked once the map is out of the way
          const mapFirst = !st.map && mapOn && !mapSkipped;
          if (!mapFirst && !gate.fits(count)) break;
          if (mapFirst) {
            if (mapping >= mapCap) break;
            // the map reads the request: the PR's body, comments and existing reviews (C-152-3)
            const ctx = runner.fetchPrContext?.(rec.repo, rec.pr, join(reviewsDir(), rec.id, `ctx-map-${st.round}`))?.files ?? [];
            let map: Awaited<ReturnType<NonNullable<typeof runner.startReviewRun>>> | undefined;
            try {
              map = await runner.startReviewRun({ iddId: rec.id, stage: "map", round: st.round, worktree: path, base: st.base, head: st.head, inputs: ctx });
            } catch (err) {
              // a refusal for Claude Code's windows is a wait, not a failure: the map is tried again on the next tick
              const wait = quotaWaitOf(err);
              if (wait) {
                const reason = wait.reason.slice(0, 400);
                const prev = rec.history[rec.history.length - 1];
                if (!(prev?.event === "r_quota_wait" && prev.attrs?.stage === "map" && prev.attrs?.reason === reason)) {
                  appendReviewEvent(rec.id, "r_quota_wait", { stage: "map", reason, ...(wait.resetsAt !== undefined ? { resets_at: wait.resetsAt } : {}) });
                }
                note("map waits for Claude Code");
                break;
              }
              appendReviewEvent(rec.id, "r_map_done", { round: st.round, base: st.base, head: st.head, failed: true, error: String(err).slice(0, 400), routes: [] });
              note("map failed");
            }
            if (map?.runIds.length) {
              mapping += 1;
              appendReviewEvent(rec.id, "r_map_started", { round: st.round, run_id: map.runIds[0], base: st.base, head: st.head, ...(map.fallbacks?.length ? { fallbacks: map.fallbacks } : {}) });
              note("map");
              break;
            }
            mapSkipped = map?.skipped;
          }
          // a map that named no run leaves the blind to its own cap
          if (mapFirst && !gate.fits(count)) break;
          const routes: RiskRoute[] = st.map?.routes ?? [];
          if (count.routed !== undefined && !gate.fitsRouted(count)) break;
          const { runIds, wholeDiff, fallbacks, runLabels, routeCount, routesOverCap } = await runner.startReviewRun({ iddId: rec.id, stage: "blind", round: st.round, worktree: path, base: st.base, head: st.head, inputs: [], laneKind: "review", ...(routes.length ? { routes } : {}) });
          gate.took(runIds.length);
          appendReviewEvent(rec.id, "r_blind_started", {
            round: st.round, run_ids: runIds, head: st.head,
            ...(runLabels?.length ? { run_labels: runLabels } : {}),
            // a runner that names no run as whole-diff narrowed none of them
            ...(routes.length ? {
              mapped_routes: runLabels?.filter((l) => /^r\d+$/.test(l)).length ?? routes.length,
              route_count: routeCount ?? routes.length,
              ...(routesOverCap ? { routes_over_cap: true } : {}),
              base: st.base,
              whole_run_ids: wholeDiff ?? runIds,
            } : {}),
            ...(mapSkipped ? { map_skipped: mapSkipped } : {}),
            ...(fallbacks?.length ? { fallbacks } : {}),
          });
          note("blind");
          break;
        }
        case "running_map": {
          const s = runner.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          mapping -= 1;
          // a failed map leaves the round to the blind as it always ran
          if (s.state === "failed") appendReviewEvent(rec.id, "r_map_done", { round: st.round, base: st.base, head: st.head, failed: true, error: s.error, routes: [] });
          else appendReviewEvent(rec.id, "r_map_done", { round: st.round, base: st.base, head: st.head, routes: s.routes ?? [], report_md: s.reportMd, report_json: s.reportJson });
          note("map done");
          break;
        }
        case "running_blind": {
          if (!runner.reviewRunStatus) break;
          const states = st.runIds.map((id) => runner.reviewRunStatus!(id));
          if (states.some((s) => s.state === "running")) break;
          gate.released(st.runIds.length);
          // a routed round is judged when the whole-diff blind finished; a route blind that failed leaves its route unread
          const blind = last(rec, "r_blind_started")?.attrs ?? {};
          let unread: string[] = [];
          if (Array.isArray(blind.whole_run_ids)) {
            const whole = new Set(blind.whole_run_ids.map(String));
            if (!st.runIds.some((id, i) => whole.has(id) && states[i].state === "done")) {
              appendReviewEvent(rec.id, "r_map_dropped", { round: st.round, base: String(blind.base ?? ""), head: String(blind.head ?? ""), reason: "差分全体を読む blind が終わらなかったので、地図なしで起こし直す" });
              note("map dropped");
              break;
            }
            const labels = Array.isArray(blind.run_labels) ? blind.run_labels.map(String) : [];
            unread = st.runIds.flatMap((id, i) => (states[i].state === "done" || whole.has(id) ? [] : [labels[i] || id]));
          }
          const files = states.flatMap((s) => (s.state === "done" ? [s.reportJson] : []));
          if (!files.length) {
            const started = last(rec, "r_confirm_done")?.attrs ?? last(rec, "r_wt_ready")?.attrs ?? {};
            fail("レビューがすべて失敗", { state: "start_blind", round: st.round, base: String(started.base ?? ""), head: String(blind.head ?? started.head ?? "") });
            break;
          }
          appendReviewEvent(rec.id, "r_findings", { round: st.round, files, ...(unread.length ? { unread_routes: unread } : {}) });
          note("findings");
          break;
        }
        case "start_triage": {
          if (!runner.startReviewRun) break;
          // the triage reads what the author wrote (PR body, comments, reviews) along with the findings
          const ctx = runner.fetchPrContext?.(rec.repo, rec.pr, join(reviewsDir(), rec.id, `ctx-${st.round}`))?.files ?? [];
          const head = String(last(rec, "r_blind_started")?.attrs.head ?? wt?.head ?? "");
          const base = String(last(rec, "r_confirm_done")?.attrs.base ?? wt?.base ?? "");
          // the findings are handed without the reviewer's weight, action, frequency or plan, the way the Issue lane's judgement
          // reads them; the repo's own examples of harm come next to them when it declared any (C-210-1)
          const findings = st.inputs.map((p) => judgementCopy(p, st.round, "triage"));
          // the PR names its repo by GitHub owner/name, while the declaration sits under the registry key (they differ when
          // the entry sets github:) and in GitHub's capitals, which a registration may spell otherwise; a repo that is not
          // registered, or that more than one entry claims, hands no examples
          const declared = resolveGithubAreaKey(rec.repo);
          const harms = "key" in declared ? writeHarmExamplesFile(declared.key, `${rec.id}-${st.round}-judge`) : undefined;
          const { runIds, fallbacks } = await runner.startReviewRun({ iddId: rec.id, stage: "triage", round: st.round, worktree: path, base, head, inputs: [...findings, ...ctx, ...(harms ? [harms] : [])], laneKind: "review" });
          appendReviewEvent(rec.id, "r_triage_started", { round: st.round, run_id: runIds[0], ...(fallbacks?.length ? { fallbacks } : {}) });
          note("triage");
          break;
        }
        case "running_triage": {
          const s = runner.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          if (s.state === "failed") {
            // retry from the findings, i.e. the state before the triage was started
            fail(`判定に失敗: ${s.error}`, reviewLaneState({ ...rec, history: rec.history.filter((e) => e !== last(rec, "r_triage_started")) }));
            break;
          }
          const d = s.decisions ?? [];
          // the weight each reviewer gave a finding is the harness's reading of the report the decision names; the judgement
          // was never handed it, so a value it wrote anyway is not the reporter's. A finding with no report to bind to has none
          const reported = reportedSeverities(rec.id, d);
          const origin = (x: (typeof d)[number]) => ({
            ...(x.from?.length ? { from: x.from } : {}),
            ...(reported.has(x.ref) ? { reported_severity: reported.get(x.ref) } : {}),
          });
          appendReviewEvent(rec.id, "r_triage_done", {
            round: st.round,
            report_md: s.reportMd,
            accepted: d.filter((x) => x.verdict === "accept").map((x) => ({ severity: x.severity, claim: x.claim, path: x.path, reason: x.reason, fix: x.fix, impact: x.impact, action: x.action, ...(x.report === true ? { report: true } : {}), ...origin(x) })),
            rejected: d.filter((x) => x.verdict === "reject").map((x) => ({ claim: x.claim, reason: x.reason, ...(x.path ? { path: x.path } : {}), ...origin(x) })),
            escalated: d.filter((x) => x.verdict === "escalate").map((x) => ({ claim: x.claim, reason: x.reason })),
          });
          note("triage done");
          break;
        }
        case "draft": {
          if (!runner.queueOutbound) break;
          // a redraft whose old card could not be discarded waits for penne to discard it on the inbox
          const previous = last(rec, "r_redraft_requested")?.attrs.previous;
          // a runner that cannot read the old card's state waits too: it cannot tell a second card from a first
          if (previous && !runner.outboundStatus) break;
          const old = previous ? runner.outboundStatus?.(String(previous)) : null;
          if (old?.status === "posted") {
            // penne posted the old card instead: that review stands, and there is nothing to redraft
            const left = old.event === "approve" ? dropCopy() : {};
            appendReviewEvent(rec.id, "r_posted", { round: st.round, event: old.event ?? "comment", head: String(last(rec, "r_drafted")?.attrs.head ?? ""), url: old.url, ...left });
            note("posted");
            break;
          }
          if (old && old.status !== "discarded") break;
          const t = last(rec, "r_triage_done")?.attrs ?? {};
          const accepted = (t.accepted as DraftItem[] | undefined) ?? [];
          const escalated = (t.escalated as { claim: string; reason?: string }[] | undefined) ?? [];
          const draft = renderReviewDraft(accepted);
          // claims the triage could not decide are penne's to word; they go to the card as questions
          const questions = escalated.length ? ["", "## 確認したいこと", "", ...escalated.map((e, i) => `${i + 1}. ${e.claim}`)].join("\n") : "";
          const head = String(last(rec, "r_blind_started")?.attrs.head ?? wt?.head ?? "");
          const { id } = await runner.queueOutbound({
            kind: "gh-pr-review",
            target: { repo: rec.repo, pr: rec.pr, expectHead: head, event: draft.event },
            title: `#${rec.pr} ${String(wt?.title ?? rec.title)}`,
            body: `${draft.body}${questions}`.trim(),
            source: `review lane ${rec.id}`,
            lane: rec.id,
          });
          appendReviewEvent(rec.id, "r_drafted", { round: st.round, outbound_id: id, head, suggested: draft.event });
          note("drafted");
          break;
        }
        case "awaiting_penne": {
          const o = runner.outboundStatus?.(st.outboundId);
          if (!o) break;
          const head = String(last(rec, "r_drafted")?.attrs.head ?? "");
          if (o.status === "posted") {
            // an approve ends the lane: its review copy is no longer needed
            const left = o.event === "approve" ? dropCopy() : {};
            appendReviewEvent(rec.id, "r_posted", { round: st.round, event: o.event ?? "comment", head, url: o.url, ...left });
            note("posted");
          }
          else if (o.status === "discarded") { appendReviewEvent(rec.id, "r_discarded", { round: st.round, head }); note("discarded"); }
          break;
        }
        case "awaiting_author": {
          if (!runner.prStatus || !runner.movePrWorktree) break;
          const pr = runner.prStatus(rec.repo, rec.pr);
          if (pr.state !== "OPEN") {
            appendReviewEvent(rec.id, "r_closed", { reason: `PR が ${pr.state}`, ...dropCopy() });
            note("closed");
            break;
          }
          if (pr.head === st.head) break;
          runner.movePrWorktree({ repo: rec.repo, pr: rec.pr, path, name: rec.id });
          appendReviewEvent(rec.id, "r_head_changed", { previous: st.head, head: pr.head });
          note("head changed");
          break;
        }
        case "start_confirm": {
          if (!runner.startReviewRun || !gate.fits({ fits: size, runs: size })) break;
          gate.took(size);
          const prior = String(last(rec, "r_triage_done")?.attrs.report_md ?? "");
          const { runIds, fallbacks } = await runner.startReviewRun({ iddId: rec.id, stage: "confirm", round: st.round, worktree: path, base: st.base, head: st.head, inputs: prior ? [prior] : [], laneKind: "review" });
          appendReviewEvent(rec.id, "r_confirm_started", { round: st.round, run_id: runIds[0], base: st.base, head: st.head, ...(fallbacks?.length ? { fallbacks } : {}) });
          note("confirm");
          break;
        }
        case "running_confirm": {
          const s = runner.reviewRunStatus?.(st.runId);
          if (!s || s.state === "running") break;
          gate.released(size);
          const c = last(rec, "r_confirm_started")?.attrs ?? {};
          if (s.state === "failed") {
            fail(`確認に失敗: ${s.error}`, { state: "start_confirm", round: st.round, base: String(c.base ?? ""), head: String(c.head ?? "") });
            break;
          }
          // the increment since the last review gets its own blind next
          appendReviewEvent(rec.id, "r_confirm_done", { round: st.round, files: [s.reportJson], base: c.base, head: c.head });
          note("confirm done");
          break;
        }
        default:
          break;
      }
    } catch (err) {
      fail(String(err), st);
    }
  }
  return result;
}
