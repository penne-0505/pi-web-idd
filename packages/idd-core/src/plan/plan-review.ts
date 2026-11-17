import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { areaSegment, slugOf } from "../intent/parse.ts";
import { planReviewPhase } from "../ledger/derive.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { inStartOrder } from "../ledger/start-order.ts";
import { appendLifecycle, buildEnvelope, queueEnvelope } from "../ledger/write.ts";
import { fallbackAttrs, quotaWaitOf, recordQuotaWait } from "./quota-wait.ts";
import { getAgentRunner, type PlanReviewFinding } from "../agent/port.ts";
import { pipelineConcurrency, pipelineSlotDeclared } from "../config/pipeline.ts";
import { normText } from "./harness-norms.ts";
import { lanePlanDoc } from "./plan-doc.ts";
import { DEPTH_TABLE } from "./depth.ts";
import { laneDepth } from "./depth-read.ts";
import { INTENT_IMPACT_RULE, readyPlanRecordsOf } from "../agent/intent-impact.ts";
import { laneRecordShape } from "./record-shape.ts";
import { writeLaneChoicesFile } from "./lane-intent.ts";
import { stateDir } from "../paths.ts";
import { foldRows, intentColumnPath, laneStates, raisedByLane, readRows } from "../intent/store.ts";
import { driveStartSteps } from "./start-step.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The planner's documents a review reads. The context document is last on purpose: other stages read `[0]` (the
 * intent) and `[1]` (the qa) by position, so the lane's context document must not push them. A lane planned before
 * the document existed names a path that is not there; the reader filters the inputs it cannot open.
 */
export function planReviewInputs(rec: { area: string; idd_id: string; title: string } & Parameters<typeof slugOf>[0]): string[] {
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  return [
    `_docs/intent/${seg}/${slug}/decision.md`,
    `_docs/qa/${seg}/${slug}/qa.md`,
    `_docs/reference/${seg}/${slug}/reference.md`,
    `_docs/context/${seg}/${slug}/context.md`,
  ];
}

/**
 * The files the review is handed: a docs-shape lane's own documents, or a v2 lane's drawn Choices and Purposes
 * before the GO. The order is decided here, once, so a lane of either shape is handed the same reading the stage
 * describes (the context document stays last among the documents: other stages read `[0]` and `[1]` by position).
 */
export function planReviewInputPaths(opts: {
  shape: "docs" | "state";
  documents: string[];
  choicesFile?: string | undefined;
  purposesFile?: string | undefined;
  planRel?: string | undefined;
}): string[] {
  if (opts.shape === "state") {
    return [
      ...(opts.choicesFile ? [opts.choicesFile] : []),
      ...(opts.purposesFile ? [opts.purposesFile] : []),
      ...opts.documents.slice(1),
      ...(opts.planRel ? [opts.planRel] : []),
    ];
  }
  return [...opts.documents, ...(opts.planRel ? [opts.planRel] : [])];
}

/**
 * The Purposes a v2 lane's plan review reads: the ones its draft Choices join, and the ones the lane raised
 * itself, each with its statement and whether this lane raised it. A reviewer can weigh an artifact-nature want
 * before the GO; a lane with no such Purpose gets no file.
 */
export function writeLanePurposesFile(rec: { idd_id: string; area: string }, label: string, readerLabel = "計画の査読の入力"): string | undefined {
  const events = readLifecycle();
  const drafts = readyPlanRecordsOf(events.filter((e) => e.idd_id === rec.idd_id))?.choices ?? [];
  const joined = new Set(drafts.map((c) => c.purpose).filter(Boolean));
  const purposes = foldRows(readRows(intentColumnPath(rec.area)), rec.idd_id, laneStates(events)).purposes;
  // a proposal a person took back is not the lane's proposal any more, so the reviewer is not shown it as one
  const shown = purposes.filter((p) => p.status !== "withdrawn" && (joined.has(p.id) || raisedByLane(p.raised.by) === rec.idd_id));
  if (!shown.length) return undefined;
  const dir = join(stateDir(), "pipeline", "lane-purposes");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.idd_id}-${label}.md`);
  writeFileSync(file, [
    `# ${rec.idd_id} の Purpose（${readerLabel}）`,
    "",
    ...shown.flatMap((p) => {
      const mine = raisedByLane(p.raised.by) === rec.idd_id;
      const numbers = drafts.flatMap((c, i) => (c.purpose === p.id ? [`${i + 1}`] : []));
      return [
        `## ${p.id}（${mine ? "この lane の案" : p.status}）`,
        `- statement: ${p.statement}`,
        ...(numbers.length ? [`- 連なる草案: ${numbers.join(", ")}`] : []),
        "",
      ];
    }),
  ].join("\n"));
  return file;
}

export function planReviewEnvelope(iddId: string, findings: PlanReviewFinding[], reports: string[], opts: { hasPlan?: boolean; shape?: "docs" | "state" } = {}): string {
  // only must goes back to the planner: should stays on the GO card for the decider
  const items = findings
    .filter((f) => f.severity === "must")
    .map((f) => `    <finding severity="${f.severity}" path="${esc(f.path)}"${f.source ? ` from="${esc(f.source)}"` : ""}>${esc(f.claim)}${f.evidence ? ` — ${esc(f.evidence)}` : ""}</finding>`);
  // a work shortage goes to the plan, an intent mistake to the records; a DEC is never added to answer a finding (DEC-2643)
  const actions = opts.shape === "state"
    ? (opts.hasPlan
      ? [
        "    1. みずからでも確かめ、実際に修正すべきものは、計画の報告の草案（choices）と処置（existing）を直す。直す先は指摘の性質で分ける。作業の不足は plan.md、AC の状態の不足は qa.md、守る形は Choice の anchored か free に置く。AC に how を足さない。",
        "    2. 確かめた上で、修正を要さないと判断したものは、作業指示があるので plan.md に理由を 1 文で残す。Choice は増やさない。",
        "    3. 直した後は `idd report plan` を丸ごと送り直す。",
      ]
      : [
        "    1. みずからでも確かめ、実際に修正すべきものは、計画の報告の草案（choices）と処置（existing）を直す。直す先は指摘の性質で分ける。AC の状態の不足は qa.md、守る形は Choice の anchored か free に置く。受け入れ条件を qa.md へ足すことだけで直さず、AC に how を足さない。",
        "    2. 確かめた上で、修正を要さないと判断したものは、該当する草案の why か free に理由を 1 文で残す。Choice は増やさない。",
        "    3. 直した後は `idd report plan` を丸ごと送り直す。",
      ])
    : (opts.hasPlan
      ? [
        "    1. みずからでも確かめ、実際に修正すべきものは、指摘が指す文書を直す（作業の不足は plan.md、意図の誤りや不足は decision.md、受け入れ条件は qa.md）。",
        "    2. 確かめた上で、修正を要さないと判断したものは、理由を plan.md に 1 文で残す。DEC は増やさない。",
      ]
      : [
        "    1. みずからでも確かめ、実際に修正すべきものは decision.md / qa.md を直す（判断の追加・受け入れ条件の追加・Anchors の追記など）。",
        "    2. 確かめた上で、修正を要さないと判断したものは、該当する DEC の Why か Change freedom に理由を1文で残す。",
      ]);
  return buildEnvelope("plan_review_findings", iddId, [
    "  <task>",
    "    レビュワーがあなたのplanをレビューした。再検討すべき事柄が存在したため、差し戻された。あなたはこの指摘を確かめ、次のうちいずれかのアクションを取ること。",
    ...actions,
    "  </task>",
    "  <callback>",
    `    <plan>完了したら\`idd report plan\`を再度実行する。planに更新があった場合はsummaryも更新する。${INTENT_IMPACT_RULE} 触る path に open な指摘があれば、その処置を \`--findings\` で送る。</plan>`,
    "  </callback>",
    "  <findings>",
    ...items,
    "  </findings>",
    ...reports.map((p) => `  <report>${esc(p)}</report>`),
  ].join("\n"));
}

const SEVERITY_ORDER: Record<PlanReviewFinding["severity"], number> = { must: 0, should: 1, nit: 2 };

export interface PlanReviewResult {
  started: string[];
  finished: string[];
  skipped: string[];
  errors: { iddId: string; error: string }[];
}

/**
 * S1 plan review: after the planner's ready, review its documents, send must / should back to the planner, and
 * review the re-readied plan once more. The GO card opens when nothing was actionable, or when the second review
 * (counted from the lane's start or penne's last send-back) has been revised and re-readied.
 *
 * The decision is the MoonBit fold's (`packages/idd-fold/start_steps.mbt`): whether the lane's review starts, waits
 * for its slot, is skipped, or closes with the runs' counts. The caller keeps the readings of the runner and the
 * planner's worktree, and the effects: the runs, the files, the records (C-205-1, C-205-4).
 */
export async function runPlanReview(): Promise<PlanReviewResult> {
  const result: PlanReviewResult = { started: [], finished: [], skipped: [], errors: [] };
  const events = readLifecycle();
  const runner = getAgentRunner();
  const declared = pipelineSlotDeclared("plan_review");
  const cap = pipelineConcurrency("plan_review");

  for (const rec of inStartOrder(readBacklog())) {
    const laneEvents = events.filter((e) => e.idd_id === rec.idd_id);
    // a planner that recorded its ready can still be writing in its worktree; a review started then reads a plan
    // that moves under it and fails on the worktree check, and the GO card opens with no review. The start waits
    // for the planner's worktree to go quiet, the way the review loop waits for the executor's.
    if (planReviewPhase(laneEvents).phase === "waiting" && runner?.cwdBusy) {
      const planner = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop();
      let busy = false;
      try {
        busy = Boolean(planner?.worktree_path && runner.cwdBusy(planner.worktree_path));
      } catch {
        busy = false;
      }
      if (busy) continue;
    }
    // the window a start waits on is kept here: the fold says the lane waits, and the caller writes the wait
    let wait: ReturnType<typeof quotaWaitOf>;
    wait = null;
    const outcome = await driveStartSteps("start_plan_review", events, {
      lane: rec.idd_id,
      limit: cap,
      declared,
      started: result.started.length,
      runnerStart: Boolean(runner?.startPlanReview),
      runnerStatus: Boolean(runner?.planReviewStatus),
    }, {
      write: async (event, attrs) => {
        await appendLifecycle(event, rec.idd_id, attrs);
      },
      call: async (step) => {
        switch (step.helper) {
          case "planner_worktree": {
            const planner = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop();
            return planner?.worktree_path ? { path: planner.worktree_path } : { none: true };
          }
          case "start_runs": {
            const planner = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop();
            if (!planner?.worktree_path) return { error: "planner の worktree が記録にありません" };
            const attempt = laneEvents.filter((e) => e.event === "s1_plan_review_started").length + 1;
            try {
              const plan = lanePlanDoc(rec, planner.worktree_path);
              // a v2 lane's plan review reads the drawn Choices instead of decision.md: the drafts, before the GO
              const shape = laneRecordShape(rec.idd_id, laneEvents);
              const choicesFile = shape === "state" ? writeLaneChoicesFile(rec, `plan-review-${attempt}`) : undefined;
              const purposesFile = shape === "state" ? writeLanePurposesFile(rec, `plan-review-${attempt}`) : undefined;
              const inputs = planReviewInputPaths({
                shape,
                documents: planReviewInputs(rec),
                choicesFile,
                purposesFile,
                planRel: plan?.rel,
              });
              // the depth the lane declared (raised by its Risk): the plan review runs the table's roles, from the top
              const depth = laneDepth(rec, planner.worktree_path);
              const { runs, failed = [], fallbacks } = await runner!.startPlanReview!({
                iddId: rec.idd_id, worktree: planner.worktree_path, inputs, attempt,
                roles: DEPTH_TABLE[depth].planReview,
                // a depth with a shape column runs the shape judge beside the reviewers (C-252-1); its findings are folded
                // with theirs below, so a must from it sends the plan back the way a reviewer's does (C-252-5)
                ...(DEPTH_TABLE[depth].shape > 0 ? { withShape: true } : {}),
                // the planner followed the harness where it overrides the repo (its lane identifiers and the source TODO)
                norms: shape === "state" ? [normText("todo-source", "state")] : [normText("lane-ids"), normText("todo-source")],
                ...(shape === "state" ? { recordsShape: "state" as const } : {}),
              });
              return { runs, ...(failed.length ? { failed } : {}), ...(fallbackAttrs(fallbacks).fallbacks ? { fallbacks: fallbackAttrs(fallbacks).fallbacks } : {}) };
            } catch (err) {
              // waiting for Claude Code's windows is not a failed review: the lane waits and the next tick tries again
              wait = quotaWaitOf(err);
              return { error: String(err), ...(wait ? { quota: { reason: wait.reason, ...(wait.resetsAt !== undefined ? { resetsAt: wait.resetsAt } : {}) } } : {}) };
            }
          }
          case "record_quota_wait": {
            if (wait) await recordQuotaWait(rec.idd_id, laneEvents, "plan_review", wait);
            return { ok: true };
          }
          case "run_status": {
            try {
              return runner!.planReviewStatus!(String(step.args?.runId ?? ""));
            } catch (err) {
              // a broken report fails this run, not the whole tick
              return { state: "failed", error: String(err) };
            }
          }
          case "merge_findings": {
            const lists = (step.args?.lists as PlanReviewFinding[][]) ?? [];
            // one run has nothing to fold against: its findings go back as they are
            const folded = lists.length > 1 && runner?.mergeFindings ? runner.mergeFindings(lists) : lists.flat();
            return { findings: [...folded].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) };
          }
          case "has_plan": {
            const plannerWorktree = readSessions("planner").filter((r) => r.idd_id === rec.idd_id).pop()?.worktree_path;
            return { hasPlan: !!plannerWorktree && !!lanePlanDoc(rec, plannerWorktree) };
          }
          case "queue_envelope": {
            const findings = (step.args?.findings as PlanReviewFinding[]) ?? [];
            const reports = ((step.args?.reports as (string | null)[]) ?? []).map((r) => String(r ?? ""));
            await queueEnvelope(rec.idd_id, "plan_review_findings", planReviewEnvelope(rec.idd_id, findings, reports, { hasPlan: Boolean(step.args?.hasPlan), shape: laneRecordShape(rec.idd_id, laneEvents) }), { role: "planner" });
            return { ok: true };
          }
          default: return { error: `知らない helper: ${String(step.helper)}` };
        }
      },
    });
    if (outcome.action === "started") result.started.push(rec.idd_id);
    else if (outcome.action === "skipped") result.skipped.push(rec.idd_id);
    else if (outcome.action === "finished") result.finished.push(rec.idd_id);
    else if (outcome.action === "error") result.errors.push({ iddId: rec.idd_id, error: outcome.error ?? "" });
  }
  return result;
}
