
import { json } from "../http.ts";
import { buildLaneDetail } from "../server/state";
import { buildReviewLaneDetail, isReviewLaneId } from "../server/review-detail";
import { ensureAgentRunner } from "../server/agent-runner";
import { liveConversationIds } from "@idd/lane";


export async function GET(_req: Request, params: Record<string, string>) {
  const { id } = params;
  try {
    // a review lane (someone else's PR) keeps its own record; everything else is an Issue lane, whose
    // planner / executor spend is asked of the runner
    let lane;
    if (isReviewLaneId(id)) lane = await buildReviewLaneDetail(id);
    else {
      ensureAgentRunner();
      lane = await buildLaneDetail(id, { liveSessions: new Set(liveConversationIds()) });
    }
    if (!lane) return json({ error: "not found", iddId: id }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return json(lane, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error), iddId: id }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
