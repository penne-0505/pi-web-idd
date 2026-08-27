// intent: DEC-650 — engine の公開面はここだけ。UI からは import の向きが常に UI → engine

export { intentRoot, stateDir } from "./paths.ts";
export type {
  BacklogRecord, CronRunRecord, ExecutorProgress, LifecycleRecord,
  PendingAnswer, PendingQuestionBatch, PendingReview, SessionRecord,
} from "./schema/records.ts";
export {
  readAnswers, readBacklog, readLatestCronRun, readLifecycle, readOpenQuestions,
  readPendingReviews, readProgress, readQuestionBatch, readSessions,
} from "./ledger/read.ts";
export { deriveStage, elapsedLabel } from "./ledger/derive.ts";
export type { DecisionKind, LaneGroup } from "./ledger/derive.ts";
export { areaSegment, parseIntent, slugOf } from "./intent/parse.ts";
export { changedFiles, resolveWorktree } from "./worktree/changed-files.ts";
export {
  appendAnswer, appendLifecycle, applyDecision, buildEnvelope,
  queueEnvelope, questionAnsweredEnvelope,
} from "./ledger/write.ts";
export type { DecideResult } from "./ledger/write.ts";
export { areasPath, branchFor, githubAreas, readAreas } from "./config/areas.ts";
export type { AreaConfig, AreasFile } from "./config/areas.ts";
export { listIssues } from "./intake/github.ts";
export type { GithubIssue } from "./intake/github.ts";
export { runIntake } from "./intake/run.ts";
export type { DuplicateDetector, IntakeResult } from "./intake/run.ts";
export { agentBaseUrl, agentToken, checkAgentToken } from "./agent/token.ts";
export { getAgentRunner, setAgentRunner } from "./agent/port.ts";
export type { AgentRunner } from "./agent/port.ts";
export { countUndelivered, deliverPending, pendingEnvelopes, sessionFor } from "./agent/outbox.ts";
export type { DeliverResult, OutboxRecord, UndeliveredCount } from "./agent/outbox.ts";
export { agentAskQuestions, agentProgress, agentReady, agentResult } from "./agent/inbound.ts";
export type { AskedQuestion } from "./agent/inbound.ts";
export { ensureLaneWorktree, lanesRoot } from "./worktree/ensure.ts";
export { laneActivity, lanesAwaitingPrep, plannerBrief, plannerConcurrency, runningPlanners, runPrep } from "./plan/prep.ts";
export type { LaneActivity, PrepResult } from "./plan/prep.ts";
export { executorBrief, executorConcurrency, lanesAwaitingExec, runExec, runningExecutors } from "./plan/exec.ts";
export type { ExecResult } from "./plan/exec.ts";
export { headCommit } from "./worktree/ensure.ts";
export { resumeBrief, resumeTargetFor, runResume } from "./plan/resume.ts";
export type { ResumeTarget } from "./plan/resume.ts";
export { laneBase, laneDiff, lanesAwaitingCheck, runCheck } from "./plan/review.ts";
export type { CheckResult, LaneDiff } from "./plan/review.ts";
export { buildSubmit, lanesAwaitingShip, runShip, startSubmit } from "./plan/ship.ts";
export type { ShipResult, SubmitView } from "./plan/ship.ts";
export { lanesAwaitingMerge, removeLaneWorktree, runClose } from "./plan/close.ts";
export type { CloseResult } from "./plan/close.ts";
export { runTick } from "./plan/tick.ts";
export type { TickResult } from "./plan/tick.ts";
export { allocateBlock, highestIds } from "./intent/numbering.ts";
