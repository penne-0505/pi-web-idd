import type { LifecycleRecord } from "../schema/records.ts";
import type { SubmitAnswer, SubmitStep } from "./submit-step.ts";

/**
 * The push's next step, as the TypeScript read it before the MoonBit fold took the stage over. It is not on the
 * running path (C-202-1): the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit answer
 * at every prefix of a real ledger over a set of observations, and the committed fixtures
 * (`packages/idd-core/test/submit-step.test.mjs`) hold both against each other.
 *
 * The steps are read from the lane's rows and the observations alone, so the same ledger and the same answers give
 * the same steps (C-202-3). A helper's answer is read back under the fact that step named, and the branches before
 * that step are not read again (C-202-2).
 */

const tail = (evs: LifecycleRecord[], name: string) => evs.map((e) => e.event).lastIndexOf(name);

/** the round as the stage reads it: from the lane's last submit, or its last row alone when it never started one */
function roundOf(evs: LifecycleRecord[]): LifecycleRecord[] {
  return evs.slice(tail(evs, "s4_submit_started"));
}

type Facts = Record<string, unknown>;

const at = (facts: Facts, kind: string, idd: string, extra = ""): unknown => facts[`${kind}|${idd}|${extra}`] ?? null;
const given = (value: unknown): boolean => value !== null && value !== undefined;
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

const write = (event: string, attrs: Record<string, unknown>): SubmitStep => ({ do: "write", event, attrs });
const call = (helper: string, site: string, keep: Record<string, unknown>, args: Record<string, unknown>, fatal: boolean, reread = false): SubmitStep => ({
  do: "call", helper, site, fact: `call|${helper}|${site}`, keep, args, fatal, reread,
});
const result = (field: NonNullable<SubmitStep["field"]>, id: string): SubmitStep => ({ do: "result", field, id });
const error = (id: string, text: string): SubmitStep => ({ do: "result", field: "errors", id, error: text });
const end = (): SubmitStep => ({ do: "end" });
const again = (): SubmitStep => ({ do: "again" });

/** the call's answer, when the caller has already run it */
function callAnswer(facts: Facts, helper: string, site: string): Record<string, unknown> | null {
  const id = `call|${helper}|${site}`;
  return id in facts ? obj(facts[id]) : null;
}

/** the call's failure, when the caller saw it fail */
function callError(facts: Facts, helper: string, site: string): Record<string, unknown> | null {
  const id = `err|${helper}|${site}`;
  return id in facts ? obj(facts[id]) : null;
}

/** the latest hold that stops the tick for good after the push of this head */
function stoppedAfterPush(rows: LifecycleRecord[], head: string): boolean {
  return rows.some((e) => e.event === "s4_push_held" && Boolean(e.attrs?.after_push) && String(e.attrs?.head ?? "") === head);
}

/** a hold after the push at `pushedAt` that stops the tick for good (a PR it could not settle, or none open) */
function stoppedAfterPushAt(rows: LifecycleRecord[], pushedAt: number): boolean {
  if (pushedAt < 0) return false;
  return rows.slice(pushedAt + 1).some((e) => e.event === "s4_push_held" && (e.attrs?.after_push || e.attrs?.no_open_pr));
}

/** whether the tick held this head already on the round */
function heldHere(rows: LifecycleRecord[], head: string): boolean {
  return rows.some((e) => e.event === "s4_push_held" && String(e.attrs?.head ?? "") === head);
}

const RETRY_MS = 10 * 60_000;

/** whether the failure after the push is recent enough that the tick does not try again yet */
function failedJustNow(facts: Facts, idd: string, started: string, now: number): boolean {
  const stamp = text(at(facts, "shipFailedAt", idd, started));
  if (!stamp) return false;
  return now - Date.parse(stamp) < RETRY_MS;
}

/** whether a checked submit of this head waits for penne's approval on the card */
function readyAt(facts: Facts, idd: string, saved: Record<string, unknown>, head: string, now: number): boolean {
  if (text(saved.status) !== "prepared" || text(saved.head) !== head || text(saved.mode) !== "publish" || num(saved.blocking) > 0) return false;
  if (!(Date.parse(text(saved.expiresAt)) > now)) return false;
  if (!at(facts, "location", idd)) return false;
  const outdated = obj(at(facts, "outdated", idd));
  if (outdated.threw) return false;
  return outdated.reason === null || outdated.reason === undefined;
}

/** what the settling of a push came to, as the steps the stage runs */
function settledSteps(idd: string, keep: Record<string, unknown>, done: Record<string, unknown>): SubmitStep[] {
  const steps: SubmitStep[] = [];
  const head = text(keep.head);
  const hasPr = Boolean(keep.hasPr);
  const what = text(keep.what);
  const ok = Boolean(done.ok);
  const failure = text(done.error);
  if (!ok && done.lockRefused) return steps;
  if (!ok && done.permanent) {
    steps.push(write("s4_push_held", {
      head,
      reason: `push の後の確認で止まりました: ${failure.slice(0, 300)}。原因を直してから、提出前確認のカードで承認してください`,
      after_push: true,
    }));
    steps.push(result("held", idd));
    return steps;
  }
  if (!ok) {
    steps.push(error(idd, failure || what));
    return steps;
  }
  if (done.merged) {
    steps.push(result("merged", idd));
    return steps;
  }
  if (hasPr && !text(done.prUrl)) {
    const previous = obj(done.previousPr);
    const reason = text(previous.state) === "MERGED"
      ? `push しましたが、前の PR #${num(previous.number)} は merge 済みで、この push はそれより後の変更です。PR を作るには提出前確認のカードで承認してください`
      : "push しましたが、開いている PR がありません（前の PR は閉じています）。PR を作るには提出前確認のカードで承認してください";
    steps.push(write("s4_push_held", {
      head, reason, no_open_pr: true,
      ...(given(done.previousPr) ? previousPrAttrs(previous) : {}),
    }));
    steps.push(result("held", idd));
    return steps;
  }
  steps.push(result("recorded", idd));
  return steps;
}

/** what a hold that waits for a new PR records of the lane's earlier PR found no longer open */
function previousPrAttrs(previous: Record<string, unknown>): Record<string, unknown> {
  if (!previous.number && !previous.state) return {};
  return {
    previous_pr: previous.number,
    previous_pr_state: previous.state,
    ...(previous.headRefOid ? { previous_pr_head: previous.headRefOid } : {}),
  };
}

/** the steps of a push whose follow-up the tick owes: settle it with its token, or the steps its answer leads to */
function settleSteps(
  idd: string,
  site: string,
  head: string,
  hasPr: boolean,
  what: string,
  token: string,
  facts: Facts,
): SubmitStep[] {
  const keep = { id: idd, head, hasPr, what };
  const answer = callAnswer(facts, "settle_pushed", site);
  if (!answer) return [call("settle_pushed", site, keep, { id: idd, token }, false)];
  return settledSteps(idd, obj(answer.keep), obj(answer.result));
}

/** the steps of a checked submit that waits for the card: the commit message is drafted once for the head */
function draftSteps(idd: string, head: string, saved: unknown, fresh: boolean, facts: Facts): SubmitStep[] {
  const site = fresh ? "fresh" : "ready";
  const answer = callAnswer(facts, "draft_commit_message", site);
  if (!answer) return [call("draft_commit_message", site, { id: idd }, { id: idd, head, saved }, true)];
  if (text(answer.result) === "drafted" || fresh) return [result("ready", idd), end()];
  return [end()];
}

/** the steps of a submit the check just made */
function freshSteps(idd: string, head: string, checked: Record<string, unknown>, hasPr: boolean, facts: Facts): SubmitStep[] {
  const token = text(checked.token);
  if (at(facts, "carriesOf", idd, token)) {
    return settleSteps(idd, "fresh", head, hasPr, "PR の確認に失敗しました", token, facts);
  }
  return draftSteps(idd, head, checked, true, facts);
}

/** the steps once the check answered */
function afterProposed(idd: string, head: string, hasPr: boolean, proposed: Record<string, unknown>, facts: Facts): SubmitStep[] {
  if (given(proposed.error)) {
    if (proposed.notSaved || proposed.lockRefused) return [end()];
    return [write("s4_push_held", { head, reason: text(proposed.error) }), result("held", idd), end()];
  }
  if (text(proposed.status) !== "prepared") {
    return settleSteps(idd, "checked", head, hasPr, "PR の確認に失敗しました", text(proposed.token), facts);
  }
  if (text(proposed.mode) === "local" || num(proposed.blocking) > 0) {
    const reason = text(proposed.mode) === "local"
      ? "公開 branch とも公開本流とも差が無い（記録の回収とローカル完了は提出前確認で行う）"
      : `必須検査が通っていない: ${text(proposed.blockingSummary)}`;
    return [write("s4_push_held", { head, reason }), result("held", idd), end()];
  }
  return freshSteps(idd, head, proposed, hasPr, facts);
}

/**
 * The push stage's next steps for one lane, from its rows and the observations the caller gathered.
 */
export function submitStepReference(events: LifecycleRecord[], facts: Facts): SubmitAnswer {
  const steps = stepsOf(events, facts);
  return { steps };
}

function stepsOf(events: LifecycleRecord[], facts: Facts): SubmitStep[] {
  if (!events.length) return [end()];
  const idd = events[events.length - 1].idd_id;
  const head = text(at(facts, "head", idd));
  const now = num(at(facts, "now", idd));
  const started = tail(events, "s4_submit_started");
  const round = roundOf(events);
  // a helper already answered: its answer is read where that call's step leads, and the branches before it are not
  // read again (C-202-2)
  const proposedAnswer = callAnswer(facts, "propose_admitted", "checked");
  if (proposedAnswer) {
    return afterProposed(idd, head, given(at(facts, "pr", idd)), obj(proposedAnswer.result), facts);
  }
  for (const site of ["unsaved", "retry", "ready", "checked", "fresh"]) {
    const answer = callAnswer(facts, "settle_pushed", site);
    if (answer) return settledSteps(idd, obj(answer.keep), obj(answer.result));
  }
  if (callAnswer(facts, "draft_commit_message", "unreviewed")) return [end()];
  const readyDraft = callAnswer(facts, "draft_commit_message", "ready");
  if (readyDraft) return text(readyDraft.result) === "drafted" ? [result("ready", idd), end()] : [end()];
  if (callAnswer(facts, "draft_commit_message", "fresh")) return [result("ready", idd), end()];
  const mergedAnswer = callAnswer(facts, "settle_merged_pr", "merged");
  const mergedDone = mergedAnswer ? true : false;
  if (mergedAnswer && given(obj(mergedAnswer).result)) return [result("merged", idd), end()];

  const savedRaw = at(facts, "proposal", idd);
  const saved = obj(savedRaw);
  const unsaved = at(facts, "unsaved", idd);
  const hasUnsaved = given(unsaved);
  const outdated = hasUnsaved ? Boolean(at(facts, "unsavedOutdated", idd)) : false;
  // a push that reached GitHub but was not saved: put on record with its own token, and the lane goes on as one
  // pushed at that commit, with its own re-read of the ledger before anything below reads it
  const pairDone = Boolean(callAnswer(facts, "record_unsaved_push", "outdated")) && Boolean(callAnswer(facts, "settle_unsaved", "outdated"));
  if (hasUnsaved && outdated && !pairDone) {
    const recordFailure = callError(facts, "record_unsaved_push", "outdated");
    if (recordFailure) {
      if (recordFailure.lockRefused) return [end()];
      return [error(idd, `記録の無い push を記録できません: ${text(recordFailure.error).slice(0, 300)}`), end()];
    }
    if (!callAnswer(facts, "record_unsaved_push", "outdated")) {
      return [call("record_unsaved_push", "outdated", { id: idd }, { id: idd, unsaved }, false)];
    }
    const settleFailure = callError(facts, "settle_unsaved", "outdated");
    if (settleFailure) {
      if (settleFailure.lockRefused) return [end()];
      return [error(idd, `記録の無い push を記録できません: ${text(settleFailure.error).slice(0, 300)}`), end()];
    }
    if (callAnswer(facts, "settle_unsaved", "outdated")) return [again()];
    return [call("settle_unsaved", "outdated", { id: idd }, { id: idd }, false, true)];
  }
  const pr = at(facts, "pr", idd);
  const hasPr = given(pr);
  const pushedAt = tail(round, "s4_pushed");
  if (hasUnsaved && !outdated) {
    const recordFailure = callError(facts, "record_unsaved_push", "unsaved");
    if (recordFailure) {
      if (recordFailure.lockRefused) return [end()];
      return [error(idd, `記録の無い push を記録できません: ${text(recordFailure.error).slice(0, 300)}`), end()];
    }
    if (!callAnswer(facts, "record_unsaved_push", "unsaved")) {
      return [call("record_unsaved_push", "unsaved", { id: idd }, { id: idd, unsaved }, true)];
    }
    if (stoppedAfterPush(round, head)) return [end()];
    if (failedJustNow(facts, idd, String(started), now)) return [end()];
    return settleSteps(idd, "unsaved", head, hasPr, "push の後始末に失敗しました", text(obj(unsaved).token), facts);
  }
  const retry = pushedAt >= 0 && hasPr && text(saved.status) === "pushed" && text(saved.head) === head && !stoppedAfterPushAt(round, pushedAt);
  if (pushedAt >= 0 && !retry && (!given(savedRaw) || text(saved.head) === head)) return [end()];
  if (retry) {
    if (failedJustNow(facts, idd, String(started), now)) return [end()];
    return settleSteps(idd, "retry", text(saved.head), hasPr, "PR の確認に失敗しました", text(saved.token), facts);
  }
  const held = heldHere(round, head);
  if (!held) {
    const unreviewed = at(facts, "unreviewed", idd);
    if (given(unreviewed)) {
      const out: SubmitStep[] = [
        write("s4_push_held", {
          head,
          reason: text(obj(unreviewed).reason),
          unreviewed: true,
          reviewed_head: text(obj(unreviewed).seen),
        }),
        result("held", idd),
      ];
      let drafted = false;
      if (readyAt(facts, idd, saved, head, now) && !at(facts, "carries", idd)) {
        out.push(call("draft_commit_message", "unreviewed", { id: idd }, { id: idd, head, saved }, true));
        drafted = true;
      }
      if (!drafted) out.push(end());
      return out;
    }
  }
  if (readyAt(facts, idd, saved, head, now)) {
    if (at(facts, "carries", idd)) {
      return settleSteps(idd, "ready", head, hasPr, "PR の確認に失敗しました", text(saved.token), facts);
    }
    return draftSteps(idd, head, saved, false, facts);
  }
  if (held) return [end()];
  if (hasPr && !at(facts, "unpublished", idd)) {
    const failure = callError(facts, "settle_merged_pr", "merged");
    if (failure) {
      return [error(idd, `PR の状態を確かめられません: ${text(failure.error).slice(0, 300)}`), end()];
    }
    if (!mergedDone) return [call("settle_merged_pr", "merged", { id: idd }, { id: idd }, false)];
  }
  const prDraft = at(facts, "prDraft", idd);
  if (!at(facts, "openPr", idd) && at(facts, "runnerDraft", idd) && !given(prDraft) && !at(facts, "prDraftFailed", idd, String(started))) {
    return [end()];
  }
  const view = at(facts, "submitView", idd);
  if (!given(view)) return [end()];
  const draft = given(prDraft)
    ? obj(prDraft)
    : { title: text(obj(view).title), body: text(obj(view).body) };
  const proposeFailure = callError(facts, "propose_admitted", "checked");
  if (proposeFailure) return [error(idd, text(proposeFailure.error).slice(0, 300)), end()];
  return [call("propose_admitted", "checked", { id: idd }, { id: idd, pr: draft, gone: at(facts, "gone", idd) }, false)];
}
