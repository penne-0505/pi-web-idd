import { getAgentRunner } from "../agent/port.ts";
import { readAreas, publishes } from "../config/areas.ts";
import { stagePick } from "../ledger/pick.ts";
import { readBacklog, readLifecycle, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { carriesAlready, laneLocations, outdatedReason, proposeAdmitted, readProposal } from "../overlay/export.ts";
import type { ProposeRecord } from "../overlay/export.ts";
import { blockingSummary } from "../overlay/gate.ts";
import { isLockRefusal } from "../overlay/git.ts";
import { headCommit } from "../worktree/ensure.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import type { FactNeed } from "../ledger/review-loop.ts";
import { prOf } from "./pr-feedback.ts";
import { draftCommitMessage } from "./pr-draft.ts";
import { unreviewedChange } from "./reviewed-head.ts";
import { laneHasUnpublished } from "./close.ts";
import { goneBranchOf, laneNotAtSubmit, openPrOnRecord, prDraftOf, recordUnsavedPush, settleMergedPr, settlePushed, settleUnsaved, unsavedPush, unsavedPushOutdated, buildSubmit } from "./ship.ts";
import { driveSubmitSteps } from "./submit-step.ts";
import type { SubmitStep } from "./submit-step.ts";

export interface SubmitPushResult {
  /** lanes whose push the tick checked and got ready: they wait for penne's approval on the card */
  ready: string[];
  /** pushes penne approved that the tick put on record (a push saved without its record, a PR check tried again) */
  recorded: string[];
  held: string[];
  /** lanes whose PR was found merged while at the submit card: they go on to the reclaim (runClose) */
  merged: string[];
  errors: { iddId: string; error: string }[];
}

/** the fact id the fold names a reading by: the kind and the values it is asked about */
function factId(kind: string, idd: string, extra = ""): string {
  return `${kind}|${idd}|${extra}`;
}

function lastIndex(evs: LifecycleRecord[], name: string): number {
  for (let i = evs.length - 1; i >= 0; i -= 1) if (evs[i].event === name) return i;
  return -1;
}

/** the round as the fold reads it: from the lane's last submit, or its last row alone when it never started one */
function roundOf(evs: LifecycleRecord[]): LifecycleRecord[] {
  return evs.slice(lastIndex(evs, "s4_submit_started"));
}

/** the observation the fold asked for, read from the outside world as it is now */
function observeSubmit(
  need: FactNeed,
  idd: string,
  rows: LifecycleRecord[],
  worktree: string,
  head: string,
  runner: ReturnType<typeof getAgentRunner>,
  memory: Record<string, unknown>,
): unknown {
  switch (need.kind) {
    case "proposal": return readProposal(idd);
    case "unsaved": return unsavedPush(idd);
    case "unsavedOutdated": {
      const saved = unsavedPush(idd);
      return saved ? unsavedPushOutdated(idd, saved) : false;
    }
    case "pr": return prOf(rows);
    case "shipFailedAt": {
      const round = roundOf(rows);
      const failed = round[lastIndex(round, "s4_ship_failed")];
      return failed ? String(failed.at ?? "") : null;
    }
    case "location": return Boolean(laneLocations(idd));
    case "outdated": {
      const saved = readProposal(idd);
      const loc = laneLocations(idd);
      if (!saved || !loc) return { reason: "lane と repo に作業本流・公開先を設定してください", threw: false };
      try {
        return { reason: outdatedReason(saved, loc), threw: false };
      } catch {
        return { reason: null, threw: true };
      }
    }
    case "unreviewed": return unreviewedChange(rows, worktree, head);
    case "carries": {
      const saved = readProposal(idd);
      return saved ? carriesAlready(saved) : false;
    }
    case "carriesOf": {
      const answer = memory[`call|propose_admitted|checked`] as { result?: ProposeRecord } | undefined;
      const saved = answer?.result;
      return saved ? carriesAlready(saved) : false;
    }
    case "unpublished": return laneHasUnpublished(idd);
    case "openPr": return Boolean(openPrOnRecord(idd, rows));
    case "runnerDraft": return Boolean(runner?.draftPrText);
    case "prDraft": return prDraftOf(rows);
    case "prDraftFailed": return lastIndex(roundOf(rows), "s4_pr_draft_failed") >= 0;
    case "submitView": {
      const view = buildSubmit(idd);
      return view ? { title: view.pr.title, body: view.pr.body.map((b) => `- ${b.text}`).join("\n") } : null;
    }
    case "gone": return goneBranchOf(idd) ?? null;
    default: return null;
  }
}

/**
 * The tick's part of the push, which never pushes: each lane at the submit card is checked (proposeAdmitted) with the
 * drafted PR text once per head, and the commit message of its push is drafted; the lane then waits for penne to
 * approve the push on the card (`runShip`). A submit that does not pass, or that has nothing public to push, is
 * held once per head and not checked again on every tick: penne checks it again from the card, or the lane comes
 * back with a new head. What follows a push penne approved is put on record here without a new push: a push that
 * reached GitHub without its record, and a PR check after the push that failed for a passing cause.
 *
 * Which of those a lane needs is the MoonBit fold's answer (C-202-1): this function gathers the observations the
 * answer names and runs the steps it gives, in their order (C-202-2, C-202-3).
 */
export async function runSubmitPush(): Promise<SubmitPushResult> {
  const result: SubmitPushResult = { ready: [], recorded: [], held: [], merged: [], errors: [] };
  const all = readLifecycle();
  const runner = getAgentRunner();
  for (const rec of readBacklog()) {
    // a reading that fails for one lane (GitHub not answering, a helper throwing) is that lane's error: the lanes
    // after it and the tick's later stages still run, and nothing here answers in the fold's place (C-202-1)
    try {
      // a repo that does not publish: the lane is not pushed, and no PR text or commit message is drafted for it. Its
      // landing is checked by the tick's land stage (plan/land.ts)
      const publishesArea = publishes(readAreas().areas[rec.area]);
      const evs = all.filter((e) => e.idd_id === rec.idd_id);
      // the ledger's part first: the head is a git read, and only the lanes at the card need it
      if (!stagePick("submit_push", evs, { publishes: publishesArea }).pick) continue;
      const worktree = readSessions("executor").filter((r) => r.idd_id === rec.idd_id).pop()?.worktree_path;
      const head = worktree ? headCommit(worktree) : null;
      if (!stagePick("submit_push", evs, { publishes: publishesArea, hasWorktree: Boolean(worktree), hasHead: Boolean(head) }).pick) continue;
      if (!worktree || !head) continue;
      // the lane's rows as the answers below read them: the fold is asked with a fresh reading after each write it
      // names, and with the same reading in between
      let rows = evs;
      const now = Date.now();
      const facts: Record<string, unknown> = {
        [factId("now", rec.idd_id)]: now,
        [factId("head", rec.idd_id)]: head,
      };
      await driveSubmitSteps(
        evs,
        facts,
        (need: FactNeed, memory) => observeSubmit(need, rec.idd_id, rows, worktree, head, runner, memory),
        {
          write: (event, attrs) => appendLifecycle(event, rec.idd_id, attrs).then(() => undefined),
          call: async (step: SubmitStep) => {
            const args = step.args ?? {};
            switch (step.helper) {
              case "record_unsaved_push": return recordUnsavedPush(rec.idd_id, args.unsaved as ProposeRecord);
              case "settle_unsaved": return settleUnsaved(rec.idd_id);
              case "settle_pushed": return settlePushed(rec.idd_id, String(args.token));
              case "settle_merged_pr": return settleMergedPr(rec.idd_id);
              case "draft_commit_message": return draftCommitMessage(rec.idd_id, String(args.head), args.saved as ProposeRecord);
              case "propose_admitted": {
                const proposed = await proposeAdmitted(rec.idd_id, args.pr as { title: string; body: string } | undefined, {
                  gone: (args.gone ?? undefined) as ReturnType<typeof goneBranchOf>,
                  admit: () => laneNotAtSubmit(rec.idd_id),
                });
                return { ...proposed, blockingSummary: "checks" in proposed ? blockingSummary(proposed.checks) : "" };
              }
              default: throw new Error(`知らない helper: ${step.helper}`);
            }
          },
          result: (field, id, error) => {
            if (field === "errors") result.errors.push({ iddId: id, error: error ?? "" });
            else result[field].push(id);
          },
          reload: () => {
            rows = readLifecycle().filter((e) => e.idd_id === rec.idd_id);
            return rows;
          },
          lockRefused: (err) => isLockRefusal(err),
        },
      );
    } catch (err) {
      result.errors.push({ iddId: rec.idd_id, error: String((err as Error).message ?? err).slice(0, 300) });
    }
  }
  return result;
}
