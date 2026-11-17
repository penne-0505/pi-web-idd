import { json } from "../http.ts";
import { buildWork, buildWorkDecisions, buildWorkFindings, buildWorkRecord } from "../server/work";
import { replayDerived } from "../server/derived";
import { derivedOverlay, requestDerivationIfChanged } from "../server/derived-service";
import { jsonlCacheRevision } from "@idd/core";
import { filterConsumption, liveConversationIds, readConsumption, summarizeConsumption } from "@idd/lane";

/**
 * The Work screen's one read. It is read every few seconds, so no lane cost is read and nothing is written; an
 * unreadable state answers 500 rather than an empty list, so the screen keeps its last picture and shows the band.
 * git and the worktrees come from the last derivation, so an answer costs what the ledger costs.
 */
export function GET() {
  try {
    const revision = jsonlCacheRevision();
    const view = buildWork({ liveSessions: new Set(liveConversationIds()) }, replayDerived(derivedOverlay()));
    requestDerivationIfChanged(revision);
    return json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/** The DECs of one lane: refused for an id no ledger lane has, before any file is read */
export function DECISIONS(_req: Request, params: Record<string, string>) {
  const { id } = params;
  try {
    const view = buildWorkDecisions(id);
    if (!view) return json({ error: "not found", lane: id }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error), lane: id }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/** One lane's record: its AC states, verification log and findings. Refused before any file is read for an id the ledger does not have. */
export function RECORD(_req: Request, params: Record<string, string>) {
  const { id } = params;
  try {
    const view = buildWorkRecord(id);
    if (!view) return json({ error: "not found", lane: id }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error), lane: id }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/** The open findings that hold the given paths of one repo. Refused for a repo the settings do not have. */
export function FINDINGS(req: Request) {
  try {
    const url = new URL(req.url);
    const view = buildWorkFindings({
      repo: url.searchParams.get("repo") ?? "",
      paths: url.searchParams.getAll("path"),
      ...(url.searchParams.get("view_lane") ? { viewLane: url.searchParams.get("view_lane") as string } : {}),
    });
    if (!view) return json({ error: "not found", repo: url.searchParams.get("repo") ?? "" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * What the lanes' contracts used, read from the append-only consumption rows. Read-only: the door writes nothing,
 * so the screen and the CLI may call it as often as they like.
 */
export function CONSUMPTION(req: Request) {
  try {
    const url = new URL(req.url);
    const rows = filterConsumption(readConsumption(), {
      ...(url.searchParams.get("since") ? { since: url.searchParams.get("since") as string } : {}),
      ...(url.searchParams.get("lane") ? { lane: url.searchParams.get("lane") as string } : {}),
    });
    return json({ rows, summary: summarizeConsumption(rows) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ error: String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
