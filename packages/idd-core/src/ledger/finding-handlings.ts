import type { LifecycleRecord } from "../schema/records.ts";
import { acceptedAt, fixScope, fixesNow } from "./review-loop.ts";
import { correctionsOfPayload } from "./write.ts";

/** how a person may handle an accepted finding on the stuck card */
export type FindingAction = "fix" | "followup" | "skip";
export type HandlingWeight = "must" | "should" | "nit";

/**
 * One handling the stuck card offers for a finding, with what the loop then does with it. `inFix` is read from the
 * fix scope the MoonBit fold answers for the record that handling would write, so the screen shows which findings
 * go to the fix without holding a rule of its own. `current` marks the handling the finding already stands at: a
 * press that picks it records no correction.
 */
export interface FindingHandling { action: FindingAction; severity: HandlingWeight; inFix: boolean; current: boolean }

/**
 * An accepted finding of the last judgement as the stuck card offers it. `severity` is the weight it stands at now
 * (a person's correction in place of the judgement's), `judgedSeverity` the weight the judgement gave when they differ.
 * `inFix` says whether the fix as it stands takes it; `handlings` says, for each handling, whether it would.
 */
export interface AcceptedFinding {
  ref: string;
  severity: string;
  judgedSeverity?: string;
  action: FindingAction;
  claim: string;
  path?: string;
  inFix: boolean;
  handlings: FindingHandling[];
}

const ACTIONS: readonly FindingAction[] = ["fix", "followup", "skip"];

/** the weight a finding takes when put off: a must is the weight of what this change fixes, so it is lowered */
function weightFor(severity: string, action: FindingAction): HandlingWeight {
  if (action !== "fix" && severity === "must") return "should";
  return severity === "must" || severity === "nit" ? severity : "should";
}

/**
 * The answers asked of the fold, by what they say. The fold remembers every row object it is handed, so a row built
 * anew on each read would pile up in it one read at a time; the same answer is handed over as the same row.
 */
const answers = new Map<string, LifecycleRecord>();

/** the refs the fix takes once an answer carrying these corrections is on the record */
function fixRefsAfter(events: LifecycleRecord[], corrections: unknown[]): Set<string> {
  const idd_id = events[events.length - 1]?.idd_id ?? "";
  const key = `${idd_id}\n${JSON.stringify(corrections)}`;
  let answer = answers.get(key);
  if (!answer) {
    answer = { event: "s2_review_resumed", idd_id, at: "", attrs: { decision: "continue", note: "", corrections } };
    answers.set(key, answer);
  }
  return new Set(fixScope([...events, answer]).accepted.map((a) => a.ref));
}

/**
 * Every finding the last judgement accepted, each with the handlings a person may give it and whether each goes to
 * the fix. The fix scope is asked of the fold once per handling over all findings, with the corrections the write door
 * would record for it (a correction that changes nothing is not recorded, so it is not simulated either).
 */
export function acceptedFindings(events: LifecycleRecord[]): AcceptedFinding[] {
  const t = events.findLastIndex((e) => e.event === "s2_triage_done" && !e.attrs?.failed);
  if (t < 0) return [];
  const accepted = acceptedAt(events, t);
  if (!accepted.length) return [];
  const now = fixRefsAfter(events, []);
  const after = new Map<FindingAction, Set<string>>();
  for (const action of ACTIONS) {
    // the write door refuses a must lowered with no reason; this only asks what the fix would take, so a stand-in reason is given
    const raw = accepted.map((f) => ({ ref: f.ref, severity: weightFor(f.severity, action), action, reason: "-" }));
    const checked = correctionsOfPayload(events, raw);
    after.set(action, "error" in checked ? now : fixRefsAfter(events, checked.corrections));
  }
  return accepted.map((f): AcceptedFinding => {
    const action: FindingAction = fixesNow(f) ? "fix" : f.action === "skip" ? "skip" : "followup";
    const inFix = now.has(f.ref);
    return {
      ref: f.ref,
      severity: f.severity,
      ...(f.judged_severity && f.judged_severity !== f.severity ? { judgedSeverity: f.judged_severity } : {}),
      action,
      claim: f.claim,
      ...(f.path ? { path: f.path } : {}),
      inFix,
      handlings: ACTIONS.map((a): FindingHandling => {
        const severity = weightFor(f.severity, a);
        const goes = after.get(a)?.has(f.ref) ?? false;
        return { action: a, severity, inFix: goes, current: a === action && severity === f.severity && goes === inFix };
      }),
    };
  });
}
