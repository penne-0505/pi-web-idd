/**
 * The submit card's PR title and body when a newer default arrives (the PR draft comes a tick later):
 * the new text replaces what is shown only while penne has not edited it.
 */
export function followDraft(
  shown: { title: string; body: string; touched: boolean },
  incoming: { title: string; body: string },
): { title: string; body: string } {
  return shown.touched ? { title: shown.title, body: shown.body } : incoming;
}

import { blockingFailures, blockingWhy } from "@idd/core/overlay/check-reason.ts";
import type { BlockingFailure, CheckLike } from "@idd/core/overlay/check-reason.ts";
import { approvedCommitMessage, commitConventionCheck, commitMessageProblem, commitSubject, commitVocabulary } from "@idd/core/plan/vocab.ts";

export { commitConventionCheck, commitMessageProblem, commitSubject };
export type { BlockingFailure };

/**
 * What the submit card says under the commit message of a push: an ID of the records or a Japanese word of the
 * workflow stops the approval (`block`); an English word of the workflow is only a warning (`warn`), since the repos'
 * own commits use such words in their own sense.
 */
export function commitVocabularyNotes(commitMessage: string, allow: string[]): { block?: string; warn?: string } {
  const { blocking, warning } = commitVocabulary(commitMessage, allow);
  return {
    ...(blocking.length ? { block: `IDD の語彙が残っています（${blocking.join(", ")}）。直すまで承認できません` } : {}),
    ...(warning.length ? { warn: `IDD の語かもしれない英単語があります（${warning.join(", ")}）。この repo の言葉として公開してよいか確かめてください（承認は止めません）` } : {}),
  };
}

/**
 * The submit card's line on the push: pushed (with what stopped the tick after it, a PR check it asks again, or
 * the PR still to make), held with its reason, or waiting for the check and penne's approval.
 */
export function pushLine(item: {
  pushed?: { branch: string; commit: string };
  pushHeld?: string;
  existingPr?: { number: number };
  prCheckFailed?: string;
  recheck?: string;
}): string {
  if (!item.pushed) return item.pushHeld ? `push を保留しています: ${item.pushHeld}` : "検査が通ると、カードで commit message を承認したときにだけ push します";
  const head = `push 済み: ${item.pushed.branch} @ ${item.pushed.commit.slice(0, 7)}。`;
  // the push's record no longer matches the destination or settings: it is checked again, not waited on
  if (item.recheck) {
    return `${head}${item.pushHeld ? `${item.pushHeld} ` : ""}この push の後に変わったもの: ${item.recheck}。この提出の記録では PR を作れないので、検査し直してください（通ると今の設定で記録し直し、PR 待ちへ戻るか PR の作成に進みます）`;
  }
  if (item.pushHeld) return head + item.pushHeld;
  if (item.existingPr && item.prCheckFailed) {
    return `${head}PR #${item.existingPr.number} の確認に失敗しました（${item.prCheckFailed}）。tick が 10 分おきに確かめ直し、確かめられたら PR 待ちへ戻ります`;
  }
  return head + (item.existingPr ? `開いている PR #${item.existingPr.number} が見つかっていません（閉じていれば、この題名と本文で PR を作り直せます）` : "PR はまだ作っていません");
}

/**
 * Whether the submit card offers its check (which pushes nothing): before the push, and after it when the push's
 * record no longer matches the destination or settings (`recheck`). A pushed submit otherwise waits for the PR's
 * approval, and a local completion ready to go is approved, not checked. A landing (a repo that does not publish)
 * offers the check by hand exactly while a blocking check has failed: the tick reuses its record while neither the
 * lane's head nor the mainline moves, so a failed check would otherwise wait for one of them to move. A landing that
 * cannot be checked now (a reason, a recorded approval waiting for the merge, an unsafe checkout) offers nothing.
 */
export function offersCheck(
  item: {
    pushed?: unknown;
    recheck?: string;
    land?: { blocking?: number; reason?: string } | null;
    landBlocked?: string;
    recordsOnly?: { reason: string };
    landChecking?: string;
    landPending?: { hold?: string };
  },
  localReady: boolean,
): boolean {
  if (localReady) return false;
  if (item.landBlocked) return false;
  // a records-only lane is refused whatever a check finds: no check is offered, the send-back is the way on
  if (item.recordsOnly) return false;
  // a check of this lane is running now: a second one would read the same tree and say nothing new (C-144-3)
  if (item.landChecking) return false;
  if (item.land !== undefined) {
    // a landing card: a failed blocking check is the one reason to run it again from the card
    const land = item.land;
    if (!land || item.landPending || land.reason) return false;
    return (land.blocking ?? 0) > 0;
  }
  return !item.pushed || Boolean(item.recheck);
}

/**
 * What a landing card's confirm says: the merge into the work side's mainline, and — when the checked record signed
 * a close — the GitHub Issue the same approval closes. Pure, so the card and its test read the same list, and the
 * confirm shows the destination and the one-liner that are in the signature.
 */
export function landConsequences(item: {
  repo: string;
  workBase?: string;
  mergeCommit?: string;
  /** the Issue the approval closes, when the record signed one */
  close?: { repo: string; issue: number };
}): string[] {
  return [
    item.repo,
    `取り込み: work 側の本流（${item.workBase ?? "work"}）へ merge commit で merge する`,
    "push も PR も作成しません",
    ...(item.close ? [`Issue #${item.close.issue} を閉じる`, `Issue の repo: ${item.close.repo}`] : []),
    "passkey の署名が要ります",
    ...(item.mergeCommit ? [`merge commit ${item.mergeCommit.slice(0, 9)}`] : []),
  ];
}

/**
 * The landing card's one line on the conflict forecast: whether the mainline conflicts now, and which card would
 * conflict if it landed first. The file names are the first few and a count for the rest. Null when no forecast was
 * taken (one card, or a stale one not shown here).
 */
export function conflictForecastLine(item: {
  conflictForecast?: {
    mainline: { conflict: boolean; files: string[] };
    others: { lane: string; conflict: boolean; files: string[] }[];
  };
}): string | null {
  const forecast = item.conflictForecast;
  if (!forecast) return null;
  const shown = (files: string[]) => `${files.slice(0, 3).join("、")}${files.length > 3 ? ` ほか ${files.length - 3} 件` : ""}`;
  const now = forecast.mainline.conflict ? `今の本流と衝突（${shown(forecast.mainline.files)}）` : "今の本流とは衝突しない";
  const hits = forecast.others.filter((o) => o.conflict);
  const others = hits.length
    ? `先に取り込むと衝突: ${hits.map((o) => `${o.lane}（${shown(o.files)}）`).join("、")}`
    : "先に取り込む card とも衝突しない";
  return `取り込みの見込み: ${now}。${others}`;
}

/**
 * The submit card's one line on the lanes waiting for this landing to go in: whose approval would release them.
 * Null when no lane waits on it (the wait was released, or none was checked).
 */
export function waitingLanesLine(item: { waitingLanes?: { lane: string; files?: string[]; rank?: number }[] }): string | null {
  const lanes = item.waitingLanes;
  if (!lanes?.length) return null;
  return `${lanes.map((l) => `${l.lane}${l.rank !== undefined ? `（${l.rank} 番目）` : " "}を待たせている`).join("、")}（先に取り込むと待ちが解ける）`;
}

/**
 * The submit card's line on a lane checked while its public branch was gone: why, and that it goes out as a new
 * branch over the public base with a new PR. Empty for any other lane.
 */
export function branchGoneLine(item: { branchGone?: { merged: boolean; pr?: number } }): string {
  const gone = item.branchGone;
  if (!gone) return "";
  const why = gone.pr === undefined
    ? "公開 branch が消えています（PR はありません）"
    : gone.merged
      ? `前の PR #${gone.pr} は merge 済みで、公開 branch が消えています`
      : `前の PR #${gone.pr} は merge されずに閉じられ、公開 branch が消えています`;
  const what = gone.merged ? "merge の後の変更" : "この lane の変更の全体";
  return `${why}。${what}を公開本流の上の新しい branch として push し、新しい PR を作ります`;
}

/**
 * What penne approves on the submit card. `record-on-pr`: a push already out to the lane's open PR whose check after
 * the push failed; the approval asks GitHub again and records the push on that PR, with no new PR and no text.
 */
export type ShipApprovalKind = "local" | "new-pr" | "push-to-pr" | "pr-only" | "record-on-pr" | "land";

/** what the card says while the commit message of the head is being drafted: a title is not a commit message */
export const COMMIT_PENDING = "commit message の下書きを作っている途中です。できると承認できます";

/** the shape of a submit record the approval's rules read (the same fields `ShipItem` carries) */
export interface ShipApprovalSource {
  proposal?: { mode: string; blocking: number; checks?: readonly CheckLike[]; pr: { title: string; body: string }; expiresAt?: string; head?: string } | null;
  pushed?: unknown;
  /** why the tick holds the push at this head: it then does not check an expired submit again */
  pushHeld?: string;
  /** the lane's head as the card was built */
  head?: string;
  existingPr?: { number: number };
  prCheckFailed?: string;
  recheck?: string;
  /** the checked landing of a lane whose repo does not publish (publish: false) */
  land?: { blocking: number; checks?: readonly CheckLike[]; head?: string; mergeCommit?: string; expiresAt?: string; reason?: string; conflict?: string[] } | null;
  landBlocked?: string;
  /** the lane adds nothing public: the engine refuses its approval, so the card offers no signature */
  recordsOnly?: { reason: string };
  /** a landing check of this lane is running in its own run: nothing is checked yet (C-144-1, C-144-8) */
  landChecking?: string;
  /** penne approved the landing and the merge has not gone in yet; `hold` is why the tick waits */
  landPending?: { hold?: string };
  /** the commit message of this head is still being drafted: its title is not one (the card says it waits) */
  commit?: { pending?: boolean };
}

/** a condition on what penne writes, which the engine names and the screen shows against the input (C-265-5) */
export type ShipCondition =
  | { id: "fresh"; until: string; why: string }
  | { id: "commit_message"; vocabAllow: string[]; pendingDraft: boolean }
  | { id: "pr_title" }
  | { id: "checked_text"; title: string; body: string };

/**
 * What in the submit card's approval does not depend on what penne writes: the kind of approval, why it is held (the
 * check, the head, records-only, a landing in force), and the conditions on the text that remain. `hold` set means no
 * input can make the approval ready. The conditions are for the screen to show; the decide door and the passkey
 * challenge decide in the end (C-265-5).
 */
export function shipReservation(
  item: ShipApprovalSource,
  vocabAllow: string[] = [],
  now: number = Date.now(),
): { kind: ShipApprovalKind; hold?: { why: string; blocking?: BlockingFailure[] }; conditions: ShipCondition[] } {
  const p = item.proposal;
  const held = (kind: ShipApprovalKind, why: string, blocking?: BlockingFailure[]) => ({ kind, hold: { why, ...(blocking?.length ? { blocking } : {}) }, conditions: [] as ShipCondition[] });
  // a repo that does not publish: the card approves the landing into the work side's mainline, not a push
  if (item.landBlocked) return held("land", item.landBlocked);
  // a lane that adds nothing public: the engine refuses its approval (after the landBlocker, in the guards' own
  // order), so the card offers no signature and says so
  if (item.recordsOnly) return held("land", item.recordsOnly.reason);
  // while a check of this head and mainline runs, there is no result to approve: the card says it waits (C-144-8)
  if (item.landChecking) return held("land", item.landChecking);
  if (item.land !== undefined) {
    // an approval is already in force and the merge is owed: the card says so instead of asking again
    if (item.landPending) {
      return held("land", item.landPending.hold ? `merge 待ちです。${item.landPending.hold}` : "merge 待ちです。承認は記録済みで、次の tick が merge します");
    }
    const land = item.land;
    if (!land) return held("land", "この head を検査中です。tick の検査が終わると承認できます");
    if (land.reason) return held("land", land.reason);
    if (land.conflict?.length) return held("land", `本流と衝突しています（${land.conflict.slice(0, 3).join(", ")}）`);
    if (item.head && land.head && land.head !== item.head) return held("land", "検査の後に lane の commit が進みました。検査し直してください");
    if (land.expiresAt && !(Date.parse(land.expiresAt) > now)) return held("land", "承認の期限が切れました。検査し直してください");
    if (land.blocking > 0) return held("land", blockingWhy(land.blocking, land.checks), blockingFailures(land.checks));
    if (!land.mergeCommit) return held("land", "検査した merge commit がありません。検査し直してください");
    return { kind: "land", conditions: land.expiresAt ? [{ id: "fresh", until: land.expiresAt, why: "承認の期限が切れました。検査し直してください" }] : [] };
  }
  const kind: ShipApprovalKind = p?.mode === "local" ? "local"
    : item.pushed ? (item.existingPr && item.prCheckFailed ? "record-on-pr" : "pr-only")
      : item.existingPr ? "push-to-pr" : "new-pr";
  if (!p) return held(kind, "まだ検査していません");
  // a check of another head than the lane's is not what would go out: the server refuses its token
  if (item.head && p.head && p.head !== item.head) return held(kind, "検査の後に lane の commit が進みました。検査し直してください");
  const conditions: ShipCondition[] = [];
  // a check waits a day for its approval; past that the server refuses its token, and the tick checks it again unless
  // it holds the push at this head
  const expired = "承認の期限が切れました。検査し直してください";
  if (!item.pushed && p.expiresAt) {
    if (!(Date.parse(p.expiresAt) > now)) return held(kind, item.pushHeld ? expired : `${expired}（tick も次の回で検査し直します）`);
    conditions.push({ id: "fresh", until: p.expiresAt, why: item.pushHeld ? expired : `${expired}（tick も次の回で検査し直します）` });
  }
  // the checks that hold the signature come before the text they were run on: a local completion with a failed check
  // is not "a different text", it is held by that check
  if (p.blocking > 0) return held(kind, blockingWhy(p.blocking, p.checks), blockingFailures(p.checks));
  if (kind === "local") {
    // local completion runs on the checked text
    return { kind, conditions: [...conditions, { id: "checked_text", title: p.pr.title, body: p.pr.body }] };
  }
  if (item.recheck) return held(kind, "push の後に設定か公開先が変わりました。検査し直してください");
  if (kind === "new-pr" || kind === "push-to-pr") conditions.push({ id: "commit_message", vocabAllow, pendingDraft: Boolean(item.commit?.pending) });
  if (kind === "new-pr" || kind === "pr-only") conditions.push({ id: "pr_title" });
  return { kind, conditions };
}

/**
 * Whether penne's input now meets a condition the engine named, and the words when it does not. The decide door and
 * the passkey challenge decide in the end, so this only says what to expect (C-265-5).
 */
export function conditionProblem(
  condition: ShipCondition,
  card: { title: string; body: string; commitMessage: string },
  now: number = Date.now(),
): string | undefined {
  switch (condition.id) {
    case "fresh": return Date.parse(condition.until) > now ? undefined : condition.why;
    case "checked_text": return condition.title === card.title && condition.body === card.body ? undefined : "検査した文面と違います。検査し直してください";
    case "commit_message":
      if (condition.pendingDraft && !card.commitMessage.trim()) return COMMIT_PENDING;
      return commitMessageProblem(card.commitMessage, condition.vocabAllow) || undefined;
    case "pr_title": return card.title.trim() ? undefined : "PR の題名が空です";
  }
}

/**
 * What the submit card's approval does and whether it can be given: the reservation the engine names, then the input
 * conditions against what is written. The old screen's card reads this one function; the new screen reads the
 * engine's answer and shows the conditions itself (C-265-7).
 */
export function shipApproval(
  item: ShipApprovalSource,
  card: { title: string; body: string; commitMessage: string; vocabAllow?: string[] },
  now: number = Date.now(),
): { kind: ShipApprovalKind; ready: boolean; why?: string; /** set when the reason is the blocking checks: the card names each of them */ blocking?: BlockingFailure[] } {
  const r = shipReservation(item, card.vocabAllow ?? [], now);
  if (r.hold) return { kind: r.kind, ready: false, why: r.hold.why, ...(r.hold.blocking?.length ? { blocking: r.hold.blocking } : {}) };
  for (const c of r.conditions) {
    const why = conditionProblem(c, card, now);
    if (why) return { kind: r.kind, ready: false, why };
  }
  return { kind: r.kind, ready: true };
}

/**
 * The submit card's key: the lane and its head, so that what penne edited on the card (the PR's text, the commit
 * message) stays with the submit it was written for, across checks of the same head, and is not carried to the next
 */
export function shipCardKey(item: { iddId: string; head?: string; proposal?: { head?: string } | null }): string {
  return `ship:${item.iddId}:${item.head ?? item.proposal?.head ?? ""}`;
}

/** whether the approval pushes a new commit (with its commit message), and whether it makes a PR (with its title and body) */
export function sends(kind: ShipApprovalKind): { commit: boolean; pr: boolean } {
  return { commit: kind === "new-pr" || kind === "push-to-pr", pr: kind === "new-pr" || kind === "pr-only" };
}

/**
 * What the submit card's open confirm is for: the check (its token) and the text the approval sends. When any of it
 * changes while the confirm is open (a commit draft that arrives, an edit, a new check at the same head), the confirm
 * closes, so that what goes out is only what penne saw in it. The card itself stays keyed by the head (`shipCardKey`):
 * the commit message penne edited is not part of the check, and a new check must not throw it away.
 */
export function shipConfirmKey(a: { token?: string; kind: ShipApprovalKind; commitMessage: string; title: string; body: string }): string {
  const what = sends(a.kind);
  return JSON.stringify([a.token ?? "", a.kind, what.commit ? a.commitMessage : null, what.pr ? a.title : null, what.pr ? a.body : null]);
}

/** the commit message the confirm of a push shows in full, as the pushed commit carries it; null when nothing is pushed */
export function confirmCommitText(kind: ShipApprovalKind, commitMessage: string): string | null {
  return sends(kind).commit ? approvedCommitMessage(commitMessage) : null;
}

/** the words of the submit card's approval: the button, and the confirm's button */
export function approvalText(approval: { kind: ShipApprovalKind }, prNumber?: number): { label: string; confirm: string } {
  switch (approval.kind) {
    case "local": return { label: "ローカル完了", confirm: "完了する" };
    case "land": return { label: "work 側の本流へ merge する", confirm: "merge する" };
    case "pr-only": return { label: "この題名と本文で PR を作る", confirm: "PR を作る" };
    case "record-on-pr": return { label: `PR #${prNumber ?? "?"} への push を確かめ直して記録する`, confirm: "確かめ直す" };
    case "push-to-pr": return { label: `この commit message で PR #${prNumber ?? "?"} に push する`, confirm: "push する" };
    default: return { label: "この commit message で push して PR を作る", confirm: "push する" };
  }
}

