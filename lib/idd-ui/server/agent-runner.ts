// intent: DEC-659 — pi session を所有するのはこのプロセスだけ。engine の port の実装はここに 1 つだけ置く

import { randomUUID } from "node:crypto";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { allowFileRoot } from "@/lib/file-access";
import { setAgentRunner, type AgentRunner } from "@idd/core";

function modelFromEnv(): { provider: string; modelId: string } | undefined {
  const raw = process.env.IDD_PLANNER_MODEL?.trim();
  if (!raw) return undefined;
  const at = raw.indexOf("/");
  if (at <= 0) return undefined;
  return { provider: raw.slice(0, at), modelId: raw.slice(at + 1) };
}

const runner: AgentRunner = {
  // intent: DEC-671 — session を起こすのは runtime 側だけ。engine は role と cwd しか渡さない
  async spawn({ cwd }): Promise<{ sessionId: string }> {
    allowFileRoot(cwd);
    const model = modelFromEnv();
    const { realSessionId } = await startRpcSession(`__idd__${randomUUID()}`, "", cwd, {
      ...(model ? { initialModel: model } : {}),
    });
    return { sessionId: realSessionId };
  },

  async deliver(sessionId: string, text: string, opts?: { cwd?: string }): Promise<void> {
    const existing = getRpcSession(sessionId);
    // intent: DEC-678 — 眠った session は file から起こす。file 無しで起こすと別の session が生える
    let session = existing?.isAlive() ? existing : null;
    if (!session) {
      const file = await resolveSessionPath(sessionId);
      if (!file) throw new Error(`session file not found: ${sessionId}`);
      const started = await startRpcSession(sessionId, file, opts?.cwd);
      if (started.realSessionId !== sessionId) {
        throw new Error(`session id changed on resume: ${sessionId} -> ${started.realSessionId}`);
      }
      session = started.session;
    }

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
