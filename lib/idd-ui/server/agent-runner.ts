// intent: DEC-659 — pi session を所有するのはこのプロセスだけ。engine の port の実装はここに 1 つだけ置く

import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { setAgentRunner, type AgentRunner } from "@idd/core";

const runner: AgentRunner = {
  async deliver(sessionId: string, text: string, opts?: { cwd?: string }): Promise<void> {
    const existing = getRpcSession(sessionId);
    const session = existing?.isAlive()
      ? existing
      : (await startRpcSession(sessionId, "", opts?.cwd)).session;

    const state = await session.send({ type: "get_state" }) as { isStreaming?: boolean };
    await session.send({
      type: "prompt",
      message: text,
      expandPromptTemplates: false,
      // intent: DEC-662 — 稼働中なら次の turn の user 位置へ回す (割り込まない)
      ...(state?.isStreaming ? { streamingBehavior: "followUp" } : {}),
    });
  },
};

let installed = false;

export function ensureAgentRunner(): void {
  if (installed) return;
  setAgentRunner(runner);
  installed = true;
}
