// intent: DEC-650 — engine の公開面はここだけ。UI からは import の向きが常に UI → engine

export { intentRoot, stateDir } from "./paths";
export type {
  BacklogRecord, CronRunRecord, ExecutorProgress, LifecycleRecord,
  PendingAnswer, PendingQuestionBatch, PendingReview, SessionRecord,
} from "./schema/records";
export {
  readBacklog, readLatestCronRun, readLifecycle, readOpenQuestions,
  readPendingReviews, readProgress, readSessions,
} from "./ledger/read";
export { deriveStage, elapsedLabel } from "./ledger/derive";
export type { DecisionKind, LaneGroup } from "./ledger/derive";
export { parseIntent, slugOf } from "./intent/parse";
export { changedFiles, resolveWorktree } from "./worktree/changed-files";
export {
  appendAnswer, appendLifecycle, applyDecision, buildEnvelope,
  queueEnvelope, questionAnsweredEnvelope,
} from "./ledger/write";
export type { DecideResult } from "./ledger/write";
