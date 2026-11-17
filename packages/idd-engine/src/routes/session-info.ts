import { join } from "node:path";
import { json } from "../http.ts";
import { isSupervisedPipelineSession, pipelineStateDir, preparePipelineAgentDir, readPipelineSession, resolveRole } from "@idd/lane";
import { isEngineConversationOpen } from "../server/conversations.ts";

/** pi の session id として読める形か（記録のファイルの外を指させない） */
const SESSION_ID = /^[A-Za-z0-9_.-]+$/;
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * What the chat screen asks before it revives a session with no live wrapper: whether the engine owns it
 * (then the GUI must not start a second writer), and the role's agent dir when the session is a mode's
 * (revived with it). A record that cannot be read is not answered as "not the engine's": the caller must
 * refuse the revive rather than risk two writers.
 */
export async function GET(_req: Request, params: Record<string, string>) {
  const { id } = params;
  if (!SESSION_ID.test(id)) return json({ engineOwned: false }, { headers: NO_STORE });

  let rec;
  try {
    // the record decides a pipeline session's ownership and the mode's agent dir; unreadable is a refusal
    rec = readPipelineSession(id);
  } catch (err) {
    return json({ error: `session の記録を読めません: ${String(err)}` }, { status: 500, headers: NO_STORE });
  }

  try {
    const engineOwned = isEngineConversationOpen(id) || isSupervisedPipelineSession(id);
    const out: { engineOwned: boolean; slot?: string; role?: string; agentDir?: string } = { engineOwned };
    if (rec) {
      out.slot = rec.slot;
      out.role = rec.role;
      // a mode session is the GUI's to revive: the role's agent dir is prepared from the current roles and
      // ~/.pi/agent, the way an in-process resume did, so a routing / auth change since the start is picked up
      if (!engineOwned && rec.slot.startsWith("mode:")) {
        try {
          const role = resolveRole(rec.role);
          // the base is the agent dirs' parent: preparePipelineAgentDir appends the role, so the dir is
          // <state>/pipeline/agent/<role> — where the start put it and the record names it
          out.agentDir = preparePipelineAgentDir(join(pipelineStateDir(), "agent"), role);
        } catch {
          if (rec.agent_dir) out.agentDir = rec.agent_dir;
        }
      } else if (rec.agent_dir) {
        out.agentDir = rec.agent_dir;
      }
    }
    return json(out, { headers: NO_STORE });
  } catch (err) {
    // ownership itself could not be decided: answer without saying the session is not the engine's
    return json({ error: String(err) }, { status: 500, headers: NO_STORE });
  }
}
