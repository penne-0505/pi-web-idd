
import { json } from "../http.ts";
import { parseIssueRef, runTick, type IssueRef } from "@idd/core";
import { ensureAgentRunner } from "../server/agent-runner";
import { bookTickIfPending } from "../server/tick-kick";

export async function POST(req: Request) {
  ensureAgentRunner();
  try {
    const body = await req.json().catch(() => ({}));
    // an entry is a number, "owner/name#N" to name one repo's Issue, or a Linear identifier such as "APP-12"
    const issues: IssueRef[] = Array.isArray(body?.issues)
      ? body.issues.flatMap((n: unknown) => (Number.isInteger(n) ? [{ number: n as number }] : typeof n === "string" ? [parseIssueRef(n)].filter((r): r is IssueRef => r !== null) : []))
      : [];
    const result = await runTick({
      intake: body.intake !== false,
      ...(issues.length ? { issueRefs: issues } : {}),
      // a kick from a finished lane names the state it belongs to; a server keeping another state does nothing
      ...(typeof body.for_state === "string" && body.for_state ? { forState: body.for_state } : {}),
    });
    // a request still there when the lock was let go gets a tick of its own
    bookTickIfPending(result);
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
