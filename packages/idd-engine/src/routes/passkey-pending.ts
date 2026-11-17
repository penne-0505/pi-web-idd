import { json } from "../http.ts";
import { isLoopbackRequest } from "../request-connection.ts";
import { approvePendingRegistration, listPendingRegistrations } from "@idd/core";


/**
 * The registrations that verified but still wait for an already registered key's signature. The list carries the
 * pending ids and the challenges an approving key signs, so only the request the local screen sent may read it;
 * the approval itself runs on the same screen (POST below).
 */
export async function GET(req: Request) {
  if (!isLoopbackRequest(req)) return json({ ok: false, error: "保留の一覧は手元の画面からだけ読めます" }, { status: 403 });
  try {
    return json({ ok: true, pending: listPendingRegistrations() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/** approve one pending registration with a registered key's signature over its ID, public key and RP ID */
export async function POST(req: Request) {
  let body: { id?: unknown; assertion?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "保留の id がありません" }, { status: 400 });
  // the approval is a step of the local screen: a request the tailnet listener accepted cannot approve a key,
  // whatever key signs it
  const localScreen = isLoopbackRequest(req);
  if (!localScreen) return json({ ok: false, error: "保留の承認は手元の画面からだけ行えます" }, { status: 403 });
  try {
    const result = await approvePendingRegistration(id, body.assertion, localScreen);
    return json({
      ok: result.ok,
      ...(result.ok ? { credential: result.credential } : { error: result.error }),
      pending: listPendingRegistrations(),
    }, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}
