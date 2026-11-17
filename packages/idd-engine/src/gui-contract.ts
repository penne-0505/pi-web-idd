/**
 * The one door the new screen reads the engine through.
 *
 * It carries the API response's types and the pure functions the engine itself uses for the same promises
 * (a snooze key, how the decks are split, whether a decision needs a signature). The bodies live under lib/idd-ui/cards/ or lib/idd-ui/,
 * never under components/ (the engine must not read the old screen's layer): this file only re-exports.
 *
 * Keep it free of node modules and of the engine's own state reading. The screen's bundle must be able to take
 * this door without taking the server's code with it, and the screen may read state only through the HTTP API.
 */

export type {
  CardDecision,
  CardOperation,
  CardText,
  CriterionState,
  DecisionMaterial,
  DuplicateItem,
  GoItem,
  IgnoredIssueView,
  InboxItem,
  LandBatchConversionView,
  LandBatchDropView,
  LandBatchItem,
  LandBatchLaneView,
  LaneDetailView,
  LaneRow,
  LaneSection,
  OperationCondition,
  OperationCorrections,
  OperationInput,
  OperationSignature,
  OutboundItem,
  PlainSummary,
  ProposalItem,
  PurposeProposalView,
  QuestionEntry,
  QuestionItem,
  QuestionOption,
  RequeueItem,
  ReviewItem,
  RiskTableRow,
  ShipItem,
  SourceRef,
  Stage,
  StallHaltView,
  StateFact,
  StuckItem,
  SyncConflictItem,
} from "../../../lib/idd-ui/types.ts";

export {
  SNOOZE_DEFAULT_MINUTES,
  inboxView,
  isSleeping,
  isSnoozed,
  sleepDue,
  snoozeKey,
} from "../../../lib/idd-ui/snooze.ts";

export { inboxKey, inboxLaneId } from "../../../lib/idd-ui/types.ts";

/**
 * The submit card's own promises, re-exported so the new screen shows an engine-named condition against the input, and
 * words the confirm, by the same functions the current GUI uses. Whether an approval exists, is held, or is signed is the
 * engine's answer on the card (`decision`), never read from here. The bodies live under lib/idd-ui/cards/ and nowhere else: this file only
 * re-exports, and none of them read a node module (checked by the screen's boundary test).
 */
export {
  COMMIT_PENDING,
  approvalText,
  branchGoneLine,
  commitConventionCheck,
  commitVocabularyNotes,
  confirmCommitText,
  conflictForecastLine,
  followDraft,
  landConsequences,
  pushLine,
  conditionProblem,
  shipCardKey,
  shipConfirmKey,
  waitingLanesLine,
} from "../../../lib/idd-ui/cards/ship-text.ts";
export type { BlockingFailure, ShipApprovalKind, ShipCondition } from "../../../lib/idd-ui/cards/ship-text.ts";
export { blockingPhrase } from "../../idd-core/src/overlay/check-reason.ts";

/** the review labels swapped with a kind of review, and the PR body's line diff, both pure */
export { chosenLabels, labelChoices, labelSummary } from "../../../lib/idd-ui/cards/review-labels.ts";
export type { LabelChoice, LabelSwap, ReviewEvent, ReviewLabelRules } from "../../../lib/idd-ui/cards/review-labels.ts";
export { lineDiff } from "../../../lib/idd-ui/cards/line-diff.ts";
export type { DiffLine } from "../../../lib/idd-ui/cards/line-diff.ts";

/**
 * A conversation's own response shapes, re-exported for the new screen. They are type-only, so the screen's
 * bundle takes no server code: the door stays free of node modules and of the engine's state reading (DEC-9181).
 * The screen must not write its own copy of these names; it reads them from here.
 */
export type {
  ContextUsage, ConversationDocument, ConversationGroup, ConversationListResult, ConversationNotice,
  ConversationModelOption, ConversationOpenState, ConversationSummary, QueueItem,
} from "./server/conversations.ts";
export type { ConversationEvent, ConversationEventType } from "./server/conversation-events.ts";

/**
 * The full-text search door's own response shapes, re-exported for the new screen's find field. They are
 * type-only, so the screen's bundle takes no server code: the search's body reads the file system at its top
 * and the screen may only read the engine through the HTTP API (DEC-9181). The screen must not write its own copy.
 */
export type { SearchHit, SearchResponse, SearchResult } from "./server/conversation-search.ts";

/**
 * The idea doors' responses, re-exported for the new screen. They stay type-only (the door is free of node
 * modules), so the screen's bundle takes no server code when it reads a gate's line or an exit's row. The screen
 * must not write its own copy of these names.
 */
export type {
  IdeaChallengeResponse, IdeaDocumentStatus, IdeaExitIssueStatus, IdeaExitRowStatus, IdeaExitSummary,
  IdeaGateResponse, IdeaGateStatus, IdeaRunOutcome, IdeaRunResponse, IdeaSectionStatus, IdeaStatusResponse,
  IdeaUnreadableStatus,
} from "./routes/idea.ts";

/**
 * The image attachment limit, re-exported so the screen refuses an image by the same function the engine's own
 * doors use (DEC-118-6). The body is a pure file with no node module, so the screen's bundle stays free of the
 * server's code (checked by the boundary test).
 */
export { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "../../../lib/image-attachments.ts";

/**
 * Today's spend, re-exported for the sidebar's one money value. The body stays where it is (DEC-9181): the
 * consumption door's answer is typed here so the screen writes no copy of it.
 */
export type { ConsumptionSummary } from "@idd/lane";

export type { HeldIssue, StartOrderLane } from "@idd/core";

/**
 * The settings sheet's own response shapes, re-exported for the new screen. They stay type-only, so the door
 * keeps no node module and the screen writes no copy of the names (DEC-9181).
 */
export type { ConversationSettings, SkillCandidate, SkillOrigin } from "./server/conversation-settings.ts";
export type { MemoryHandling, Space, SpaceInput } from "./server/spaces.ts";
export type { Candidate, Evidence, FsSpace, Kept, PlaceName, PlaceUsage, Removal, StorageView } from "@idd/core";
export type { ForecastEta, ForecastLaneView, ForecastNow, ForecastRemaining, ForecastView, StageKey, GateKey, WaitKey, StageStat, StageUsual } from "@idd/core";
export type { StageSpan } from "@idd/core";
export type { IddState } from "./server/state.ts";

/**
 * The state stream's own frame, re-exported for the new screen. It stays type-only, so the door keeps no node
 * module: the screen reads the picture through the HTTP stream and must not write its own copy of the shape.
 */
export type { StateFrameView } from "./server/state-events.ts";
export type {
  DecisionTabView, WorkAcceptanceView, WorkBundle, WorkDecisionsView, WorkDoneView, WorkFindingView, WorkFindingsView,
  WorkKind, WorkLaneView, WorkRepoView, WorkRecordView, WorkVerificationEntryView, WorkView, WorkWaitRef,
} from "../../../lib/idd-ui/work-types.ts";
