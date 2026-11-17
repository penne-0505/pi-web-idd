import { json } from "../http.ts";
import { proposeImport, reviewImport, importUpstream, reclaimLane, cancelImport, setLaneBase, receiveBase } from "@idd/core";
import { kickTickAfterRecord } from "../server/tick-kick";
import { ensureAgentRunner } from "../server/agent-runner";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const area = String(body.area ?? "");
    const options = { laneId: body.laneId as string | undefined, branch: body.branch as string | undefined };
    // the receive asks the agent runtime whether a session works in the lane's checkout
    if (body.action === "receive-base") ensureAgentRunner();
    const result = body.action === "prepare" ? proposeImport(area, options)
      : body.action === "review" ? await reviewImport(area, options)
      : body.action === "accept" ? importUpstream(area, String(body.token ?? ""), options)
      : body.action === "cancel" ? cancelImport(area, options)
      : body.action === "reclaim" ? reclaimLane(String(body.laneId ?? ""))
      // the lane's base (a stacked PR): a lane id or a branch; recorded only, the branch moves on a receive
      : body.action === "receive-base" ? await receiveBase(String(body.laneId ?? ""))
      : body.action === "stack" ? await setLaneBase(String(body.laneId ?? ""), { ...(body.onLane ? { lane: String(body.onLane) } : {}), ...(body.onBranch ? { branch: String(body.onBranch) } : {}) }, "manual")
      : { error: "未対応の操作です" };
    const ok = !("error" in result) && (!("ok" in result) || result.ok);
    // an import brings in merges the tick's close records, and a reclaim lets the tick retire the lane
    if (ok && (body.action === "accept" || body.action === "reclaim")) kickTickAfterRecord();
    return json({ ...result, ok }, { status: ok ? 200 : 400 });
  } catch (e) { return json({ ok: false, error: String(e) }, { status: 400 }); }
}
