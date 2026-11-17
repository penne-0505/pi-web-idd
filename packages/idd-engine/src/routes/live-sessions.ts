import { json } from "../http.ts";
import { livePiConversationIds } from "@idd/lane";

/** The engine's running pi conversations: the sidebar lists pi sessions, so the claude ones stay out. */
export async function GET() {
  return json({ ids: livePiConversationIds() }, { headers: { "Cache-Control": "no-store" } });
}
