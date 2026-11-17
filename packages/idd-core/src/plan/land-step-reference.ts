import type { LifecycleRecord } from "../schema/records.ts";
import { landFailureCauseReference } from "../overlay/land-failure-reference.ts";
import type { LandStep } from "./land-step.ts";

/**
 * The landing's next step, as the TypeScript read it before the MoonBit fold took the stage over. It is not on the
 * running path (C-202-1): the cross-check (`packages/idd-fold/crosscheck.mjs`) holds it against the MoonBit answer
 * at every prefix of a real ledger over a set of observations, and the committed fixture
 * (`packages/idd-core/test/land-step.test.mjs`) holds both against each other.
 *
 * The steps are read from the lane's rows and the observations alone, so the same ledger and the same answers give
 * the same steps (C-202-3). A helper's answer is read back under the fact that step named, and the branches before
 * that step are not read again (C-202-2).
 */

type Facts = Record<string, unknown>;

/** the waiting the tick puts between checks of the same group, and how many it takes (the fold reads both) */
export interface LandRecheckPolicy {
  max: number;
  intervalMs: number;
}

const at = (facts: Facts, kind: string, idd: string, extra = ""): unknown => facts[`${kind}|${idd}|${extra}`] ?? null;
const given = (value: unknown): boolean => value !== null && value !== undefined;
const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0) || 0);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const write = (event: string, attrs: Record<string, unknown>): LandStep => ({ do: "write", event, attrs });
const call = (helper: string, site: string, keep: Record<string, unknown>, args: Record<string, unknown>, fatal = true, reread = false): LandStep => ({
  do: "call", helper, site, fact: `call|${helper}|${site}`, keep, args, fatal, reread,
});
const merged = (id: string, committed: string | null): LandStep => ({ do: "result", field: "merged", id, committed });
const held = (id: string, reason: string): LandStep => ({ do: "result", field: "held", id, reason });
const failed = (id: string, error: string): LandStep => ({ do: "result", field: "errors", id, error });
const checking = (id: string, what: string | null): LandStep => ({ do: "result", field: "checking", id, checking: what });
const inherited = (id: string, inherit: Record<string, unknown>): LandStep => ({ do: "result", field: "inherited", id, inherit });
const prepared = (id: string): LandStep => ({ do: "result", field: "prepared", id });
const sentBack = (id: string): LandStep => ({ do: "result", field: "sentBack", id });
const end = (): LandStep => ({ do: "end" });

/** the call's answer, when the caller has already run it */
function callAnswer(facts: Facts, helper: string, site: string): Record<string, unknown> | null {
  const id = `call|${helper}|${site}`;
  return id in facts ? obj(facts[id]) : null;
}

/** how many times the same lane head and mainline tip are checked again when the change itself failed (the fold reads the same number) */
const REAL_RECHECK_MAX = 1;

/**
 * the ticks of the group's re-checks of one kind: a line that took results over from an earlier tip, or that started
 * the group's first check after the mainline moved, is not one of them, and a line without the kind's mark is the
 * environment's, as every line written before the mark was
 */
function rechecks(evs: LifecycleRecord[], head: string, mainTip: string, real: boolean): LifecycleRecord[] {
  return evs.filter((e) => e.event === "s4_land_recheck" && e.attrs?.head === head && e.attrs?.main_tip === mainTip && e.attrs?.inherit === undefined && e.attrs?.moved === undefined && (e.attrs?.cause === "real") === real);
}

/** a landing the tick held, recorded once for a lane head and reason */
function heldOnce(evs: LifecycleRecord[], id: string, head: string, reason: string): LandStep[] {
  const last = [...evs].reverse().find((e) => e.event === "s4_land_held");
  if (last && text(last.attrs?.head) === head && text(last.attrs?.reason) === reason) return [held(id, reason)];
  return [write("s4_land_held", { head, reason }), held(id, reason)];
}

/** the steps an advance's answer leads to: the merge went in, waits, or failed */
function advanceSteps(idd: string, done: Record<string, unknown>): LandStep[] {
  if (given(done.held)) return [held(idd, text(done.held)), end()];
  if (done.ok) return [merged(idd, text(done.committed) || null), end()];
  if (given(done.error)) return [failed(idd, text(done.error)), end()];
  return [end()];
}

/** the steps the check an approval waits on leaves: a run started, a conflict, a landing that could not be rebuilt, or a reason it could not start */
function approvedPrepareSteps(evs: LifecycleRecord[], facts: Facts, idd: string, head: string, branch: string, mainTip: string, done: Record<string, unknown>, policy: LandRecheckPolicy): LandStep[] {
  if (text(done.error) !== "") return [failed(idd, text(done.error)), end()];
  if (done.checking) {
    const out: LandStep[] = [];
    if (given(done.inherit)) out.push(inherited(idd, obj(done.inherit)));
    out.push(checking(idd, text(done.waiting) || "検査中です。終わると次の tick が merge します"));
    out.push(end());
    return out;
  }
  if (list(done.conflict).length) return conflictSteps(idd, head, branch, mainTip, list(done.conflict));
  // the generated files of the approved group could not be made again after the mainline moved
  if (isUnbuilt(done)) {
    return unbuiltSteps(evs, facts, "approved", idd, branch, text(done.head) || head, text(done.mainTip) || mainTip, text(done.reason), obj(done.rebuildFailure), { kind: "fresh" }, policy);
  }
  return [failed(idd, text(done.reason) || "検査を始められませんでした"), end()];
}

/** the steps of a lane whose head and the mainline conflict: the approval is dropped, the check forgotten, and the lane is sent back once */
function conflictSteps(idd: string, head: string, branch: string, mainTip: string, files: unknown[]): LandStep[] {
  return [
    write("s4_land_approval_dropped", { reason: "本流と衝突しました", head }),
    call("invalidate_land", "approved", { id: idd }, { id: idd }),
    call("send_back_land_conflict", "approved", { id: idd }, { id: idd, branch, files, head, mainTip }),
    failed(idd, "本流と衝突するので merge しません。差し戻しました"),
    end(),
  ];
}

/** how a landing that could not be rebuilt came to be read: from the record, from the group's first try just made, or from a check again whose line is written with the steps */
type UnbuiltTry = { kind: "recorded" } | { kind: "fresh" } | { kind: "retried"; row: Record<string, unknown> };

/** what a landing that could not be rebuilt leads to: the one decision of the failure's kind and of its next step */
type UnbuiltNext = { kind: "sendBack" } | { kind: "hold"; reason: string } | { kind: "wait" } | { kind: "retry"; attempt: number };

const unbuiltKind = (failure: Record<string, unknown>): "environment" | "real" => (failure.cause === "environment" ? "environment" : "real");
const unbuiltReason = (failure: Record<string, unknown>): string => `生成物（${list(failure.paths).map(text).join(", ")}）をこの環境では作り直せませんでした`;

/** whether the interval since the failure's own time or the last check again has not passed yet: a time that does not read counts as none */
function tooSoon(facts: Facts, idd: string, failedAt: unknown, past: LifecycleRecord[], policy: LandRecheckPolicy): boolean {
  const time = (v: unknown): number => Date.parse(text(v ?? "")) || 0;
  const last = Math.max(time(failedAt), time(past.at(-1)?.at));
  return last > 0 && num(at(facts, "now", idd)) - last < policy.intervalMs;
}

/** the decision itself, from the failure's own cause and the tries the group has had */
function unbuiltNext(evs: LifecycleRecord[], facts: Facts, idd: string, head: string, mainTip: string, failure: Record<string, unknown>, attempt: UnbuiltTry, policy: LandRecheckPolicy): UnbuiltNext {
  // the same group builds the same way: the change's failure is not tried a second time
  if (unbuiltKind(failure) !== "environment") return { kind: "sendBack" };
  const past = rechecks(evs, head, mainTip, false);
  // a check again the pass has just made is written with these steps: it counts here, unless its line starts the count of a group the mainline moved to
  const counted = attempt.kind === "retried" && attempt.row.moved === undefined ? 1 : 0;
  const tries = past.length + counted;
  if (tries >= policy.max) {
    return { kind: "hold", reason: `環境由来の失敗で ${policy.max} 回検査し直しても通らないので、人の判断を待ちます（${unbuiltReason(failure)}）` };
  }
  if (attempt.kind !== "recorded") return { kind: "wait" };
  // the failure to rebuild is the record's own, taken when the landing was planned
  if (tooSoon(facts, idd, failure.at, past, policy)) return { kind: "wait" };
  return { kind: "retry", attempt: tries + 1 };
}

/** the call that sends a lane back for a landing whose generated files the change cannot make again, with the paths and the build's output */
function unbuiltSendBack(site: string, idd: string, branch: string, head: string, mainTip: string, failure: Record<string, unknown>): LandStep {
  const names = `生成物の作り直し（${list(failure.paths).map(text).join(", ")}）`;
  return call("send_back_land_check_failure", site, { id: idd, head, names }, { id: idd, branch, head, mainTip, checks: [], rebuild: failure });
}

/**
 * the steps a landing that could not be rebuilt leads to, from the one decision. `site` is the path asking: an approval's re-check drops the approval
 * first, so an unbuilt record is never carried out, and the lane is then settled like any other
 */
function unbuiltSteps(evs: LifecycleRecord[], facts: Facts, site: string, idd: string, branch: string, head: string, mainTip: string, reason: string, failure: Record<string, unknown>, attempt: UnbuiltTry, policy: LandRecheckPolicy): LandStep[] {
  const next = unbuiltNext(evs, facts, idd, head, mainTip, failure, attempt, policy);
  const approved = site === "approved";
  const out: LandStep[] = approved ? [write("s4_land_approval_dropped", { reason: "生成物を作り直せませんでした", head })] : [];
  // what the pass did is reported; a record only waited on is not
  const acted = approved || attempt.kind !== "recorded";
  const tried = (): LandStep[] => (attempt.kind === "retried" ? [write("s4_land_recheck", attempt.row)] : []);
  switch (next.kind) {
    case "sendBack":
      return [...out, unbuiltSendBack(site, idd, branch, head, mainTip, failure)];
    case "hold":
      return [...out, ...tried(), ...heldOnce(evs, idd, head, next.reason), end()];
    case "wait":
      return [...out, ...tried(), ...(acted ? [held(idd, reason)] : []), end()];
    case "retry":
      // the approval is dropped, so the next tick settles the lane and tries again
      if (approved) return [...out, held(idd, reason), end()];
      return [...out, call("prepare_land", "settle", { id: idd, head, mainTip, branch, reason: unbuiltReason(failure), cause: "environment", attempt: next.attempt }, { id: idd, signed: false })];
  }
}

/** the steps an approval the pass carries out leads to, from the lane's rows and the observations */
function carrySteps(evs: LifecycleRecord[], facts: Facts, policy: LandRecheckPolicy): LandStep[] {
  if (!evs.length) return [end()];
  const idd = evs[evs.length - 1].idd_id;
  if (evs.some((e) => e.event === "lane_close")) return [merged(idd, null), end()];
  // the send-back of a landing that could not be rebuilt answered: the approval it dropped is no longer in the ledger, so the answer is read before the approval is looked for
  const sentBack = sentAnswer(evs, facts, idd, "approved");
  if (sentBack) return sentBack;
  const approval = at(facts, "approval", idd);
  if (!given(approval)) return [end()];
  if (!at(facts, "location", idd)) return [failed(idd, "lane が見つかりません"), end()];
  const head = text(obj(approval).head);
  if (head !== text(at(facts, "cur", idd))) {
    return [
      write("s4_land_approval_dropped", { reason: "lane の head が変わりました", head }),
      failed(idd, "承認の後に lane の commit が進んだので、承認を外しました"),
      end(),
    ];
  }
  const mainTip = text(at(facts, "mainTip", idd));
  const branch = text(at(facts, "branch", idd));
  // a helper already answered: its answer is read where that call's step leads, and the branches before it are not
  // read again (C-202-2)
  const closed = callAnswer(facts, "close_landed", "carried");
  if (closed) {
    const done = obj(closed.result);
    if (!done.ok) return [failed(idd, text(done.reason) || "lane を閉じられませんでした"), end()];
    return [merged(idd, text(obj(closed.keep).commit)), end()];
  }
  const advanced = callAnswer(facts, "advance_land", "carry");
  if (advanced) return advanceSteps(idd, obj(advanced.result));
  const started = callAnswer(facts, "prepare_land", "approved");
  if (started) return approvedPrepareSteps(evs, facts, idd, head, branch, mainTip, obj(started.result), policy);
  const hold = (reason: string): LandStep[] => [
    call("note_land_hold", "carried", { id: idd, head, reason }, { id: idd, head, reason }),
    held(idd, reason),
    end(),
  ];
  if (at(facts, "ancestor", idd)) {
    const blocker = at(facts, "checkouts", idd);
    if (given(blocker)) return hold(text(blocker));
    const saved = obj(at(facts, "saved", idd));
    const savedCommit = text(saved.mergeCommit);
    const commit = savedCommit && at(facts, "mergeCommitCarried", idd) ? savedCommit : head;
    return [call("close_landed", "carried", { id: idd, commit }, { id: idd, commit })];
  }
  const blocker = at(facts, "checkouts", idd);
  if (given(blocker)) return hold(text(blocker));
  const ready = obj(at(facts, "ready", idd));
  if (given(at(facts, "ready", idd)) && text(ready.head) === head) {
    const blocked = at(facts, "blocked", idd);
    if (given(blocked)) return [failed(idd, text(blocked)), end()];
    return [call("advance_land", "carry", { id: idd, head }, { id: idd, head, mergeCommit: text(ready.mergeCommit), mainTip: text(ready.mainTip) })];
  }
  const saved = at(facts, "saved", idd);
  const savedHere = given(saved) && text(obj(saved).status) === "prepared" && text(obj(saved).head) === head && text(obj(saved).mainTip) === mainTip ? obj(saved) : null;
  if (savedHere && list(savedHere.conflict).length) return conflictSteps(idd, head, branch, mainTip, list(savedHere.conflict));
  // a record of the approved group that was never built: the approval does not stand for it, and the failure is read as every other path reads it
  if (savedHere && isUnbuilt(savedHere)) {
    return unbuiltSteps(evs, facts, "approved", idd, branch, head, mainTip, text(savedHere.reason), obj(savedHere.rebuildFailure), { kind: "recorded" }, policy);
  }
  if (savedHere && num(savedHere.blocking) > 0) {
    return [
      write("s4_land_approval_dropped", { reason: "必須の検査が落ちました", head }),
      write("s4_land_check_failed", { head, blocking: num(savedHere.blocking) }),
      failed(idd, `必須の検査が落ちたので merge しません（${num(savedHere.blocking)} 件）`),
      end(),
    ];
  }
  return [call("prepare_land", "approved", { id: idd }, { id: idd, signed: true })];
}

/** the pass's approval sweep, then the lane's own steps: a lane the sweep carried out is left */
function afterCarry(evs: LifecycleRecord[], facts: Facts, idd: string, site: "settle" | "fresh", policy: LandRecheckPolicy): LandStep[] {
  if (!callAnswer(facts, "carry_sweep", site)) return [call("carry_sweep", site, { id: idd }, { id: idd })];
  if (at(facts, "attempted", idd)) return [end()];
  return site === "settle" ? settleSteps(evs, facts, idd, policy) : freshSteps(evs, facts, idd, policy);
}

/** the steps the send-back of the change's failure leaves: sent back once, or held for a person with the checks named; an approval's re-check reports it as the error that stopped its merge */
function sentSteps(evs: LifecycleRecord[], idd: string, site: string, keep: Record<string, unknown>, answered: unknown): LandStep[] {
  if (answered) return site === "approved" ? [failed(idd, "生成物を作り直せないので merge しません。差し戻しました"), end()] : [sentBack(idd), end()];
  const head = text(keep.head);
  const reason = `取り込みの検査が同じ head（${head.slice(0, 7)}）で 2 回落ちたので、人の判断を待ちます（${text(keep.names)}）`;
  return [...heldOnce(evs, idd, head, reason), end()];
}

/** the steps the send-back of a landing that could not be rebuilt leaves, when the call at `site` already answered */
function sentAnswer(evs: LifecycleRecord[], facts: Facts, idd: string, site: string): LandStep[] | null {
  const sent = callAnswer(facts, "send_back_land_check_failure", site);
  return sent ? sentSteps(evs, idd, site, obj(sent.keep), sent.result) : null;
}

/** the line a check again leaves in the ledger: it names the pair the check actually started on, and a pair of its own is counted from its first line */
function recheckRow(keep: Record<string, unknown>, done: Record<string, unknown>, cause: string): Record<string, unknown> {
  const startedHead = text(done.head) || text(keep.head);
  const startedTip = text(done.mainTip) || text(keep.mainTip);
  const sameGroup = startedHead === text(keep.head) && startedTip === text(keep.mainTip);
  const row = { head: startedHead, main_tip: startedTip, reason: keep.reason, cause, attempt: sameGroup ? keep.attempt : 1 };
  return sameGroup ? row : { ...row, moved: { from_main_tip: text(keep.mainTip) } };
}

/** the steps the settle's check leaves: a run started (and its ask recorded), a conflict, a hold, or a failure */
function settlePrepareSteps(evs: LifecycleRecord[], facts: Facts, idd: string, keep: Record<string, unknown>, done: Record<string, unknown>, policy: LandRecheckPolicy): LandStep[] {
  if (text(done.error) !== "") {
    if (done.lockRefused) return [end()];
    return [failed(idd, text(done.error)), end()];
  }
  // a try that met the failure to rebuild is read by the one decision of such a landing, with the line it leaves
  if (isUnbuilt(done)) {
    const failure = obj(done.rebuildFailure);
    const row = recheckRow(keep, done, unbuiltKind(failure));
    return unbuiltSteps(evs, facts, "settle", idd, text(keep.branch), text(done.head) || text(keep.head), text(done.mainTip) || text(keep.mainTip), text(done.reason), failure, { kind: "retried", row }, policy);
  }
  if (done.checking) {
    if (given(done.waiting)) return [end()];
    return [write("s4_land_recheck", recheckRow(keep, done, text(keep.cause) || "environment")), checking(idd, null), end()];
  }
  if (list(done.conflict).length) {
    return [
      call("send_back_land_conflict", "settle", { id: idd }, { id: idd, branch: keep.branch, files: list(done.conflict), head: text(done.head), mainTip: text(done.mainTip) }),
      sentBack(idd),
      end(),
    ];
  }
  if (given(done.reason)) return [held(idd, text(done.reason)), end()];
  return [end()];
}

/** whether the record is a landing whose generated files could not be made again: it carries the failure and has neither a merge commit nor a conflict */
function isUnbuilt(saved: unknown): boolean {
  const o = obj(saved);
  return given(o.rebuildFailure) && !given(o.mergeCommit) && !list(o.conflict).length;
}

/** whether a record of the lane's head, checked at an earlier mainline tip, failed on what the head's tree decides */
function failedOnTree(behind: unknown): boolean {
  if (!given(behind)) return false;
  const cause = landFailureCauseReference(behind as never, null);
  return cause?.kind === "real" && cause.structural === true;
}

/** what the tick does with a lane whose check failed, or whose run ended without a result */
function settleSteps(evs: LifecycleRecord[], facts: Facts, idd: string, policy: LandRecheckPolicy): LandStep[] {
  // a helper already answered: its answer is read where that call's step leads, and the branches before it are not
  // read again (C-202-2)
  // the send-back is read before the check's answer: a check again that met the change's failure to rebuild leads to it, so both answers stand together
  // and the later one is the send-back
  const sent = sentAnswer(evs, facts, idd, "settle");
  if (sent) return sent;
  const prepared = callAnswer(facts, "prepare_land", "settle");
  if (prepared) return settlePrepareSteps(evs, facts, idd, obj(prepared.keep), obj(prepared.result), policy);
  // a record of this head that failed on its own tree at an earlier mainline tip is the failure whatever the new tip's
  // run is doing: it is read before the run's ending or its being under way (C-253-2)
  const fitted = at(facts, "checked", idd);
  const behind = given(fitted) ? null : at(facts, "behind", idd);
  const fromBehind = failedOnTree(behind);
  const checked = fromBehind ? behind : fitted;
  const saved = given(checked) ? obj(checked) : null;
  const runRaw = at(facts, "run", idd);
  const run = given(runRaw) ? obj(runRaw) : null;
  const head = text(saved?.head ?? run?.head ?? text(at(facts, "head", idd)));
  const mainTip = text(saved?.mainTip ?? run?.mainTip ?? "");
  const branch = text(at(facts, "branch", idd));
  if (at(facts, "runChecking", idd) && !fromBehind) return [checking(idd, null), end()];
  const cause = landFailureCauseReference(saved as never, run as never);
  if (!cause) return [end()];
  const real = cause.kind === "real";
  const checks = real ? cause.checks : [];
  const rebuild = cause.rebuild;
  const names = checks.map((c) => c.name).join(", ");
  // a landing whose generated files could not be made again ran no check: the one decision of such a landing reads it
  if (rebuild) {
    return unbuiltSteps(evs, facts, "settle", idd, branch, head, mainTip, text(saved?.reason), rebuild as unknown as Record<string, unknown>, { kind: "recorded" }, policy);
  }
  const past = rechecks(evs, head, mainTip, real);
  // the same group failed again after the check again, or a count that grew is the head's tree and would count the same
  // again: the change is the executor's to fix
  if (real && (cause.structural || past.length >= REAL_RECHECK_MAX)) {
    return [call("send_back_land_check_failure", "settle", { id: idd, head, names }, { id: idd, branch, head, mainTip, checks })];
  }
  if (!real && past.length >= policy.max) {
    const reason = `環境由来の失敗で ${policy.max} 回検査し直しても通らないので、人の判断を待ちます（${cause.reason}）`;
    return [...heldOnce(evs, idd, head, reason), end()];
  }
  if (!(cause.kind === "environment" && cause.noResult)) {
    if (tooSoon(facts, idd, run && run.head === head && run.mainTip === mainTip ? run.ended_at : undefined, past, policy)) return [end()];
  }
  const reason = real ? `変更の失敗と読んだ検査 ${names} を、同じ head と本流の先端で検査し直します` : cause.reason;
  return [call("prepare_land", "settle", { id: idd, head, mainTip, branch, reason, cause: real ? "real" : "environment", attempt: past.length + 1 }, { id: idd, signed: false })];
}

/** what the tick does with a lane it checks afresh */
function freshSteps(evs: LifecycleRecord[], facts: Facts, idd: string, policy: LandRecheckPolicy): LandStep[] {
  // the send-back of a landing that could not be rebuilt already answered: it is read where that call's step leads, and the branches before it are not read again
  const sent = sentAnswer(evs, facts, idd, "scan");
  if (sent) return sent;
  const answer = callAnswer(facts, "prepare_land", "scan");
  if (!answer) return [call("prepare_land", "scan", { id: idd }, { id: idd, signed: false })];
  const branch = text(at(facts, "branch", idd));
  const done = obj(answer.result);
  if (text(done.error) !== "") {
    if (done.lockRefused) return [end()];
    return [failed(idd, text(done.error)), end()];
  }
  if (done.checking) {
    const out: LandStep[] = [];
    if (given(done.inherit)) out.push(inherited(idd, obj(done.inherit)));
    if (!done.waiting) out.push(checking(idd, null));
    out.push(end());
    return out;
  }
  if (list(done.conflict).length) {
    return [
      call("send_back_land_conflict", "scan", { id: idd }, { id: idd, branch, files: list(done.conflict), head: text(done.head), mainTip: text(done.mainTip) }),
      sentBack(idd),
      end(),
    ];
  }
  // a landing whose generated files could not be made again is read by the one decision of such a landing
  if (isUnbuilt(done)) {
    return unbuiltSteps(evs, facts, "scan", idd, branch, text(done.head), text(done.mainTip), text(done.reason), obj(done.rebuildFailure), { kind: "fresh" }, policy);
  }
  if (given(done.reason)) return [held(idd, text(done.reason)), end()];
  const out: LandStep[] = [];
  if (given(done.inherit)) out.push(inherited(idd, obj(done.inherit)));
  out.push(prepared(idd), end());
  return out;
}

/** the steps of a lane at the landing's card: the check failed, or the lane is checked now */
function scanSteps(evs: LifecycleRecord[], facts: Facts, policy: LandRecheckPolicy): LandStep[] {
  if (!evs.length) return [end()];
  const idd = evs[evs.length - 1].idd_id;
  // the approval sweep already ran: the lane's own steps are read from its answer, and the branches before it are
  // not read again (C-202-2)
  if (callAnswer(facts, "carry_sweep", "settle")) return at(facts, "attempted", idd) ? [end()] : settleSteps(evs, facts, idd, policy);
  if (callAnswer(facts, "carry_sweep", "fresh")) return at(facts, "attempted", idd) ? [end()] : freshSteps(evs, facts, idd, policy);
  const checked = at(facts, "checked", idd);
  if (given(checked) && num(obj(checked).blocking) === 0 && !isUnbuilt(checked)) return [end()];
  if (given(checked)) return afterCarry(evs, facts, idd, "settle", policy);
  // the mainline moved after the head's record failed on its own tree: it no longer fits the tip, but the count it failed
  // on is still the head's, so the lane is settled from it instead of waiting on, or checking afresh for, the new tip
  if (failedOnTree(at(facts, "behind", idd))) return afterCarry(evs, facts, idd, "settle", policy);
  if (at(facts, "runEnded", idd)) return afterCarry(evs, facts, idd, "settle", policy);
  const stacked = at(facts, "stacked", idd);
  if (given(stacked)) return [held(idd, text(stacked)), end()];
  const unreviewed = at(facts, "unreviewed", idd);
  if (given(unreviewed)) return [held(idd, text(obj(unreviewed).reason)), end()];
  return afterCarry(evs, facts, idd, "fresh", policy);
}

/** the landing stage's next steps for one lane, from its rows and the observations the caller gathered */
export function landStepReference(
  mode: "carry" | "scan",
  events: LifecycleRecord[],
  facts: Facts,
  policy: LandRecheckPolicy,
): { steps: LandStep[] } {
  return { steps: mode === "carry" ? carrySteps(events, facts, policy) : scanSteps(events, facts, policy) };
}
