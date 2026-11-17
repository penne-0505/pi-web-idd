// Shared helpers for the tests that call the export or the ship with an approval (not a test file itself): they
// make a challenge for exactly the content the gate will write and mark it verified, so the gate opens the way a
// real signature would. The dedicated gate tests sign with `passkey-fixture.mjs` instead: here the subject is the
// export's own behavior.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createChallenge } from "../src/passkey.ts";
import { landContentFor, readLand } from "../src/overlay/land.ts";
import { laneLocations, readProposal, shipContentFor } from "../src/overlay/export.ts";
import { localCompleteContentFor } from "../src/plan/ship.ts";

function stateFile() {
  return join(process.env.IDD_STATE_DIR?.trim() || join(process.cwd(), "state"), "passkey", "state.json");
}

function markVerified(nonce) {
  const path = stateFile();
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  state.nonces = { ...(state.nonces ?? {}), [nonce]: { ...(state.nonces?.[nonce] ?? {}), verified: true } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

function verifiedNonce(iddId, approval) {
  const saved = readProposal(iddId);
  const loc = laneLocations(iddId);
  if (!saved || !loc) return undefined;
  // a local completion's signature is over its own content, not the push's
  const content = saved.mode === "local"
    ? localCompleteContentFor(saved)
    : shipContentFor(iddId, saved, loc, {
      commitMessage: approval.message ?? approval.commitMessage,
      pr: approval.pr,
    });
  const { nonce } = createChallenge(content);
  markVerified(nonce);
  return nonce;
}

/** a push approval (`PushApproved`) with the verified nonce for exactly what the export will write */
export function pushApproval(iddId, approval = {}) {
  const nonce = verifiedNonce(iddId, approval);
  return { ...approval, ...(nonce ? { nonce } : {}) };
}

/** a submit approval (`ShipApproval`) with the verified nonce for exactly what the ship will write */
export function shipApproved(iddId, approval = {}) {
  const nonce = verifiedNonce(iddId, approval);
  return { ...approval, ...(nonce ? { nonce } : {}) };
}

/** a landing approval (`approveLand`) with the verified nonce for exactly the content the landing checks */
export function landApproved(iddId, approval = {}) {
  const saved = readLand(iddId);
  if (!saved) return { ...approval };
  const { nonce } = createChallenge(landContentFor(saved));
  markVerified(nonce);
  return { ...approval, nonce };
}

/** a verified nonce for an arbitrary content: the tests sign something the gate will not rebuild */
export function verifiedNonceFor(content) {
  const { nonce } = createChallenge(content);
  markVerified(nonce);
  return nonce;
}
