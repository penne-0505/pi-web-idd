/**
 * The content of the approvals that can leave this machine, built once and away from the DOM.
 *
 * The kind of approval, whether the engine holds it and why, and the conditions on what penne writes come from the
 * engine's answer on the card. The view only shows whether the text now meets those conditions: the decide door and the
 * passkey challenge decide in the end (C-265-5). From the same values this module builds the exact payload
 * the engine will check a signature against, the lines the confirm shows in full, and the key that closes the
 * confirm when any of it changes. A payload is never assembled twice: the screen holds the one returned here.
 */
import type { CardOperation, LandBatchItem, OperationCondition, OutboundItem, ShipItem } from "../engine/contract";
import {
  chosenLabels,
  conditionProblem,
  confirmCommitText,
  labelChoices,
  labelSummary,
  lineDiff,
  shipConfirmKey,
  type LabelSwap,
  type ReviewEvent,
  type BlockingFailure,
  type ShipApprovalKind,
  type ShipCondition,
} from "../engine/contract";
import { WORDS } from "../strings";
import { conditionsOf, operationOf } from "./operations";

export interface ConfirmRow {
  label: string;
  value: string;
}

export interface ShipDraft {
  title: string;
  body: string;
  commitMessage: string;
}

export interface ShipApprovalView {
  kind: ShipApprovalKind;
  ready: boolean;
  why: string | null;
  /** the checks that hold the signature, when that is why: the card names each one (empty otherwise) */
  blocking: BlockingFailure[];
  /** the one operation at the primary position: the approval, the check, or none */
  primary: "approve" | "check" | "none";
  primaryLabel: string | null;
  confirmLabel: string;
  /** the button and the confirm wear the signing mark only for the approval */
  sign: boolean;
  /** the action the primary operation sends, and the payload that goes with it */
  action: string | null;
  payload: Record<string, unknown>;
  /** everything the signature covers, in full */
  confirmRows: ConfirmRow[];
  /** the identity of the confirm: any change to it closes the confirm */
  confirmKey: string;
  ask: string;
  destination: { label: string; repo: string; from: string; line: string };
  /** the full commit message the card shows (not only in the confirm); null when nothing is pushed */
  commitText: string | null;
  closeIssue: { repo: string; issue: number; comment: string } | null;
  /** the card's informing lines: push state, a gone branch, the forecast, the waiting lanes */
  lines: string[];
}

function destinationFor(item: ShipItem, kind: ShipApprovalKind): ShipApprovalView["destination"] {
  const d = WORDS.ship.destination;
  const base = { repo: item.branch.repo, from: item.branch.from };
  switch (kind) {
    case "land":
      return { ...base, label: d.land, line: `${item.land?.workBase ?? "work"} ← ${item.branch.from}` };
    case "local":
      return { ...base, label: d.local, line: WORDS.ship.destinationLine.local };
    case "new-pr":
      return { ...base, label: d.newPr, line: `${item.branch.to} ← ${item.branch.from}` };
    case "pr-only":
      return { ...base, label: d.prOnly, line: WORDS.ship.destinationLine.prOnly };
    case "push-to-pr":
      return { ...base, label: d.pushToPr, line: `PR #${item.existingPr?.number ?? "?"} へ` };
    case "record-on-pr":
      return { ...base, label: d.recordOnPr, line: WORDS.ship.destinationLine.recordOnPr };
  }
}

function askFor(item: ShipItem, kind: ShipApprovalKind): string {
  switch (kind) {
    case "land":
      return "work 側の本流へ取り込みますか";
    case "local":
      return "記録を回収してローカル完了しますか";
    case "new-pr":
      return "新しい PR として外へ出しますか";
    case "pr-only":
      return "この題名と本文で PR を作りますか";
    case "push-to-pr":
      return `PR #${item.existingPr?.number ?? "?"} に push しますか`;
    case "record-on-pr":
      return `PR #${item.existingPr?.number ?? "?"} への push を記録しますか`;
  }
}

function approvalLabel(kind: ShipApprovalKind): string {
  const p = WORDS.card.primary.ship;
  switch (kind) {
    case "land":
      return p.land;
    case "local":
      return p.local;
    case "pr-only":
      return p.prOnly;
    case "push-to-pr":
      return p.pushToPr;
    case "record-on-pr":
      return p.recordOnPr;
    case "new-pr":
      return p.newPr;
  }
}

/** the same values the current GUI starts the card with: the checked text, or the drafted default */
export function shipDraftFor(item: ShipItem): ShipDraft {
  const body = item.pr.draftBody ?? item.pr.body.map((b) => `- ${b.text}`).join("\n");
  return {
    title: item.proposal?.pr.title ?? item.pr.title,
    body: item.proposal?.pr.body ?? body,
    // the message the card starts from is the head's draft; a PR's title waiting for the draft is not a commit message,
    // so without a draft (or a form the repo's own pattern made) it starts empty and says the draft is on its way
    commitMessage: item.commit?.draft ?? item.commit?.start ?? (item.pushed ? item.proposal?.commitMessage : undefined) ?? "",
  };
}

/**
 * The submit card's approval: what it would send, whether it can be given, why not, and the operation at the right
 * end. The engine's answer names the approval, holds it, and lists the conditions on the text; the view shows whether
 * what is written now meets them. When the approval cannot be given but the engine offers a check, the right end is
 * the check (the approval first: a card whose approval is ready must never be pinned to the check).
 */
export function buildShipApproval(item: ShipItem, draft: ShipDraft, now: number = Date.now()): ShipApprovalView {
  const op = operationOf(item, "approve");
  const checkOp = operationOf(item, "check");
  const kind = (op?.variant as ShipApprovalKind | undefined) ?? "new-pr";
  let why: string | null = null;
  let blocking: BlockingFailure[] = [];
  if (!op) why = WORDS.ship.noAnswer;
  else if (op.hold) {
    why = op.hold.reason;
    blocking = op.hold.blocking ?? [];
  } else {
    const card = { title: draft.title, body: draft.body, commitMessage: draft.commitMessage };
    for (const c of conditionsOf(op)) {
      const problem = conditionProblem(c as ShipCondition, card, now);
      if (problem) {
        why = problem;
        break;
      }
    }
  }
  const ready = op !== undefined && why === null;
  const pushes = op?.sends?.commit === true;
  const makesPr = op?.sends?.pr === true;
  const approvalPayload: Record<string, unknown> = {
    ...(op?.payload ?? {}),
    ...(pushes ? { commitMessage: draft.commitMessage } : {}),
    ...(makesPr ? { pr: { title: draft.title, body: draft.body } } : {}),
  };
  const primary: ShipApprovalView["primary"] = ready ? "approve" : checkOp ? "check" : "none";
  const destination = destinationFor(item, kind);
  const close = item.land?.close ?? null;
  const commitText = pushes ? (confirmCommitText(kind, draft.commitMessage) ?? draft.commitMessage) : null;

  const confirmRows: ConfirmRow[] = [];
  const L = WORDS.ship.label;
  confirmRows.push({ label: L.destination, value: `${destination.label} · ${destination.repo} · ${destination.line}` });
  if (close) {
    confirmRows.push({ label: L.close, value: `Issue #${close.issue}（${close.repo}）` });
    confirmRows.push({ label: L.closeComment, value: close.comment });
  }
  if (pushes) confirmRows.push({ label: L.commit, value: commitText ?? draft.commitMessage });
  if (makesPr) {
    confirmRows.push({ label: L.prTitle, value: draft.title });
    confirmRows.push({ label: L.prBody, value: draft.body });
  }
  if (kind === "local") confirmRows.push({ label: L.local, value: "記録を回収してローカル完了する（push も PR も作成しません）" });

  const lines: string[] = [];
  if (item.pushHeld) lines.push(item.pushHeld);

  const token = item.proposal?.token ?? item.land?.token;
  return {
    kind,
    ready,
    why: ready ? null : why,
    blocking: ready ? [] : blocking,
    primary,
    primaryLabel: primary === "check" ? WORDS.card.primary.ship.check : approvalLabel(kind),
    confirmLabel: primary === "check" ? WORDS.card.primary.ship.check : approvalLabel(kind),
    // the button and the confirm wear the signing mark only when the engine says the approval is signed
    sign: primary === "approve" && op !== undefined && op.signature !== "none",
    action: primary === "approve" ? (op?.action ?? null) : primary === "check" ? (checkOp?.action ?? null) : null,
    payload: primary === "approve" ? approvalPayload : primary === "check" ? { ...(checkOp?.payload ?? {}), pr: { title: draft.title, body: draft.body } } : {},
    confirmRows,
    // the engine's key covers the card's destination, close and the operation; the draft is what the person wrote
    confirmKey: `${op?.confirmKey ?? ""}:${shipConfirmKey({ token, kind, commitMessage: draft.commitMessage, title: draft.title, body: draft.body })}`,
    ask: askFor(item, kind),
    destination,
    commitText,
    closeIssue: close ? { repo: close.repo, issue: close.issue, comment: close.comment } : null,
    lines,
  };
}

/** which lanes penne took off the batch card; a lane taken off is not in the signed content (C-247-1, C-247-2) */
export interface BatchDraft {
  off: ReadonlySet<string>;
}

export function batchDraftFor(): BatchDraft {
  return { off: new Set<string>() };
}

export interface BatchApprovalView {
  /** the lanes left on the card, in the card's order: exactly what the signature names */
  kept: string[];
  ready: boolean;
  why: string | null;
  /** the approval is a signature (the CLI reads this the way it reads a submit card's) */
  sign: boolean;
  primary: "approve" | "none";
  primaryLabel: string;
  /** the engine's operation names the action; empty when its answer names none */
  action: string;
  payload: Record<string, unknown>;
  confirmRows: ConfirmRow[];
  confirmKey: string;
}

/** the lanes an operation offered that the person left on, under the field the operation names */
function lanesPayload(op: CardOperation | undefined, draft: BatchDraft): Record<string, unknown> {
  if (op?.input.kind !== "lanes") return {};
  return { [op.input.field]: op.input.offered.filter((l) => !draft.off.has(l.iddId)) };
}

/**
 * The batch card's approval: one signature over the lanes left on it. The payload names the work clone, its branch
 * and the lanes kept; the challenge and the decision both rebuild the signed content from the engine's own reading
 * of those lanes, so the content shown in the confirm rows is the one signed.
 */
export function buildBatchApproval(item: LandBatchItem, draft: BatchDraft): BatchApprovalView {
  const kept = item.lanes.filter((l) => !draft.off.has(l.iddId));
  const running = Boolean(item.running);
  const settled = Boolean(item.settled);
  const op = operationOf(item, "approve");
  // the engine holds the approval while a signed batch of this mainline is under way or the batch has ended; the lanes
  // left on the card are the condition on what the person has switched
  const held = op === undefined || Boolean(op.hold);
  const ready = !held && kept.length > 0;
  const rows: ConfirmRow[] = [
    { label: WORDS.batch.confirm.destination, value: `${WORDS.batch.destination} · ${item.repoName || item.repo} · ${item.workBase}` },
  ];
  for (const lane of kept) {
    rows.push({ label: WORDS.batch.confirm.lanes, value: `${lane.iddId} ${lane.title} · ${lane.head.slice(0, 9)}${lane.close ? ` · Issue #${lane.close.issue}（${lane.close.repo}）を閉じる` : ""}` });
    if (lane.close) rows.push({ label: WORDS.ship.label.closeComment, value: lane.close.comment });
  }
  const left = item.lanes.filter((l) => draft.off.has(l.iddId));
  if (left.length) rows.push({ label: WORDS.batch.confirm.off, value: left.map((l) => l.iddId).join(", ") });
  return {
    kept: kept.map((l) => l.iddId),
    ready,
    why: running ? WORDS.batch.running(WORDS.batch.phase[item.running!.phase] ?? item.running!.phase) : settled ? WORDS.batch.settled : op?.hold ? op.hold.reason : kept.length === 0 ? WORDS.card.primary.batchNone : null,
    sign: op !== undefined && op.signature !== "none",
    primary: ready ? "approve" : "none",
    primaryLabel: running ? WORDS.card.primary.batchRunning : WORDS.card.primary.batch,
    action: op?.action ?? "",
    // the lanes are the operation's own input: the person takes some off and the rest go as the engine offered them
    // (each with the head and the whole close the signature is over). The screen adds no lane and no field of its own
    payload: { ...(op?.payload ?? {}), ...lanesPayload(op, draft) },
    confirmRows: rows,
    // everything the confirm rows show and the signature covers: the destination (repo, branch) and, per kept lane, its title, head and the whole close
    confirmKey: JSON.stringify({
      engine: op?.confirmKey ?? "",
      batch: item.iddId, repo: item.repo, repoName: item.repoName ?? "", workBase: item.workBase,
      // the title is a line of the confirm, so a lane whose title changed is another confirm
      lanes: kept.map((l) => [l.iddId, l.title, l.head, l.close ? [l.close.repo, l.close.issue, l.close.comment] : null]),
    }),
  };
}

export interface OutboundReplyDraft {
  ref: string;
  body: string;
  resolve: boolean;
}

export interface OutboundDraft {
  title: string;
  body: string;
  event: ReviewEvent;
  /** the labels penne unchecked; each kind of review keeps its own */
  labelsOff: ReadonlySet<string>;
  replies: OutboundReplyDraft[];
}

export interface OutboundApprovalView {
  ready: boolean;
  why: string | null;
  /** the engine's operation names the action; empty when its answer names none */
  action: string;
  payload: Record<string, unknown>;
  confirmRows: ConfirmRow[];
  confirmKey: string;
  primaryLabel: string;
  sign: boolean;
  ask: string;
  destination: { label: string; target: string; count: number | null };
  /** how many replies would be posted */
  toPost: number;
  labels: LabelSwap;
  labelLine: string | null;
  diff: { op: "same" | "del" | "add"; text: string }[];
  bodyAdds: number;
  bodyDels: number;
  bodyUnchanged: boolean;
}

/** whether what is written on an outbound card now meets a condition the engine named, and the words when it does not */
function outboundConditionProblem(condition: OperationCondition, draft: OutboundDraft): string | null {
  switch (condition.id) {
    case "replies_to_post": {
      const toPost = condition.posted.filter((posted, i) => !posted && (draft.replies[i]?.body ?? "").trim().length > 0).length;
      return toPost === 0 ? "投稿する返信がありません" : null;
    }
    case "review_body": return draft.event !== "approve" && !draft.body.trim() ? "Approve 以外は本文が要ります" : null;
    case "body_changed": {
      const diff = lineDiff(condition.baseBody, draft.body);
      const changed = draft.title.trim() !== condition.baseTitle || diff.some((l) => l.op !== "same");
      return changed ? null : "今の PR と差分がありません";
    }
    case "post_title": return draft.title.trim() ? null : "題が空です";
    default: return null;
  }
}

export function outboundDraftFor(item: OutboundItem): OutboundDraft {
  return {
    title: item.title,
    body: item.proposed,
    event: item.event ?? "comment",
    labelsOff: new Set<string>(),
    replies: (item.replies ?? []).map((r) => ({ ref: r.ref, body: r.proposed, resolve: r.resolve })),
  };
}

function outboundAsk(item: OutboundItem, toPost: number): string {
  if (isReplies(item)) return `${item.targetLabel} に ${toPost} 件返信しますか`;
  if (isReview(item)) return `${item.targetLabel} にレビューを投稿しますか`;
  if (item.outKind === "gh-pr-body") return `${item.targetLabel} の本文を更新しますか`;
  return `${item.targetLabel} として投稿しますか`;
}

export function isReview(item: OutboundItem): boolean {
  return item.outKind === "gh-pr-review";
}

export function isReplies(item: OutboundItem): boolean {
  return item.outKind === "gh-pr-replies";
}

/**
 * The outbound card's approval: what it would post, whether it can be posted, why not, and the confirm's lines.
 * A reply that is already posted is not posted again and does not count.
 */
export function buildOutboundApproval(item: OutboundItem, draft: OutboundDraft): OutboundApprovalView {
  const review = isReview(item);
  const replies = isReplies(item);
  const bodyKind = item.outKind === "gh-pr-body";
  const labels = review ? chosenLabels(labelChoices(item.labelRules, draft.event, draft.labelsOff)) : { remove: [], add: [] };
  const labelLine = review ? labelSummary(labels) : null;
  const diff = bodyKind ? lineDiff(item.baseBody ?? "", draft.body) : [];
  const bodyAdds = diff.filter((l) => l.op === "add").length;
  const bodyDels = diff.filter((l) => l.op === "del").length;
  const titleChanged = bodyKind && draft.title.trim() !== (item.baseTitle ?? "");
  const bodyUnchanged = bodyKind && !titleChanged && bodyAdds === 0 && bodyDels === 0;
  const parts = replies ? (item.replies ?? []).map((r, i) => ({ ref: r.ref, body: draft.replies[i]?.body ?? r.proposed, resolve: (draft.replies[i]?.resolve ?? r.resolve) === true })) : [];
  const toPost = replies
    ? (item.replies ?? []).filter((r, i) => !r.posted && (draft.replies[i]?.body ?? "").trim().length > 0).length
    : 0;

  // the engine names the conditions on the text; the view says whether what is written now meets the first that fails
  const op = operationOf(item, "approve");
  let why: string | null = op === undefined ? WORDS.ship.noAnswer : op.hold ? op.hold.reason : null;
  if (why === null) {
    for (const c of conditionsOf(op)) {
      const problem = outboundConditionProblem(c, draft);
      if (problem) {
        why = problem;
        break;
      }
    }
  }

  const payload: Record<string, unknown> = {
    ...(op?.payload ?? {}),
    title: draft.title,
    body: draft.body,
    ...(review ? { event: draft.event, labels } : {}),
    ...(replies ? { parts } : {}),
  };

  const confirmRows: ConfirmRow[] = [{ label: WORDS.outbound.label.destination, value: item.targetLabel }];
  if (replies) {
    for (const part of parts) {
      if (!part.body.trim()) continue;
      confirmRows.push({ label: WORDS.outbound.label.reply(part.ref), value: part.body });
      confirmRows.push({ label: WORDS.outbound.label.resolve, value: part.resolve ? "Resolve する" : "開いたまま" });
    }
  } else {
    confirmRows.push({ label: WORDS.outbound.label.title, value: draft.title });
    confirmRows.push({ label: WORDS.outbound.label.body, value: draft.body });
    if (review) {
      confirmRows.push({ label: WORDS.outbound.label.event, value: WORDS.outbound.events[draft.event] });
      confirmRows.push({ label: WORDS.outbound.label.labels, value: labelLine ?? "付け替えない" });
    }
  }

  return {
    ready: why === null,
    why,
    action: op?.action ?? "",
    payload,
    confirmRows,
    confirmKey: `${op?.confirmKey ?? ""}:${JSON.stringify([draft.title, draft.body, draft.event, labels, parts])}`,
    primaryLabel: WORDS.card.primary.outbound,
    sign: op !== undefined && op.signature !== "none",
    ask: outboundAsk(item, toPost),
    destination: {
      label: WORDS.outbound.destination[item.outKind],
      target: item.targetLabel,
      count: replies ? toPost : null,
    },
    toPost,
    labels,
    labelLine,
    diff,
    bodyAdds,
    bodyDels,
    bodyUnchanged,
  };
}
