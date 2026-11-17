/**
 * What each card waits for and what can be done with it now, answered by the engine in the same response as the card.
 *
 * The screen draws the card from this answer and derives no operation from a field of the card: whether an operation
 * exists, whether it is held and why, what it needs from the person, what it sends and how it is signed are decided
 * here, in one place (C-265-1, C-265-2). The words, places and keys of the operations are the screen's. The decide door
 * and the passkey challenge stay the last gate: this answer says what to expect, and they refuse what it should not have allowed.
 */
import { createHash } from "node:crypto";
import type {
  CardDecision, CardOperation, DecisionMaterial, InboxItem, OperationCondition, OperationInput, OperationSignature, OutboundItem, ProposalItem, ReviewItem, ShipItem, StorageItem, StuckItem,
} from "../../../../lib/idd-ui/types.ts";
import { offersCheck, sends, shipReservation } from "../../../../lib/idd-ui/cards/ship-text.ts";
import { needsSignature } from "./action-classes.ts";

/** the signature an operation of the decide door takes, from the engine's one classification */
function signatureOf(action: string): OperationSignature {
  if (!needsSignature(action)) return "none";
  // an instruction proposal is signed by a passkey alone: a PIN is not offered for it (C-208-17)
  return action.startsWith("instruction_") ? "passkey" : "passkey_or_pin";
}

/** an operation before the engine seals it with the key of the confirm it goes through (see `decisionOf`) */
type Unsealed = Omit<CardOperation, "confirmKey">;

interface OpOptions {
  input?: OperationInput;
  hold?: string;
  irreversible?: boolean;
  keepsCard?: boolean;
  conditions?: OperationCondition[];
  extra?: Partial<Unsealed>;
}

function decide(id: string, action: string, payload: Record<string, unknown>, o: OpOptions = {}): Unsealed {
  return {
    id,
    door: "decide",
    action,
    payload,
    input: o.input ?? { kind: "none" },
    ...(o.hold ? { hold: { reason: o.hold } } : {}),
    ...(o.conditions?.length ? { conditions: o.conditions } : {}),
    signature: signatureOf(action),
    irreversible: o.irreversible ?? false,
    ...(o.keepsCard ? { keepsCard: true } : {}),
    ...o.extra,
  };
}

const text = (field: string, required: boolean): OperationInput => ({ kind: "text", field, required });

/**
 * The stuck card's note line with the choices that ride it: the weight and handling of each finding the last judgement
 * accepted (`corrections`, with whether the fix takes each handling), and for a reversal the side or boundary settled (`boundaries`). They are declared here, so a screen
 * sends exactly these fields and the key of a confirm moves with the findings and reversals offered.
 */
function noteWith(item: StuckItem, required: boolean, withBoundaries: boolean): OperationInput {
  return {
    kind: "text",
    field: "note",
    required,
    ...(item.accepted?.length ? { corrections: { field: "corrections", findings: item.accepted } } : {}),
    ...(withBoundaries && item.oscillations?.length ? { boundaries: { field: "boundaries", reversals: item.oscillations.map((o) => ({ ref: o.ref, claim: o.claim, ...(o.path ? { path: o.path } : {}), priorRef: o.priorRef, prior: o.prior, current: o.current })) } } : {}),
  };
}

/** put the card off for a while: the engine's snooze, shared by every screen */
const later = (): Unsealed => ({ id: "later", door: "snooze", action: "", payload: {}, input: { kind: "none" }, signature: "none", irreversible: false });

function questionOps(item: Extract<InboxItem, { kind: "question" }>): Unsealed[] {
  return [decide("answer", "answer", { iddId: item.iddId, batchId: item.batchId }, { input: { kind: "answer" } }), later()];
}

function goOps(item: Extract<InboxItem, { kind: "go" }>): Unsealed[] {
  // a dependency not landed: the engine refuses the GO, and neither screen ever offered the plan a revise while it waits
  const blocked = item.blockedBy?.reason ?? "";
  // an empty contract: the GO is not given, and the card names where the gap is (DEC-674)
  const emptyContract = item.intentPath ? "契約（決めたことと受け入れ条件）が空です。計画役に直させてから GO を出します" : "";
  const needsReason = item.planReview?.needsReason === true;
  // what the press confirms is what the person reads: the sentence, the one the planner first wrote and where it came from
  const purposes = (item.purposeProposals ?? []).map((p) => ({
    id: p.id,
    statement: p.statement,
    ...(p.name ? { name: p.name } : {}),
    ...(p.raisedStatement ? { raisedStatement: p.raisedStatement } : {}),
    ...(p.origin ? { origin: p.origin } : {}),
  }));
  const go = decide("go", "s1_go", { iddId: item.iddId }, {
    input: needsReason ? text("reason", true) : { kind: "none" },
    hold: blocked || emptyContract || undefined,
    extra: { ...(purposes.length ? { confirms: { purposes } } : {}), ...(needsReason ? { needsReason: true } : {}) },
  });
  // taking the lane off the list is answered on the GO card too: it was pressable there before the answer carried operations,
  // and neither screen may lose it (it stops the lane, and cannot be taken back). A GO waiting on a landing never had it
  const ops = [go, ...(item.blockedBy ? [] : [decide("ignore", "ignore", { iddId: item.iddId }, { irreversible: true })])];
  // a judgment on one proposed Purpose (a rewrite, a withdrawal) leaves the card where it is: the plan is sent back or the
  // GO waits for the new report (the press names the Purpose by its id)
  if (purposes.length) {
    ops.push(
      decide("purpose_restate", "purpose_restate", { iddId: item.iddId }, { input: text("statement", true), keepsCard: true }),
      decide("purpose_withdraw", "purpose_withdraw", { iddId: item.iddId }, { input: text("grounds", true), keepsCard: true }),
    );
  }
  if (!item.blockedBy) ops.unshift(decide("revise", "s1_revise", { iddId: item.iddId }, { input: text("instruction", true) }));
  return [...ops, later()];
}

/** the shapes of a stuck card, which differ in what can be done */
function stuckShape(item: StuckItem): "limit" | "budget" | "stall" | "oscillation" | "halt" | "hand" {
  if (item.halt) return "halt";
  if (item.handTurn) return "hand";
  if (item.budget) return "budget";
  if (item.stall) return "stall";
  if (item.oscillations && item.oscillations.length > 0) return "oscillation";
  return "limit";
}

function stuckOps(item: StuckItem): Unsealed[] {
  const shape = stuckShape(item);
  const lane = { iddId: item.iddId };
  const ignore = (id: "ignore" | "close") => decide(id, "ignore", lane, { irreversible: true });
  const replan = () => decide("replan", "s2_review_replan", lane);
  // the judge's recommendation is what puts "計画から考え直す" beside the four answers a card always had (C-252-3, C-252-6)
  const offersReplan = Boolean(item.recommendation) && (shape === "limit" || Boolean(item.onReplan));
  switch (shape) {
    case "hand": return [ignore("ignore"), decide("hand_fixed", "s2_hand_fixed", lane), later()];
    case "halt": return [
      ignore("close"),
      ...(item.halt?.canSendBack ? [decide("send_back", "s4_revise", lane, { input: text("instruction", true) })] : []),
      decide("retry", "lane_stall_resume", { ...lane, note: "" }),
      later(),
    ];
    case "budget": return [ignore("ignore"), decide("budget_extend", "lane_budget_extend", lane), later()];
    case "stall": return [ignore("ignore"), decide("resume", "lane_stall_resume", lane, { input: text("note", false) }), later()];
    case "oscillation": return [
      ignore("ignore"),
      ...(offersReplan ? [replan()] : []),
      decide("accept", "s2_review_accept", lane, { input: noteWith(item, false, false), irreversible: true }),
      decide("hand_fix", "s2_review_hand_fix", lane),
      decide("continue", "s2_review_continue", { ...lane, boundaries: [] }, { input: noteWith(item, true, true) }),
      later(),
    ];
    case "limit": return [
      ignore("ignore"),
      decide("accept", "s2_review_accept", lane, { input: noteWith(item, false, false), irreversible: true }),
      decide("hand_fix", "s2_review_hand_fix", lane),
      ...(offersReplan ? [replan()] : []),
      decide("continue", "s2_review_continue", { ...lane, boundaries: [] }, { input: noteWith(item, false, true) }),
      later(),
    ];
  }
}

function proposalOps(item: ProposalItem): Unsealed[] {
  if (item.proposalKind.startsWith("instruction_")) {
    // an instruction belongs to no repo: its answers go to the user's own door, signed by a passkey (C-208-17)
    return [
      decide("approve", "instruction_approve", { proposal: item.proposalId }, { irreversible: true }),
      decide("reject", "instruction_reject", { proposal: item.proposalId }, { input: text("reason", true), irreversible: true }),
      later(),
    ];
  }
  return [
    decide("approve", "proposal_approve", { repo: item.repo, proposal: item.proposalId }, { irreversible: true }),
    decide("reject", "proposal_reject", { repo: item.repo, proposal: item.proposalId }, { input: text("reason", true), irreversible: true }),
    later(),
  ];
}

function shipOps(item: ShipItem): Unsealed[] {
  const reservation = shipReservation(item, item.pr.vocabAllow ?? []);
  const token = item.proposal?.token ?? item.land?.token;
  const send = sends(reservation.kind);
  const approve = decide("approve", "s4_verify_clean", { iddId: item.iddId, token }, {
    input: { kind: "draft" },
    irreversible: true,
    conditions: reservation.conditions,
    extra: {
      sends: send,
      variant: reservation.kind,
      ...(reservation.hold ? { hold: { reason: reservation.hold.why, ...(reservation.hold.blocking?.length ? { blocking: reservation.hold.blocking } : {}) } } : {}),
    },
  });
  // the check is offered while the approval cannot be given (a ready approval comes first), by the card's own record
  const check = offersCheck(item, false)
    ? [decide("check", "s4_prepare", { iddId: item.iddId }, { input: { kind: "draft" }, keepsCard: true, extra: { sends: { commit: false, pr: true } } })]
    : [];
  return [
    approve,
    ...check,
    decide("revise", "s4_revise", { iddId: item.iddId }, { input: text("instruction", true) }),
    decide("sub_todo", "s4_sub_todo", { iddId: item.iddId }, { input: text("instruction", true) }),
    later(),
  ];
}

function batchOps(item: Extract<InboxItem, { kind: "land-batch" }>): Unsealed[] {
  const phase = item.running ? `signed 済みの取り込みが進行中です（${item.running.phase}）` : "";
  const hold = phase || (item.settled ? "この取り込みは終わっています" : "");
  return [
    decide("approve", "land_batch_approve", { batch: item.iddId, repo: item.repo, workBase: item.workBase }, {
      // the lanes the signature may name are the operation's own: the screen leaves some of them off and sends the rest as they are
      input: { kind: "lanes", field: "lanes", offered: item.lanes.map((l) => ({ iddId: l.iddId, head: l.head, close: l.close ?? null })) },
      irreversible: true,
      hold: hold || undefined,
      conditions: [{ id: "lanes_kept" }],
    }),
    later(),
  ];
}

function outboundOps(item: OutboundItem): Unsealed[] {
  const conditions: OperationCondition[] = [];
  if (item.outKind === "gh-pr-replies") conditions.push({ id: "replies_to_post", posted: (item.replies ?? []).map((r) => r.posted) });
  else if (item.outKind === "gh-pr-review") conditions.push({ id: "review_body" });
  else {
    if (item.outKind === "gh-pr-body") conditions.push({ id: "body_changed", baseTitle: item.baseTitle ?? "", baseBody: item.baseBody ?? "" });
    conditions.push({ id: "post_title" });
  }
  return [
    decide("discard", "outbound_discard", { iddId: item.iddId }, { irreversible: true }),
    decide("approve", "outbound_approve", { iddId: item.iddId }, { irreversible: true, conditions, input: { kind: "draft" } }),
    later(),
  ];
}

/**
 * What the review card offers is what the ledger records as the same thing. `s3_ok` moves the lane to the signature,
 * `s3_reject` with `s2_retry` sends it back to the implementation and with `s1_rethink` back to the plan: the ledger writes
 * the word the card sends as the row's `next_stage` and the stage derivation reads that row, so the card and the lane agree.
 */
function reviewOps(item: ReviewItem): Unsealed[] {
  const lane = { iddId: item.iddId };
  return [
    decide("ok", "s3_ok", lane, { irreversible: true, hold: unreadReason(item) || undefined }),
    decide("reject_retry", "s3_reject", { ...lane, nextStage: "s2_retry" }, { input: text("feedback", true) }),
    decide("reject_rethink", "s3_reject", { ...lane, nextStage: "s1_rethink" }, { input: text("feedback", true) }),
    later(),
  ];
}

/**
 * Why the verdict "ok" cannot be given over this material, or "": the card must show every changed file's diff before the
 * lane passes. A base that could not be read, or a file whose diff git could not give, leaves changes no one has read, and a
 * cut at the file limit does not (the card says how many files and where the whole is read). Sending it back stays open.
 */
function unreadReason(item: ReviewItem): string {
  const fix = "lane の worktree と base を直して画面を更新すると、差分が読めて承認できます。直せないときは「実装へ戻す」で送り返せます";
  if (item.diffFiles === undefined) return `差分を読めていません（${item.baseNote ?? "lane の base か worktree を読めません"}）。${fix}`;
  const unread = (item.diffs ?? []).filter((d) => d.unread);
  if (unread.length) return `差分を読めていない file があります（${unread.map((d) => d.file).join(", ")}: ${unread[0].unread}）。${fix}`;
  if (item.diffFiles.length > 0 && !item.diffs?.length) return `変更した file の差分が届いていません。${fix}`;
  return "";
}

function granularityOps(item: Extract<InboxItem, { kind: "granularity" }>): Unsealed[] {
  const lane = { iddId: item.iddId };
  const over = `子が上限（${item.proposal.limit} 本）を超えています。切り直しに返してください`;
  return [
    decide("approve", "granularity_approve", lane, { irreversible: true, hold: item.proposal.approvable ? undefined : over }),
    decide("reslice", "granularity_reslice", lane, { input: text("instruction", false) }),
    decide("single", "granularity_single", lane),
    decide("revise", "granularity_revise", lane, { input: text("instruction", true) }),
    later(),
  ];
}

function reloadOps(item: Extract<InboxItem, { kind: "reload" }>): Unsealed[] {
  // waiting on requests only their handlers can finish: cutting one by hand is the accident a hand restart is, so there is no operation
  if (item.waiting === "requests") return [later()];
  return [{ id: "reload", door: "reload", action: "", payload: {}, input: { kind: "none" }, signature: "none", irreversible: true }, later()];
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}G`;
const row = (key: string, value: string | number | undefined | null): DecisionMaterial[] => (value === undefined || value === null || value === "" ? [] : [{ key, value: String(value) }]);

function storageMaterial(item: StorageItem): DecisionMaterial[] {
  return [
    ...row("free", `${gb(item.freeBytes)} / ${gb(item.totalBytes)}`),
    ...row("threshold", `${item.minFreeGb}G`),
    ...row("top_places", item.topPlaces.map((p) => `${p.label} ${gb(p.bytes)}`).join(" / ")),
    ...row("candidates", `${item.candidateCount} (${gb(item.candidateBytes)})`),
    ...row("held_lanes", item.heldLanes.join(", ")),
    ...(item.cleanup ? [] : row("cleanup_off", item.offNote ?? "off")),
    ...(item.archive && !item.archive.visible ? row("archive_hidden", item.archive.dir) : []),
  ];
}

/** how many lines of one side of a diff the material carries; the rest is counted, so the card never reads as if it showed all */
const DIFF_LINES = 200;

const CRITERION_STATE: Record<"done" | "doing" | "todo", string> = { done: "済", doing: "途中", todo: "未着手" };

function diffSide(key: string, lines: { marker?: "+" | "-" | null; code: string; lineNo?: string }[], omitted: number, whole: string): DecisionMaterial[] {
  if (!lines.length) return [];
  const shown = lines.slice(0, DIFF_LINES).map((l) => `${l.lineNo ? `${l.lineNo} ` : ""}${l.marker ?? " "} ${l.code}`);
  const left = Math.max(0, lines.length - DIFF_LINES) + omitted;
  // a cut file says how much is left and where the whole of it is read, so the cut never reads as the file
  if (left > 0) shown.push(`… あと ${left} 行（全文は ${whole}）`);
  return row(key, shown.join("\n"));
}

/** where the whole of a file the card cut is read: the lane's branch and the file's path */
function wholeOf(item: ReviewItem, file: string): string {
  return item.diffBranch ? `${item.diffBranch} の ${file}` : `lane の branch の ${file}`;
}

/**
 * The review card's material is what the verdict rests on: each acceptance criterion with its words and state, and the
 * lines every changed file's diff changed. A verdict (ok, back to the implementation) is chosen over these, not over a
 * count of them. The files are numbered (`diff_file_N`, `diff_before_N`, `diff_after_N`), so the card is read one file at
 * a time and moves to the next inside itself (DEC-703).
 */
function reviewMaterial(item: ReviewItem): DecisionMaterial[] {
  // the lane's diff has one reading: every changed file, from the core's `laneDiffAll`. Both screens read the card's files from here
  const diffs: NonNullable<ReviewItem["diffs"]> = item.diffs ?? [];
  return [
    ...row("target", item.target.title),
    ...row("conflict", item.conflictWith?.title),
    ...row("base_note", item.baseNote),
    ...item.criteria.flatMap((c, i) => row(`criterion_${i + 1}`, `${c.id}（${CRITERION_STATE[c.state] ?? c.state}）${c.text}`)),
    ...(diffs.length
      ? diffs.flatMap((d, i) => [
        ...row(`diff_file_${i + 1}`, `${d.file}（${d.fileIndex}/${d.fileTotal}）`),
        ...diffSide(`diff_before_${i + 1}`, d.before, d.omitted?.before ?? 0, wholeOf(item, d.file)),
        ...diffSide(`diff_after_${i + 1}`, d.after, d.omitted?.after ?? 0, wholeOf(item, d.file)),
      ])
      : row("files", item.diffFiles?.join("\n"))),
    // more files changed than the answer carries: say so rather than read as if these were all
    ...(diffs.length && diffs[0].fileTotal > diffs.length ? row("files_omitted", `${diffs[0].fileTotal - diffs.length} file${item.diffBranch ? `（全 file は ${item.diffBranch} の差分）` : ""}`) : []),
  ];
}

function materialOf(item: InboxItem): DecisionMaterial[] {
  switch (item.kind) {
    case "review": return reviewMaterial(item);
    case "granularity": return [
      ...row("proposal", item.proposal.kind),
      ...row("reason", item.proposal.reason),
      ...(item.proposal.children ?? []).flatMap((c, i) => row(`child_${i + 1}`, `${c.title} — ${c.whole}`)),
      ...row("merge_target", item.proposal.mergeTarget ? `${item.proposal.mergeTarget.ref} ${item.proposal.mergeTarget.title ?? ""}`.trim() : ""),
    ];
    case "reload": return [
      ...row("waiting", item.waiting),
      ...row("waited_minutes", Math.max(0, Math.round(item.waitedMs / 60_000))),
      ...item.open.map((c, i) => ({ key: `conversation_${i + 1}`, value: `${c.title}${c.mode ? `（${c.mode}）` : ""}` })),
      ...item.requests.map((r, i) => ({ key: `request_${i + 1}`, value: `${r.method} ${r.path} · ${r.sending ? "sending" : "running"}` })),
    ];
    case "storage": return storageMaterial(item);
    default: return [];
  }
}

function operationsOf(item: InboxItem): Unsealed[] {
  switch (item.kind) {
    case "question": return questionOps(item);
    case "go": return goOps(item);
    case "stuck": return stuckOps(item);
    case "proposal": return proposalOps(item);
    case "ship": return shipOps(item);
    case "land-batch": return batchOps(item);
    case "outbound": return outboundOps(item);
    case "review": return reviewOps(item);
    case "granularity": return granularityOps(item);
    case "reload": return reloadOps(item);
    case "duplicate": return [
      decide("merge", "merge", { reviewId: item.reviewId }, { irreversible: true }),
      decide("anyway", "anyway_go", { reviewId: item.reviewId }),
      decide("ignore", "ignore", { reviewId: item.reviewId }, { irreversible: true }),
      later(),
    ];
    case "requeue": return [
      decide("ignore", "ignore", { iddId: item.iddId, reason: "取り込み直しを無視" }, { irreversible: true }),
      decide("requeue", "s0_requeue_go", { iddId: item.iddId }),
      later(),
    ];
    // these carry no judgement: the low-space card is switched by the settings, and a sync conflict closes at the next
    // sync once either side is back to the same value, so the only thing to do is put the card off
    case "storage":
    case "sync_conflict": return [later()];
    // a kind this engine does not know: no judgement is offered, so none can be invented for it, but the card can still be put off
    default: return [later()];
  }
}

/**
 * What a confirm over this card shows besides the operation and the material: the parts of the card the confirm's lines
 * are read from. The ship card's lines are its destination, the Issue it closes and its comment; the batch card's are the
 * lanes with their heads and closes; an outbound card's are its target and what it answers. A change in any of them is
 * a different thing to confirm.
 */
function basisOf(item: InboxItem): unknown {
  switch (item.kind) {
    // the destination line and the ask of the confirm name the open PR by its number and a landing by its work side
    case "ship": return { branch: item.branch, existingPr: item.existingPr?.number ?? null, workBase: item.land?.workBase ?? null, close: item.land?.close ?? null, token: item.proposal?.token ?? item.land?.token ?? null, pushHeld: item.pushHeld ?? null };
    // the lanes are not here: which of them stay on the signature is the person's choice, so the screen adds the kept ones
    // (each with its head and whole close) to the key, and a lane taken off does not move it (C-247-2)
    case "land-batch": return { repo: item.repo, repoName: item.repoName ?? "", workBase: item.workBase };
    // what the proposal card shows: the content now and proposed, why, and when it takes effect; a change in any of them is another proposal to confirm
    case "proposal": return { kind: item.proposalKind, handle: item.handle, reason: item.reason, before: item.before, after: item.after, from: item.from, effect: item.effect, notice: item.notice ?? null };
    case "outbound": return { target: item.targetLabel, kind: item.outKind, replies: (item.replies ?? []).map((r) => [r.ref, r.posted]) };
    default: return null;
  }
}

/**
 * The key of the confirm an operation goes through. It is the engine's, and it covers everything the engine put in front
 * of the person for this operation: the operation itself (what it names and sends, how it is held and signed, the
 * Purposes it confirms), the card's material and the lines the confirm shows. The screen adds the person's own input and
 * compares keys; a confirm opened over another key does not send (C-265-8).
 */
function confirmKeyOf(op: Unsealed, material: DecisionMaterial[], basis: unknown): string {
  // the lanes a batch offers are not in the key: which of them stay is the person's choice, so the screen adds the kept
  // ones (each with its head and whole close, which are all an offered lane holds) and a lane taken off does not move it (C-247-2)
  const sealed = op.input.kind === "lanes" ? { ...op, input: { kind: op.input.kind, field: op.input.field } } : op;
  return createHash("sha256").update(JSON.stringify([sealed, material, basis])).digest("hex").slice(0, 24);
}

/** the judgment the card waits for and the operations that answer it now */
export function decisionOf(item: InboxItem): CardDecision {
  const material = materialOf(item);
  const basis = basisOf(item);
  const operations = operationsOf(item).map((op): CardOperation => ({ ...op, confirmKey: confirmKeyOf(op, material, basis) }));
  return { waiting: item.kind, operations, material };
}

/** every card carries its decision in the response it is sent in */
export function withDecisions(items: InboxItem[]): InboxItem[] {
  return items.map((item) => {
    const decision = decisionOf(item);
    // the lines of a review's files are in its material: the card does not carry a second copy of them
    if (item.kind === "review" && item.diffs) return { ...item, diffs: undefined, decision };
    return { ...item, decision };
  });
}
