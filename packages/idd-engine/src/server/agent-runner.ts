
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DRAFT, agentToken, heldPrText, jstDay, getAgentRunner, sessionStopFrom, setAgentRunner, type AgentRunner, type SessionStatus, type SpawnResult } from "@idd/core";
import {
  addWorktree, adoptPipelineConversation, conversationBusyAt, conversationCost, conversationCostFingerprint, conversationCostReading, conversationStatus, wakeConversation, createOutbound, listOutbound, deliverToConversation, draftCommit, draftPr, fetchPrContext, fetchPrFeedback,
  isConversation, isSupervisedPipelineSession, moveWorktree,
  mergePlanReviewFindings, planReviewState, postOutboundNow, prStatus, prText, quotaBlockOf, readClaudeQuota, readRoles, readOutbound, publicWritingContext, pointedRules, pointedPrTemplate, pointedHeldPr, draftedSections, prTemplate, removeWorktree, repoByGithub, findRepoByGithub,
  reviewRunState, riskMapSkipReason, discardPipelineSession, spawnPipelineSession, startPlanReviews, startReviewRuns, stopPipelineSession, stopReviewRun,
  detectMissingMeans, pipelineCanaryRoles, canaryAgentDir, runCanaryQuestion, resolveLandConflict, questionRoutingRole, runQuestionRouter, resolveRole, pipelineAgentDir,
} from "@idd/lane";
import { prepareAgentDirAsync } from "./agent-dir-prep.ts";
import { resolveSessionFile } from "./session-file.ts";
import { kickTickAfterRecord } from "./tick-kick.ts";

/**
 * The plan review start's options, as the lane's `startPlanReviews` takes them. The engine adds no field of its own
 * and leaves out only what is absent, so every field the port's caller set (the lane's record shape among them)
 * reaches the lane. Rebuilding the object field by field once dropped `recordsShape`, sending a v1 task to a v2 lane.
 */
export function planReviewStartArgs(opts: Parameters<NonNullable<AgentRunner["startPlanReview"]>>[0]) {
  const { iddId, worktree, inputs, attempt, roles, norms, iddNorms, recordsShape, withShape } = opts;
  return {
    iddId, worktree, inputs, attempt,
    ...(typeof roles === "number" ? { roles } : {}),
    ...(norms?.length ? { norms } : {}),
    ...(iddNorms?.length ? { iddNorms } : {}),
    ...(recordsShape ? { recordsShape } : {}),
    ...(withShape ? { withShape } : {}),
  };
}

/** the sections a draft read, with their hashes, for the draft's record: no field when it read none */
function sectionsRead(root: string, kind: "pr" | "commit", at: ReturnType<typeof pointedRules>): { conventions?: ReturnType<typeof draftedSections> } {
  const read = draftedSections(root, kind, at);
  return read.length ? { conventions: read } : {};
}

const runner: AgentRunner = {
  /**
   * role is the pipeline slot name (planner / executor); config/roles.yaml pipeline.<slot> picks the preset.
   * Every harness runs as a conversation lane under the lane supervisor, outside this process; spawn only
   * claims it, and the first deliver starts it. Refused for the subscription's windows, a claude role with a
   * fallback opens the fallback (an API role) as a pi conversation instead; the whole conversation stays on it.
   */
  async spawn({ role: slotName, cwd, laneId }): Promise<SpawnResult> {
    // the token file exists before the agent's first bash: a pi conversation's supervisor reads it per reply,
    // and a Claude Code one likewise. The lane id is what the agent reports as.
    if (laneId) agentToken();
    return spawnPipelineSession(slotName, cwd, laneId ? { iddId: laneId } : {});
  },

  /**
   * the subscription windows as the stage's start reads them (the lane's own `quotaBlockOf`), so core's readers
   * decide a lane's wait the same way a start does: the file and the thresholds stay in the lane (C-133-3)
   */
  quotaBlock() {
    const roles = readRoles();
    return quotaBlockOf(readClaudeQuota(roles.defaults.claudeConfigDir), roles.defaults.claudeQuotaStop);
  },

  /** a session whose start the engine refused: the conversation is unclaimed, nothing was given a message */
  async discard(sessionId: string): Promise<void> {
    discardPipelineSession(sessionId);
  },

  /**
   * a lane taken out: every pipeline session runs as a conversation lane under the supervisor, so it is stopped as
   * that lane (a person's stop). This process has no pi session of its own to shut down any more.
   */
  async stopSession(sessionId: string): Promise<void> {
    await stopPipelineSession(sessionId, async () => {});
  },

  /** a stage's run: stopped with a person's stop, and the review copy it used is taken down */
  stopRun(runId: string): void {
    stopReviewRun(runId);
  },

  /**
   * plan review runs as ad-hoc lanes, one per role named by pipeline.plan_review; a role refused for Claude's
   * windows runs on its fallback
   */
  startPlanReview(opts) {
    return startPlanReviews(planReviewStartArgs(opts));
  },

  planReviewStatus(runId) {
    const st = planReviewState(runId);
    if (st.state !== "done") return st;
    return {
      state: "done",
      reportMd: st.reportMd,
      findings: st.findings.map((f) => ({ severity: f.severity, path: f.path, claim: f.claim, evidence: f.evidence })),
      // a run that switched role / provider while it ran leaves that on the status, so the closing record and the
      // timeline of the plan review stage read it the same way an S2 round's does
      ...(st.fallbacks?.length ? { fallbacks: st.fallbacks } : {}),
    };
  },

  /** the parallel plan reviews are folded the way `idd report merge` folds blind reviews */
  mergeFindings(lists) {
    return mergePlanReviewFindings(lists);
  },

  /**
   * The marks of a lane's own records that show a tool refusing the agent the means: the lane's stage runs (named by
   * their lane ids) and its conversations (named by their session ids) are read here, next to the configured marks.
   */
  missingMeans(opts) {
    return detectMissingMeans(opts);
  },

  /** S2 review loop: each stage runs as ad-hoc lanes with the roles of its pipeline slot */
  startReviewRun(opts) {
    return startReviewRuns(opts);
  },

  riskMapSkipReason(opts) {
    return riskMapSkipReason(opts);
  },

  reviewRunStatus(runId) {
    const st = reviewRunState(runId);
    if (st.state !== "done") return st;
    return {
      ...st,
      // the recommended action and the frequency estimate ride along with each finding, as the run reported them
      findings: st.findings.map((f) => ({
        severity: f.severity, path: f.path, claim: f.claim, evidence: f.evidence,
        ...(f.action ? { action: f.action } : {}), ...(f.frequency ? { frequency: f.frequency } : {}),
      })),
    };
  },

  /** review lanes: the PR's review copy lives under the repo's reviewRoot, like `idd wt add --pr` */
  async preparePrWorktree({ repo, pr, name }) {
    const r = repoByGithub(repo);
    try {
      // this copy is read by triage and is the source the reviewers' copies are cut from; each of those
      // runs the repo's setup in its own lane, so the tick does not wait for it here
      const meta = addWorktree(r, { pr, name, skipSetup: true });
      return { path: meta.path, head: meta.head, base: meta.merge_base };
    } catch (err) {
      // a copy that failed half way stays checked out; take it down so a resume can cut it again
      try { removeWorktree(r, join(r.reviewRoot, name), { force: true }); } catch { /* not created */ }
      throw err;
    }
  },

  /** the copy the lane recorded is moved where it is, even when the review root has moved since it was cut */
  movePrWorktree({ repo, pr, path, name }) {
    const meta = moveWorktree(repoByGithub(repo), path, { pr, ...(name ? { recorded: { name, pr } } : {}) });
    return { head: meta.head, base: meta.merge_base };
  },

  /** a copy already gone needs nothing; any other failure is the lane's to note */
  removePrWorktree({ repo, pr, path, name }) {
    if (!existsSync(path)) return;
    removeWorktree(repoByGithub(repo), path, { force: true, ...(name ? { recorded: { name, ...(pr !== undefined ? { pr } : {}) } } : {}) });
  },

  prStatus(repo, pr) {
    return prStatus(repo, pr);
  },

  prText(repo, pr) {
    return prText(repo, pr);
  },

  fetchPrContext(repo, pr, out) {
    const ctx = fetchPrContext(repo, pr, out);
    // what the author and other reviewers wrote; the meta and raw JSON stay out of the triage's inputs
    return { files: ctx.written.filter((p) => /(body|comments|reviews|threads)\.md$/.test(p)) };
  },

  fetchPrFeedback(repo, pr) {
    return fetchPrFeedback(repo, pr);
  },

  async queueOutbound(opts) {
    // a body update is compared line by line with the PR's body, and an Issue's close is a one-line notice the
    // harness wrote: both are queued as written, without the rewrite
    if (opts.kind === "gh-pr-body" || opts.kind === "gh-issue-close") {
      const rec = await createOutbound({ kind: opts.kind, target: opts.target, title: opts.title, body: opts.body, source: opts.source, noRewrite: true });
      return { id: rec.id };
    }
    // a review, a reply or an Issue is written in the language of the repo it goes to, after its templates
    // a repo that is not registered is queued without its language or pointers; a registry that cannot be read throws
    const r = findRepoByGithub(opts.target.repo) ?? undefined;
    const language = r?.language;
    if (opts.kind === "gh-issue") {
      // no repo found means no pointer to read: the registry is not asked again for a pointer it just could not give
      const context = publicWritingContext(r?.clone ?? "", { kind: "issue", repo: opts.target.repo, ...(r ? {} : { conventions: {} }), ...(language ? { language } : {}) });
      const rec = await createOutbound({ kind: "gh-issue", target: opts.target, title: opts.title, body: opts.body, source: opts.source, context, ...(opts.lane ? { lane: opts.lane } : {}) });
      return { id: rec.id };
    }
    const context = publicWritingContext("", { kind: "review", ...(language ? { language } : {}) });
    if (opts.kind === "gh-pr-replies") {
      const rec = await createOutbound({ kind: "gh-pr-replies", target: opts.target, title: opts.title, body: "", parts: opts.parts, source: opts.source, context, ...(opts.lane ? { lane: opts.lane } : {}) });
      return { id: rec.id };
    }
    const rec = await createOutbound({ kind: opts.kind, target: opts.target, title: opts.title, body: opts.body, source: opts.source, context, ...(opts.lane ? { lane: opts.lane } : {}) });
    return { id: rec.id };
  },

  /** the lane's follow-up Issue drafts, read only: the text as penne would see it (the rewrite when there is one) */
  laneFollowupDrafts(iddId) {
    return listOutbound()
      .filter((r) => r.kind === "gh-issue" && r.lane === iddId && r.status !== "discarded")
      .map((r) => ({ id: r.id, title: r.rewrittenTitle ?? r.title, body: r.rewritten ?? r.draft, status: r.status, ...(r.posted?.url ? { url: r.posted.url } : {}) }));
  },

  outboundStatus(id) {
    const rec = readOutbound(id);
    return rec ? { status: rec.status, ...(rec.target.event ? { event: rec.target.event } : {}), ...(rec.posted?.url ? { url: rec.posted.url } : {}) } : null;
  },

  /** the landing's signed close: the one-liner is posted at once, and only a failure stays as a card */
  async postOutbound(opts) {
    const rec = await postOutboundNow({ kind: opts.kind, target: opts.target, title: opts.title, body: opts.body, source: opts.source, noRewrite: true });
    return {
      id: rec.id,
      status: rec.status === "posted" ? "posted" as const : "failed" as const,
      ...(rec.posted?.url ? { url: rec.posted.url } : {}),
      ...(rec.error ? { error: rec.error } : {}),
    };
  },

  /** a batch landing's conflict: the `land-resolver` role judges it once with no tools; the batch takes only an answer that grounds every file */
  resolveLandConflict(input) {
    return resolveLandConflict(input);
  },

  async draftPrText({ repo, material, lane, revise }) {
    // the text the lane's agent handed over at `gh pr create` is the draft: a writer is not asked to replace what a
    // person is about to read as the agent's own. A rewrite of a PR that is already up is a different question.
    // The public base is resolved once: the section a writer is shown, the headings a draft is checked against, and
    // the headings the agent's own text is checked against come from the same commit
    const held = !revise && lane ? heldPrText(lane) : null;
    const at = pointedRules(repo, "pr");
    // the hash of the section read is recorded with the draft, so the card's first check can say the rule moved since
    if (held) {
      const root = at ? repoByGithub(repo).clone : "";
      return { ...pointedHeldPr(root, held, at), model: AGENT_DRAFT, ...sectionsRead(root, "pr", at) };
    }
    const r = repoByGithub(repo);
    const template = pointedPrTemplate(r.clone, at);
    const context = publicWritingContext(r.clone, { kind: "pr", repo, ...(at ? { conventions: at.conventions, base: at.base } : {}), ...(r.language ? { language: r.language } : {}) });
    return { ...await draftPr(material, context, { repo, ...(at?.conventions.pr ? { pointed: true } : {}), ...(revise ? { revise: true } : { template: template === undefined ? prTemplate(r.clone) : template }), ...(lane ? { lane } : {}) }), ...sectionsRead(r.clone, "pr", at) };
  },

  /** the pipeline's pi roles, with the model and thinking roles.yaml gives them: what the canary watches */
  canaryRoles() {
    return pipelineCanaryRoles();
  },

  /** one canary question, one shot: the role's own model, thinking and agent dir, no tools and no session */
  async canaryRun({ role, modelName, task, timeoutMs }) {
    return runCanaryQuestion({ role, ...(modelName ? { modelName } : {}), prompt: task.prompt, timeoutMs, agentDir: canaryAgentDir(role, modelName) });
  },

  /**
   * a canary role's agent dir, readied in a child as a conversation's is: preparing it in this process would run
   * pi's catalog synchronously and freeze every other conversation while it does
   */
  canaryPrepare({ role, modelName }) {
    return prepareAgentDirAsync(role, modelName);
  },

  /** the judge's role and model; null while roles.yaml leaves `pipeline.question_routing` out */
  questionRouting() {
    return questionRoutingRole();
  },

  /**
   * One shot of the judge in a child process with read-only tools. Its agent dir is readied in a child too, so this
   * process's loop is never held while the model works; a failure is thrown and core leaves the batch to a person.
   */
  async routeQuestions(call) {
    const on = questionRoutingRole();
    if (!on) throw new Error("pipeline.question_routing が roles.yaml にありません");
    await prepareAgentDirAsync(on.role);
    const role = resolveRole(on.role);
    return runQuestionRouter(call, pipelineAgentDir(role));
  },

  /** the judge's answers were recorded: the planner's word waits for a tick to be delivered */
  kickTick() {
    kickTickAfterRecord();
  },

  /** a push's commit message, after the commit rules the public clone writes and its recent commits on the public base */
  async draftCommitMessage({ repo, material, lane }) {
    const r = repoByGithub(repo);
    // the public base is resolved once, as the PR's is: the section the writer is shown and the hash recorded with the draft come from the same commit
    const at = pointedRules(repo, "commit");
    const base = at ? at.base : r.remote ? `${r.remote}/${r.base}` : r.base;
    const context = publicWritingContext(r.clone, { kind: "commit", repo, base, ...(at ? { conventions: at.conventions } : {}), ...(r.language ? { language: r.language } : {}) });
    return { ...await draftCommit(material, context, { repo, ...(at ? { pointed: true } : {}), ...(lane ? { lane } : {}) }), ...sectionsRead(r.clone, "commit", at) };
  },

  async sessionCost(sessionId: string): Promise<number> {
    if (isConversation(sessionId)) return conversationCost(sessionId);
    const file = resolveSessionFile(sessionId);
    if (!file) return 0;
    let total = 0;
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.includes('"assistant"')) continue;
      try {
        const e = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
        if (e.type === "message" && e.message?.role === "assistant") total += Number(e.message.usage?.cost?.total ?? 0) || 0;
      } catch { /* a partial line */ }
    }
    return total;
  },

  /** a cheap stat of the file a session's cost is read from, so an unchanged record is not parsed again */
  sessionRecordFingerprint(sessionId: string): string | null {
    if (isConversation(sessionId)) return conversationCostFingerprint(sessionId);
    const file = resolveSessionFile(sessionId);
    if (!file) return null;
    try {
      const s = statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  },

  /** a session's spend split by the JST day each reply was written (a pi session's assistant lines carry a time) */
  sessionDailyCost(sessionId: string): { cost: number; daily: { day: string; cost: number }[] } | null {
    if (isConversation(sessionId)) {
      const r = conversationCostReading(sessionId);
      if (r.fingerprint === null && !r.cost && !r.daily.length) return null;
      return { cost: r.cost, daily: r.daily };
    }
    const file = resolveSessionFile(sessionId);
    if (!file) return null;
    const daily = new Map<string, number>();
    let total = 0;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes('"assistant"')) continue;
        try {
          const e = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
          if (e.type !== "message" || e.message?.role !== "assistant") continue;
          const cost = Number(e.message.usage?.cost?.total ?? 0) || 0;
          total += cost;
          const day = jstDay(e.timestamp ?? "");
          if (cost && day) daily.set(day, (daily.get(day) ?? 0) + cost);
        } catch { /* a partial line */ }
      }
    } catch {
      return null;
    }
    return { cost: total, daily: [...daily].map(([day, cost]) => ({ day, cost })).sort((a, b) => a.day.localeCompare(b.day)) };
  },

  async sessionStatus(sessionId: string): Promise<SessionStatus> {
    if (isConversation(sessionId)) return conversationStatus(sessionId);
    const file = resolveSessionFile(sessionId);
    if (!file) return { state: "unknown" };
    return sessionStopFrom(await readFile(file, "utf8"));
  },

  /** the engine's own conversations are what it knows to be busy; the GUI's in-process sessions are its own */
  cwdBusy(cwd: string): boolean {
    return conversationBusyAt(cwd);
  },

  /** a claude conversation waiting for the subscription's windows: start its supervisor once they allow it */
  async wakeSession(sessionId: string): Promise<boolean> {
    return isConversation(sessionId) ? wakeConversation(sessionId) : false;
  },

  async deliver(sessionId: string, text: string, opts?: { cwd?: string; type?: string }): Promise<void> {
    // queued for the conversation's supervisor, which sends it after the reply that may be running
    if (isConversation(sessionId)) {
      deliverToConversation(sessionId, text, opts?.type);
      return;
    }
    // a planner / executor session from before the switch-over: take it over into a conversation lane outside
    // this process and queue the message there; this process never starts pi
    if (isSupervisedPipelineSession(sessionId)) {
      const file = resolveSessionFile(sessionId);
      adoptPipelineConversation(sessionId, { ...(opts?.cwd ? { cwd: opts.cwd } : {}), ...(file ? { sessionFile: file } : {}) });
      deliverToConversation(sessionId, text, opts?.type);
      return;
    }
    // anything else is neither this engine's conversation nor a pipeline session it may adopt: starting pi here
    // would put the agent inside the engine's process
    throw new Error(`この session は engine のものではありません（pi を起こしません）: ${sessionId}`);
  },
};

export function ensureAgentRunner(): void {
  // read the registration itself: a flag kept here says "installed" for good after a test (or a restart of the port)
  // takes the runner away again, and the next caller then finds no writer to ask
  if (getAgentRunner() === runner) return;
  setAgentRunner(runner);
}
