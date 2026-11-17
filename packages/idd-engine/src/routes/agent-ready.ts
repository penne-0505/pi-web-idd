
import { json } from "../http.ts";
import { agentReady } from "@idd/core";
import { authorize } from "../server/agent-auth";
import { kickTickAfterRecord } from "../server/tick-kick";

export async function POST(req: Request) {
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const result = await agentReady({
      iddId: String(body.idd_id ?? ""),
      plannerSessionId: body.planner_session_id ? String(body.planner_session_id) : undefined,
      decCount: Number(body.dec_count ?? 0),
      invCount: Number(body.inv_count ?? 0),
      qaCount: Number(body.qa_count ?? 0),
      referenceCount: Number(body.reference_count ?? 0),
      // the planner's three plain lines; a ready without them (the older form) is taken as it was
      summary: body.summary,
      // the depth's three fields: the size and harm the planner judged, and the depth it decided
      size: body.size,
      harm: body.harm,
      depth: body.depth,
      // the six-kind table; required, and a lane that touches a kind of harm must come with a High qa
      riskTable: body.risk_table,
      // the impact on existing intent; required, with `decisions: []` for a lane that judged none
      intentImpact: body.intent_impact,
      // the planner's dispositions of the open findings its paths hold; required when any is open
      findings: body.findings,
      // the "1本" reason; required once the lane has a granularity proposal
      granularityReason: body.granularity_reason,
    });
    if (result.ok) kickTickAfterRecord();
    return json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
