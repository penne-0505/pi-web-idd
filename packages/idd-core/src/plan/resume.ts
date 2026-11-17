
import { readBacklog } from "../ledger/read.ts";
import { laneSession } from "../ledger/lane-session.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { getAgentRunner } from "../agent/port.ts";
import { CLI_NAME, callbackSection, esc, renderMessage, section } from "../agent/message.ts";
import { INTENT_IMPACT_RULE } from "../agent/intent-impact.ts";
import { heldBatches, resumingLane } from "../ledger/routing-hold.ts";

export interface ResumeTarget {
  iddId: string;
  role: "planner" | "executor";
  sessionId: string;
  worktree: string;
}

/** the session a resume wakes: the one of the role the lane waits on, which the lane's rows decide (`laneSession`) */
export function resumeTargetFor(iddId: string): ResumeTarget | null {
  return laneSession(iddId);
}

export function resumeBrief(target: ResumeTarget, reason: string): string {
  const callback = target.role === "executor"
    ? `    <result>完了したら ${CLI_NAME} report result を送る（実装が終わっていれば outcome: success、途中なら partial）。</result>`
    : `    <plan>完了したら ${CLI_NAME} report plan を送る。${INTENT_IMPACT_RULE} 触る path に open な指摘があれば、その処置を \`--findings\` で送る。</plan>`;
  return renderMessage([
    section("task", [
      "  <task>",
      "    作業を再開する。作業内容は worktree に残っている。最初からやり直さない。",
      "    - まず `git status` と `git diff` で自分がどこまで進めたかを確認し、残りを進める。",
      "    - 中断前に立てた server やプロセスが残っていないかも確認する（残っていれば PID を控えて止める）。",
      "  </task>",
    ].join("\n")),
    callbackSection([callback]),
    section("context", [
      "  <situation>",
      `    ${esc(reason)}`,
      "  </situation>",
    ].join("\n")),
  ]);
}

export interface ResumeOptions {
  /** the watch's own resume: a lane whose planner's questions the judge holds is waiting on the judge, so nothing is delivered or recorded for it (C-263-1) */
  unlessHeld?: boolean;
}

export type ResumeResult =
  | { ok: true; role: string; sessionId: string }
  | { ok: false; error: string; held?: true };

export async function runResume(iddId: string, reason = "session が中断された (runtime の再起動など)", opts: ResumeOptions = {}): Promise<ResumeResult> {
  const runner = getAgentRunner();
  if (!runner) return { ok: false, error: "no runner" };
  if (!readBacklog().some((rec) => rec.idd_id === iddId)) return { ok: false, error: `unknown lane: ${iddId}` };

  const target = resumeTargetFor(iddId);
  if (!target) return { ok: false, error: `no session for lane: ${iddId}` };

  // The hold's check and the start of the delivery have no await between them, and the lane is marked as resuming from
  // the same turn, so of a resume and a hold on one lane the hold comes either first (nothing is delivered or recorded)
  // or not at all while the resume is under way: the hold's maker sees the mark and writes no hold (`resumeUnderWay`).
  if (opts.unlessHeld && heldBatches(iddId).length) return { ok: false, error: `the judge holds a batch of ${iddId}`, held: true };
  return resumingLane(iddId, async () => {
    await runner.deliver(target.sessionId, resumeBrief(target, reason), { cwd: target.worktree, type: target.role === "executor" ? "s2_resume" : "s1_resume" });
    // a hold that came while the delivery ran (the wait for it ran out) is not followed by a recovery attempt
    if (opts.unlessHeld && heldBatches(iddId).length) return { ok: false, error: `the judge took a batch of ${iddId} during the resume`, held: true };
    await appendLifecycle(target.role === "executor" ? "s2_recovery_attempt" : "s1_recovery_attempt", iddId, { attempt_number: 1, failure_type: "session_interrupted", reason });
    return { ok: true, role: target.role, sessionId: target.sessionId };
  });
}
