import { json } from "../http.ts";
import { pipelineAgentDir, readModes, readPipelineSession, recordPipelineSession, resolveRole, type PiThinkingLevel } from "@idd/lane";

/** pi の session id として読める形か（記録のファイルの外を指させない） */
const SESSION_ID = /^[A-Za-z0-9_.-]+$/;

/** The GUI started pi with the plan's values; the spawn record is the engine's to write (the lane's, not this process's). */
export async function POST(req: Request, params: Record<string, string>) {
  try {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return json({ ok: false, error: "sessionId が空です" }, { status: 400 });
    // a session id is a file name under pipeline/sessions: anything else could write outside it
    if (!SESSION_ID.test(sessionId)) return json({ ok: false, error: "sessionId の形が不正です" }, { status: 400 });

    // never replace an engine-owned session's record with a mode's: the ownership the GUI checks before it
    // revives a session would flip, and a second writer would end up on the same session's records
    let existing;
    try {
      existing = readPipelineSession(sessionId);
    } catch (err) {
      return json({ ok: false, error: `既にある記録を読めません: ${String(err)}` }, { status: 409 });
    }
    if (existing && existing.slot !== `mode:${params.name}`) {
      return json({ ok: false, error: "既にある session の記録は置き換えられません" }, { status: 409 });
    }

    const mode = readModes()[params.name];
    if (!mode) return json({ ok: false, error: `config/modes.yaml に "${params.name}" がありません` }, { status: 404 });
    const role = resolveRole(mode.role);
    recordPipelineSession(sessionId, {
      slot: `mode:${params.name}`,
      role: role.name,
      model: role.model,
      agentDir: pipelineAgentDir(role),
      thinkingLevel: role.thinking as PiThinkingLevel,
    });
    return json({ ok: true, sessionId });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 400 });
  }
}
