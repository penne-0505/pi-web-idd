// intent: DEC-650 — engine の公開面はここだけ。UI からは import の向きが常に UI → engine

export { intentRoot, stateDir } from "./paths.ts";
export type {
  BacklogRecord, CronRunRecord, ExecutorProgress, LifecycleRecord,
  PendingAnswer, PendingQuestionBatch, PendingReview, SessionRecord,
} from "./schema/records.ts";
export {
  readBacklog, readLatestCronRun, readLifecycle, readOpenQuestions,
  readPendingReviews, readProgress, readSessions,
} from "./ledger/read.ts";
export { deriveStage, elapsedLabel } from "./ledger/derive.ts";
export type { DecisionKind, LaneGroup } from "./ledger/derive.ts";
export { parseIntent, slugOf } from "./intent/parse.ts";
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
