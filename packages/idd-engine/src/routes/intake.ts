
import { json } from "../http.ts";
import { parseIssueRef, runIntake, type IssueRef } from "@idd/core";
import { kickTickAfterRecord } from "../server/tick-kick";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    // an entry is a number, "owner/name#N" to name one repo's Issue, or a Linear identifier such as "APP-12"
    const issues: IssueRef[] = Array.isArray(body?.issues)
      ? body.issues.flatMap((n: unknown) => (Number.isInteger(n) ? [{ number: n as number }] : typeof n === "string" ? [parseIssueRef(n)].filter((r): r is IssueRef => r !== null) : []))
      : [];
    const result = await runIntake(issues.length ? { issueRefs: issues } : {});
    // a lane taken in by hand starts its planner on the next tick
    if (result.added.length) kickTickAfterRecord();
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
}
