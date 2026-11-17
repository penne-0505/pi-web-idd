import type { LifecycleRecord } from "../schema/records.ts";

import {
  answerOutcome,
  orderOpponentsOf,
  passPolicy,
  roleChangedIn,
  settledHead,
  type AnswerEnv,
  type ReviewKind,
  type StuckOutcome,
} from "./review-loop-reference.ts";

/**
 * The review loop's judgements, as the TypeScript reads them.
 *
 * Nothing on the running path calls this file: the judgements come from the MoonBit fold, and this is what the
 * cross-check holds them against. Each of them takes the observations the fold would have asked for (a tree, the
 * behaviour files that changed, the lane's Risk, a trial merge), so the two sides answer from the same rows and
 * the same facts. A judgement that reads git or a process on this side would answer with the state of the
 * machine, not with the rows, and the comparison would be no comparison at all.
 */

/**
 * The last round that read the lane: the newest `s2_review_started` that is not the device check, with the head it
 * read. Written here as `plan/review-scope.ts` had it, so that no reading of this copy goes through the running
 * path's module and the comparison stays a comparison (C-206-1).
 */
function lastReviewRound(events: LifecycleRecord[]): { index: number; head: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event !== "s2_review_started" || (e.attrs?.kind ?? "blind") === "device") continue;
    const head = e.attrs?.head;
    return typeof head === "string" && head ? { index: i, head } : undefined;
  }
  return undefined;
}

/** the parts of the review policy the judgements read */
export interface JudgePolicy {
  extras: { first_round: number; high_risk: number };
  highRiskWhen: "first" | "last";
  finalExtra: "high" | "all";
  finalWhen: "always" | "behaviour";
  finalScope: "increment" | "conflict";
  orderWaitHours: number;
  orderExcludeFiles: string[];
}

/** the risk a lane reads, as the caller read it */
export interface RiskFact { risk?: boolean }

/** the tree and the behaviour files the final's skip reads */
export interface FinalFacts extends RiskFact {
  sameTree?: boolean;
  behaviour?: string[] | null;
}

/** what the final's skip decided */
export interface FinalSkip {
  kind: "settled" | "behaviour";
  settled?: string;
  since?: string;
  reason: string;
}

/**
 * Whether the final review reads this lane as High: its own Risk, or every lane under `final_extra: all`, or a
 * depth-bearing pass, whose final is the senior role's alone.
 */
export function finalHighReference(events: LifecycleRecord[], policy: JudgePolicy, risk: boolean): boolean {
  return policy.finalExtra === "all" || passPolicy(events).depth !== undefined || risk;
}

/** whether the round recorded at `index` added the high-risk role and ran to the end (no fallback stood in, no run failed) */
export function roundReadHighReference(events: LifecycleRecord[], index: number): boolean {
  const a = events[index]?.attrs ?? {};
  if (!strs(a.extras).includes("high_risk")) return false;
  // penne let the fallback run this round: it stands as one the High role read
  if (a.high_allowed === true) return true;
  if (roleChangedIn(a.fallbacks)) return false;
  const findings = events.find((e, i) => i > index && e.event === "s2_review_findings");
  // a provider-only switch keeps the same reader and counts; a role change mid-run does not
  if (roleChangedIn(findings?.attrs?.fallbacks)) return false;
  return !(Number(findings?.attrs?.failed_runs ?? 0) > 0);
}

/** whether a whole-diff round at this head was read by the high-risk role and ran to the end */
export function highReadAtReference(events: LifecycleRecord[], head: string): boolean {
  const i = events.findIndex((e) => e.event === "s2_review_started" && e.attrs?.head === head);
  return i >= 0 && roundReadHighReference(events, i);
}

/**
 * The head a whole-diff blind already read and judged within the limit, when the worktree is still at that code:
 * the final blind of it is skipped.
 */
export function finalSkipReference(events: LifecycleRecord[], policy: JudgePolicy, facts: FinalFacts): string | undefined {
  const settled = settledHead(events);
  if (!settled || !facts.sameTree) return undefined;
  if (policy.highRiskWhen === "last" && policy.extras.high_risk > 0 && finalHighReference(events, policy, facts.risk ?? false) && !highReadAtReference(events, settled)) return undefined;
  return settled;
}

/**
 * The final review is not needed under `review_final.when: behaviour` when nothing a behaviour file holds changed
 * since the last review round read the lane.
 */
export function finalNotNeededReference(events: LifecycleRecord[], policy: JudgePolicy, facts: FinalFacts): { reason: string; since: string } | undefined {
  if (policy.finalWhen !== "behaviour") return undefined;
  if (policy.highRiskWhen === "last" && policy.extras.high_risk > 0 && finalHighReference(events, policy, facts.risk ?? false)) return undefined;
  const since = lastReviewRound(events);
  if (!since) return undefined;
  const touched = facts.behaviour;
  return touched && !touched.length ? { reason: "修正が挙動のファイルに触れていないので、最後のレビューを省いた", since: since.head } : undefined;
}

/**
 * Whether the final review shows the whole diff: under `high_risk_when: last` an increment is only shown when the
 * round it starts from was read by the High role; otherwise the earlier changes have not been seen.
 */
export function wholeForUnreadReference(events: LifecycleRecord[], policy: JudgePolicy, facts: FinalFacts, head: string): boolean {
  if (policy.finalScope !== "increment") return false;
  const since = lastReviewRound(events);
  if (!since || since.head === head) return false;
  if (policy.highRiskWhen !== "last" || !policy.extras.high_risk) return false;
  return finalHighReference(events, policy, facts.risk ?? false) && !roundReadHighReference(events, since.index);
}

/**
 * Whether the final review may be skipped: the head a whole-diff blind read, or the behaviour files that did not
 * change. A depth-bearing pass always runs its last review.
 */
export function finalReviewReference(events: LifecycleRecord[], policy: JudgePolicy, facts: FinalFacts, head: string): { skip: FinalSkip | null; wholeForUnread: boolean } {
  const settled = finalSkipReference(events, policy, facts);
  if (settled) {
    return { skip: { kind: "settled", settled, reason: "差分全体を見たレビューから head が変わっていないので、最後のレビューを省いた" }, wholeForUnread: false };
  }
  const wholeForUnread = wholeForUnreadReference(events, policy, facts, head);
  if (passPolicy(events).depth !== undefined) return { skip: null, wholeForUnread };
  const unneeded = finalNotNeededReference(events, policy, facts);
  return { skip: unneeded ? { kind: "behaviour", since: unneeded.since, reason: unneeded.reason } : null, wholeForUnread };
}

/**
 * Which extra role lists a blind round adds, from the policy the round starts under.
 */
export function roundExtrasReference(events: LifecycleRecord[], policy: JudgePolicy, kind: ReviewKind, conflict: boolean, facts: RiskFact): string[] {
  const out: string[] = [];
  // a kept check and the device check add no review_blind extra
  if (kind === "kept" || kind === "device") return out;
  if (policy.extras.first_round && kind === "blind" && !conflict) out.push("first_round");
  if (policy.extras.high_risk) {
    if (policy.highRiskWhen === "last") {
      if ((kind === "final" && finalHighReference(events, policy, facts.risk ?? false)) || (conflict && (facts.risk ?? false))) out.push("high_risk");
    } else {
      const spent = kind === "final" && events.slice(passPolicy(events).start + 1).some((e) =>
        e.event === "s2_review_started" && e.attrs?.kind === "final" && strs(e.attrs?.extras).includes("high_risk"));
      if ((kind === "blind" || !spent) && (facts.risk ?? false)) out.push("high_risk");
    }
  }
  return out;
}

/** the order check's own reading: the lane's head, the lanes ahead of it, and the lane's place in the order */
export interface OrderGateArgs {
  policy: JudgePolicy;
  /** the lane's own head; the empty string when it cannot be read */
  head: string;
  /** the tick's clock */
  now: number;
  /** when the lane first came to the order judgement */
  orderAt: number;
  /** whether the lane is one the order check watches */
  inScope: boolean;
  /** the lanes that have gone ahead of this one */
  prior: { lane: string; head: string }[];
  /** the lanes ahead whose head cannot be read */
  unreadable: string[];
}

/** the trial merges git answered */
export interface OrderGateFacts {
  trialMerge?: Record<string, { conflict: boolean; files: string[] } | null>;
}

/** one record the order check leaves */
export interface OrderStep { event: string; attrs: Record<string, unknown> }

/** the order check's answer: whether the lane waits, and the records it leaves */
export interface OrderGateAnswer { wait: boolean; steps: OrderStep[] }

/** the events that record a lane's position when the check ends without a wait */
const ORDER_DETERMINED = ["s2_order_passed", "s2_order_unknown", "s2_order_limit"];

/**
 * The order check before a lane's first review: a read-only trial merge against the lanes that have gone ahead.
 * A conflict on a file that is not excluded makes the lane wait for those lanes to land.
 */
export function orderGateReference(events: LifecycleRecord[], args: OrderGateArgs, facts: OrderGateFacts): OrderGateAnswer {
  const { policy, head: ownHead, now, orderAt, inScope, prior, unreadable } = args;
  const steps: OrderStep[] = [];
  // 0 (or less) turns the whole order check off
  if (policy.orderWaitHours <= 0) return { wait: false, steps };
  // only a repo that does not publish and a lane on the work branch is ordered
  if (!inScope) return { wait: false, steps };
  if (events.some((e) => ORDER_DETERMINED.includes(e.event))) return { wait: false, steps };
  // the lane's own head cannot be read: no answer, so no wait, and the reason is left once
  if (!ownHead) {
    if (!events.some((e) => e.event === "s2_order_unknown")) steps.push({ event: "s2_order_unknown", attrs: { reason: "lane の head を読めません", order_at: orderAt } });
    return { wait: false, steps };
  }
  const waited = [...events].reverse().find((e) => e.event === "s2_order_waiting");
  const waitedOpponents = waited ? orderOpponentsOf(waited.attrs) : [];
  const waitedAt = waited ? String(waited.attrs?.since ?? waited.at) : "";
  // the limit counts from the first wait and is not reset when the opponent changes
  if (waited && waitedAt && now - Date.parse(waitedAt) >= policy.orderWaitHours * 3600_000) {
    steps.push({ event: "s2_order_limit", attrs: { since: waitedAt, head: ownHead, opponents: waitedOpponents, order_at: orderAt } });
    return { wait: false, steps };
  }
  const ownHeadAtWait = waited ? String(waited.attrs?.head ?? "") : "";
  const cached = new Map(waitedOpponents.map((o) => [o.lane, o]));
  const hits: { lane: string; head: string; files: string[] }[] = [];
  // an opponent whose head could not be read, or whose trial merge git could not answer, is not a conflict
  let unknown = unreadable.length > 0;
  for (const p of prior) {
    const known = cached.get(p.lane);
    // the head of neither side moved: the earlier trial merge still stands, and is not taken again
    if (known && ownHeadAtWait === ownHead && known.head === p.head) {
      if (known.files.length) hits.push({ lane: p.lane, head: p.head, files: known.files });
      continue;
    }
    const merge = facts.trialMerge?.[`${ownHead}|${p.head}`] ?? null;
    // a merge git could not answer is an opponent that does not conflict: the lane does not wait on it
    if (!merge) { unknown = true; continue; }
    const files = merge.conflict ? merge.files.filter((f) => !policy.orderExcludeFiles.includes(f)) : [];
    if (files.length) hits.push({ lane: p.lane, head: p.head, files });
  }
  if (!hits.length) {
    if (unknown && !events.some((e) => e.event === "s2_order_unknown")) steps.push({ event: "s2_order_unknown", attrs: { head: ownHead, opponents: [...prior, ...unreadable.map((lane) => ({ lane }))], order_at: orderAt } });
    if (waited) steps.push({ event: "s2_order_released", attrs: { since: waitedAt, head: ownHead, opponents: waitedOpponents, order_at: orderAt } });
    steps.push({ event: "s2_order_passed", attrs: { head: ownHead, order_at: orderAt } });
    return { wait: false, steps };
  }
  const changed = waited !== undefined && (ownHeadAtWait !== ownHead || hits.length !== waitedOpponents.length
    || hits.some((h) => {
      const o = cached.get(h.lane);
      return !o || o.head !== h.head || o.files.join("\u0000") !== h.files.join("\u0000");
    }));
  if (!waited || changed) {
    steps.push({ event: "s2_order_waiting", attrs: { head: ownHead, since: waited ? waitedAt : new Date(now).toISOString(), opponents: hits } });
  }
  return { wait: true, steps };
}

/** one error of the records check, as the CLI prints it */
export interface RecordsFinding { rule: string; id: string; reason: string }

/** what the records check answered */
export type RecordsCheckOutcome =
  | { outcome: "clean" }
  | { outcome: "errors"; findings: RecordsFinding[] }
  | { outcome: "unavailable"; reason: string };

/** the records check's own reading */
export interface RecordsCheckArgs {
  /** the lane's head */
  head: string;
  /** why the lane's own head or origin could not be read, or the empty string when it could */
  headError?: string;
  /** whether the repo declares a records check at all */
  hasCheck: boolean;
  /** the check's answer */
  check?: RecordsCheckOutcome;
}

/** one record the records check leaves */
export interface RecordsStep { kind: "record" | "envelope" | "verdict" | "merge_skip"; event?: string; attrs?: Record<string, unknown>; findings?: RecordsFinding[]; head?: string; skip?: Record<string, unknown> }

/** the records check's answer: the records it leaves, in the order they are written */
export interface RecordsAnswer { steps: RecordsStep[] }

/** the identity of an error the records check found: its rule and its id, not the diagnostic text */
export function findingKeysReference(findings: RecordsFinding[]): string[] {
  return findings.map((f) => `${f.rule}\u0000${f.id}`);
}

/** the rule and the id of a stored key */
export function findingIdOfReference(key: string): string {
  const parts = key.split("\u0000");
  return `${parts[0] ?? ""}\u0000${parts[1] ?? ""}`;
}

/** the keys of the errors the last records send-back carried */
export function lastSentKeysReference(events: LifecycleRecord[]): string[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event !== "s2_records_conflict") continue;
    const raw = events[i].attrs?.error_keys;
    return Array.isArray(raw) ? raw.map(String) : [];
  }
  return [];
}

/** whether every error the check just found was carried by the last records send-back */
export function sameRecordsErrorsReference(events: LifecycleRecord[], findings: RecordsFinding[]): boolean {
  const sent = lastSentKeysReference(events);
  if (!sent.length) return false;
  const ids = new Set(sent.map(findingIdOfReference));
  return findingKeysReference(findings).every((k) => ids.has(k));
}

/**
 * The records check between the review's end and S3. A clean or unanswerable check leaves the loop done. An error
 * sends the lane back to the executor once for the convergence, with the errors it found; the same errors a
 * send-back already carried are not sent again.
 */
export function recordsCheckReference(events: LifecycleRecord[], args: RecordsCheckArgs): RecordsAnswer {
  const { head, headError, hasCheck, check } = args;
  const steps: RecordsStep[] = [];
  // there is nothing to check: the head is not even read, and a skipped round still closes the review for this head
  if (!hasCheck) {
    steps.push({ kind: "verdict" });
    return { steps };
  }
  // the lane's own head or origin cannot be read: the check cannot run, and the lane goes on
  if (headError) {
    steps.push({ kind: "record", event: "s2_intent_checked", attrs: { outcome: "unavailable", reason: `検査に要る head を読めません: ${headError}` } });
    steps.push({ kind: "verdict" });
    return { steps };
  }
  if (!check || check.outcome !== "errors") {
    const outcome = check?.outcome ?? "unavailable";
    steps.push({
      kind: "record",
      event: "s2_intent_checked",
      attrs: { outcome, head, ...(outcome === "unavailable" ? { reason: (check as { reason?: string } | undefined)?.reason ?? "" } : {}) },
    });
    steps.push({ kind: "verdict", head });
    return { steps };
  }
  const findings = check.findings;
  if (sameRecordsErrorsReference(events, findings)) {
    steps.push({
      kind: "record",
      event: "s2_intent_checked",
      attrs: { outcome: "errors", sent_back: false, head, remaining: findings, reason: "前の差し戻しで送ったのと同じ error だけが残った" },
    });
    steps.push({ kind: "verdict", head });
    return { steps };
  }
  steps.push({
    kind: "record",
    event: "s2_records_conflict",
    attrs: { awaiting: true, head, errors: findings, error_keys: findingKeysReference(findings) },
  });
  steps.push({ kind: "envelope", findings });
  steps.push({ kind: "verdict", head });
  steps.push({ kind: "record", event: "s2_records_instructed", attrs: { head, errors: findings } });
  return { steps };
}

/** the recheck's own reading */
export interface RecordsRecheckArgs extends RecordsCheckArgs {
  /** the head the last send-back carried */
  from: string;
  /** the files outside the records place that changed; nothing when git cannot answer */
  changed: string[] | null;
  /** the round the mainline merge alone stands for */
  skip?: Record<string, unknown>;
}

/**
 * The step after the executor answered the records send-back: only records changed, so the check runs again
 * without a review round; code outside the records place changed, so the review's rounds run again.
 */
export function recordsRecheckReference(events: LifecycleRecord[], args: RecordsRecheckArgs): RecordsAnswer {
  const { head, headError, hasCheck, check, changed, skip } = args;
  const steps: RecordsStep[] = [];
  // the head the last send-back carried: the record the loop reads it from
  let from = "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === "s2_records_instructed") { from = String(events[i].attrs?.head ?? ""); break; }
  }
  if (!from) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].event === "s2_records_conflict") { from = String(events[i].attrs?.head ?? ""); break; }
    }
  }
  // the answer cannot be told apart from a code change: the review's rounds run again rather than being skipped
  if (headError) {
    steps.push({ kind: "record", event: "s2_records_reopened", attrs: { since_head: from, reason: `head を読めません: ${headError}` } });
    return { steps };
  }
  if (changed === null) {
    steps.push({ kind: "record", event: "s2_records_reopened", attrs: { since_head: from, head, reason: "記録の置き場の外が変わったかを git が答えられなかった" } });
    return { steps };
  }
  const skipped = !!skip && typeof skip.head === "string" && skip.head !== "";
  if (changed.length && !skipped) {
    steps.push({ kind: "record", event: "s2_records_reopened", attrs: { since_head: from, head, files: changed.slice(0, 20) } });
    return { steps };
  }
  if (!hasCheck) {
    steps.push({ kind: "record", event: "s2_intent_checked", attrs: { outcome: "clean", head } });
  } else if (check?.outcome === "errors" && !sameRecordsErrorsReference(events, check.findings)) {
    // the merge brought errors the last send-back did not carry: the executor is told
    steps.push({
      kind: "record",
      event: "s2_records_conflict",
      attrs: { awaiting: true, head, errors: check.findings, error_keys: findingKeysReference(check.findings) },
    });
    steps.push({ kind: "envelope", findings: check.findings });
    steps.push({ kind: "record", event: "s2_records_instructed", attrs: { head, errors: check.findings } });
    return { steps };
  } else {
    const outcome = check?.outcome ?? "unavailable";
    steps.push({
      kind: "record",
      event: "s2_intent_checked",
      attrs: {
        outcome, head, sent_back: false,
        ...(outcome === "unavailable" ? { reason: (check as { reason?: string } | undefined)?.reason ?? "" } : {}),
        ...(outcome === "errors" ? { remaining: (check as { findings: RecordsFinding[] }).findings, reason: "戻した後にも残った error" } : {}),
      },
    });
  }
  if (skipped) steps.push({ kind: "merge_skip", skip });
  return { steps };
}

/** the card's own reading */
export interface StuckArgs {
  /** the lane's head; the empty string when the lane cannot be read */
  head: string;
  /** whether the lane's own head and origin can be read */
  laneReadable: boolean;
  /** whether the device check is declared */
  deviceOn: boolean;
}

/**
 * The four choices the stuck card offers: what each button does, found by following the same transition the loop
 * runs.
 */
export function stuckOutcomesReference(
  events: LifecycleRecord[],
  policy: JudgePolicy,
  args: StuckArgs,
  facts: FinalFacts,
): { continue: StuckOutcome; continueWithNote: StuckOutcome; accept: StuckOutcome; handFix: StuckOutcome; replan: StuckOutcome } | undefined {
  const env: AnswerEnv = {
    // a worktree the loop cannot read makes it fail the step, never skip the final review
    skipsFinal: (evs: LifecycleRecord[]) => {
      if (!args.laneReadable) return false;
      return !!finalSkipReference(evs, policy, facts) || !!finalNotNeededReference(evs, policy, facts);
    },
    deviceOn: args.deviceOn,
  };
  const plain = answerOutcome(events, { decision: "continue", note: "" }, env);
  const noted = answerOutcome(events, { decision: "continue", note: "補足" }, env);
  const accept = answerOutcome(events, { decision: "accept", note: "" }, env);
  const handFix = answerOutcome(events, { decision: "hand_fix", note: "" }, env);
  const replan = answerOutcome(events, { decision: "replan", note: "" }, env);
  return plain && noted && accept && handFix && replan ? { continue: plain, continueWithNote: noted, accept, handFix, replan } : undefined;
}

/** the strings a value holds, as the TypeScript's `strs` reads them */
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}
