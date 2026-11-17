import { json } from "../http.ts";
import { isLoopbackRequest, requestHost, requestOriginHost } from "../request-connection.ts";
import { acceptedOriginsHint, createRegistrationOptions, finishRegistration, isPasskeyRpId, listPasskeys, pageHostsMatch, passkeyCredentialIds, passkeyRpId } from "@idd/core";


/** the registered passkeys and where they are used: the page lists them and offers registration */
export async function GET(req?: Request) {
  try {
    const query = req ? new URL(req.url).searchParams.get("rpId")?.trim().toLowerCase() : null;
    const rpId = query || passkeyRpId();
    if (!isPasskeyRpId(rpId)) {
      return json({ ok: false, error: `この RP ID では登録できません。受ける画面は ${acceptedOriginsHint()} です` }, { status: 400 });
    }
    return json({ ok: true, registered: listPasskeys(), rpId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/**
 * Registration in steps. `options` starts one under the RP ID the page names (the local one when it names none);
 * `finish` verifies the creation. The first key is taken on its own; once one is registered, the answer carries the
 * challenge an already registered key signs over the new key's ID, public key and RP ID, and the verified key is
 * held as pending until that word arrives — in the same call, or later from the screen that can sign it.
 */
export async function POST(req: Request) {
  let body: { step?: unknown; nonce?: unknown; response?: unknown; name?: unknown; rpId?: unknown; proof?: { nonce?: unknown; assertion?: unknown } };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON を読めません" }, { status: 400 });
  }
  const step = String(body.step ?? "");
  const requestedRpId = body.rpId === undefined ? passkeyRpId() : String(body.rpId).trim().toLowerCase();
  try {
    if (step === "options") {
      if (!isPasskeyRpId(requestedRpId)) {
        return json({ ok: false, error: `この RP ID では登録できません。受ける画面は ${acceptedOriginsHint()} です` }, { status: 400 });
      }
      // the RP ID the page names has to be the host the request itself names: naming another host's RP ID is refused
      if (!namedRpIdMatchesRequest(req, requestedRpId)) {
        return json({ ok: false, error: `この RP ID は要求の Host / Origin と合いません。受ける画面は ${acceptedOriginsHint()} です` }, { status: 400 });
      }
      const { nonce, options } = createRegistrationOptions(requestedRpId);
      return json({ ok: true, nonce, options, registered: listPasskeys() });
    }
    if (step === "finish") {
      const result = await finishRegistration({
        nonce: typeof body.nonce === "string" ? body.nonce : undefined,
        response: body.response,
        name: typeof body.name === "string" ? body.name : undefined,
        // the local screen is the connection the request arrived on, read here; the module never trusts the
        // response's own clientDataJSON origin for it
        localScreen: isLoopbackRequest(req),
        requestHost: requestHost(req) ?? undefined,
        requestOriginHost: requestOriginHost(req) ?? undefined,
        proof: body.proof ? { nonce: typeof body.proof.nonce === "string" ? body.proof.nonce : undefined, assertion: body.proof.assertion } : undefined,
      });
      const proofRpId = result.proof?.rpId ?? requestedRpId;
      return json({
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        ...(result.needsProof ? { needsProof: true } : {}),
        ...(result.pending ? { pending: true } : {}),
        ...(result.proof ? { proof: { ...result.proof, rpId: proofRpId, allowCredentials: passkeyCredentialIds(proofRpId).map((id) => ({ id, type: "public-key" })) } } : {}),
        ...(result.credential ? { credential: result.credential } : {}),
        registered: listPasskeys(),
      }, { status: result.ok ? 200 : 400 });
    }
    return json({ ok: false, error: "step は options / finish のいずれかです" }, { status: 400 });
  } catch (error) {
    return json({ ok: false, error: String(error) }, { status: 500 });
  }
}

/** the RP ID the page names has to be the host the request itself names (loopback names are the same page) */
function namedRpIdMatchesRequest(req: Request, rpId: string): boolean {
  const originHost = requestOriginHost(req);
  if (originHost) return pageHostsMatch(originHost, rpId);
  const host = requestHost(req);
  return host ? pageHostsMatch(host, rpId) : true;
}
