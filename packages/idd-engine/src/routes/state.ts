import { json, jsonUnlessSame } from "../http.ts";
import { stateAnswer } from "../server/state-events";

/**
 * The state picture. The ledger is read here and now (it is what a judgment just wrote); git and the worktrees come
 * from the last derivation, so this answer never waits for them. The same builder answers the stream, so a screen
 * reading here and a screen receiving there are given the same picture — the number it carries is what a screen
 * keeps to throw away an answer built before a judgment it has already sent.
 */
export async function GET(req?: Request) {
  try {
    const frame = await stateAnswer();
    return jsonUnlessSame(req, frame.state, { headers: { "Cache-Control": "no-cache", "x-idd-seq": String(frame.seq) } });
  } catch (error) {
    return json(
      { source: "empty", error: String(error), cron: null, sections: [], lanes: [], items: [] },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
