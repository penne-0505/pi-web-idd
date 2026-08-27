// intent: DEC-686 — 中断した agent は session file から起こして続きを頼む。作業を捨てて最初からやり直させない

import { readBacklog, readSessions } from "../ledger/read.ts";
import { appendLifecycle } from "../ledger/write.ts";
import { agentBaseUrl, agentToken } from "../agent/token.ts";
import { getAgentRunner } from "../agent/port.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ResumeTarget {
  iddId: string;
  role: "planner" | "executor";
  sessionId: string;
  worktree: string;
}

export function resumeTargetFor(iddId: string): ResumeTarget | null {
  const executor = readSessions("executor").filter((r) => r.idd_id === iddId).pop();
  if (executor?.executor_session_id) {
    return { iddId, role: "executor", sessionId: executor.executor_session_id, worktree: executor.worktree_path };
  }
  const planner = readSessions("planner").filter((r) => r.idd_id === iddId).pop();
  if (planner?.planner_session_id) {
    return { iddId, role: "planner", sessionId: planner.planner_session_id, worktree: planner.worktree_path };
  }
  return null;
}

export function resumeBrief(target: ResumeTarget, reason: string): string {
  const done = target.role === "executor"
    ? "result を呼ぶ (実装が終わっていれば outcome: success、途中なら partial)"
    : "ready を呼ぶ";
  return [
    "<idd-system-message>",
    `  <sent-at>${new Date().toISOString()}</sent-at>`,
    `  <type>${target.role === "executor" ? "s2_resume" : "s1_resume"}</type>`,
    `  <idd-id>${esc(target.iddId)}</idd-id>`,
    "  <situation>",
    `    ${esc(reason)}`,
    "    作業内容は worktree に残っている。最初からやり直さない。",
    "  </situation>",
    "  <task>",
    "    まず `git status` と `git diff` で自分がどこまで進めたかを確認する。",
    "    その上で残りを進め、完了したら " + done + "。",
    "    中断前に立てた server やプロセスが残っていないかも確認する (残っていれば PID を控えて止める)。",
    "  </task>",
    "  <callback>",
    `    <base-url>${esc(agentBaseUrl())}</base-url>`,
    `    <token>${esc(agentToken())}</token>`,
    "    <auth>Authorization: Bearer &lt;token&gt;</auth>",
    "  </callback>",
    "</idd-system-message>",
  ].join("\n");
}

export async function runResume(iddId: string, reason = "session が中断された (runtime の再起動など)"): Promise<
  { ok: true; role: string; sessionId: string } | { ok: false; error: string }
> {
  const runner = getAgentRunner();
  if (!runner) return { ok: false, error: "no runner" };
  if (!readBacklog().some((rec) => rec.idd_id === iddId)) return { ok: false, error: `unknown lane: ${iddId}` };

  const target = resumeTargetFor(iddId);
  if (!target) return { ok: false, error: `no session for lane: ${iddId}` };

  await runner.deliver(target.sessionId, resumeBrief(target, reason), { cwd: target.worktree });
  if (target.role === "executor") {
    await appendLifecycle("s2_recovery_attempt", iddId, { attempt_number: 1, failure_type: "session_interrupted" });
  }
  return { ok: true, role: target.role, sessionId: target.sessionId };
}
