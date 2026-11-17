import type { FollowupItem } from "../ledger/review-loop.ts";
import { todoIds } from "./vocab.ts";

/**
 * One follow-up as a lane's record holds it: the weight, the claim and, when it has one, where it belongs.
 * The follow-ups a lane keeps live on its lifecycle record (`s3_followups_written`); they are no longer
 * written into a TODO. `task` and `failed` are the fields of the records made while they still were: `task`
 * is the TODO task an old note went to, `failed` the reason an old record could not write the item.
 */
export interface FollowupEntry {
  severity: string;
  /** the weight the judgement gave, when a person set another (a must put off on the stuck card is a should here) */
  judgedSeverity?: string;
  claim: string;
  path?: string;
  /** the TODO task an old record's note went to */
  task?: string;
  /** the reason this item could not be written, on an old record */
  failed?: string;
  /** why it is a follow-up when the judgement did not decide so (FollowupItem.source; `r2` only on a lane from before R2 was removed) */
  source?: "unsent" | "r2";
}

/** the first TODO ID the lane's intake names (title and the body the ledger kept), when it names one */
export function followupTaskId(intake: { title: string; context: string }): string | undefined {
  return todoIds(`${intake.title}\n${intake.context.slice(0, 2000)}`)[0];
}
