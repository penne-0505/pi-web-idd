// Shared helper for the outbound tests (not a test file itself): the approval with the verified nonce for exactly
// what the poster will write, so the tests about posting behavior pass the passkey gate. The dedicated tamper
// tests sign with a software key (`packages/idd-core/test/passkey-fixture.mjs`) instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createChallenge } from "../../idd-core/src/passkey.ts";
import { approveOutbound, ghPoster, outboundContentFor, readOutbound, resolveOutboundFinal, type Approval, type Poster } from "../src/outbound.ts";

function stateFile(): string {
  return join(process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state"), "passkey", "state.json");
}

/** the approval with the verified nonce for exactly the content the gate will rebuild */
export function approvedForPosting(id: string, final: Approval): Approval {
  const rec = readOutbound(id);
  if (!rec) return final;
  const resolved = resolveOutboundFinal(rec, final);
  if (!resolved.ok) return final;
  const content = outboundContentFor(rec, resolved.text, resolved.event);
  const { nonce } = createChallenge(content);
  const path = stateFile();
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  state.nonces = { ...(state.nonces ?? {}), [nonce]: { ...(state.nonces?.[nonce] ?? {}), verified: true } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
  return { ...final, nonce };
}

/** the approval the tests made before the passkey gate, with the approval signed */
export function approveSigned(id: string, final: Approval, poster: Poster = ghPoster) {
  return approveOutbound(id, approvedForPosting(id, final), poster);
}
