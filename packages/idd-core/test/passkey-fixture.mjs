// A software WebAuthn authenticator for the tests (not a test file itself): a P-256 key in this process, the COSE
// public key, and the registration and assertion responses `@simplewebauthn/server` verifies. The tests sign with
// it and pass the real gates, so what a real passkey would produce is what the tests exercise.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/** a small CBOR encoder for the two shapes WebAuthn needs (a map of strings, numbers, byte strings and maps) */
function cborEncode(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("only integers here");
    if (value >= 0) return value < 24 ? Buffer.from([value]) : value < 256 ? Buffer.from([0x18, value]) : Buffer.from([0x19, value >> 8, value & 0xff]);
    const n = -1 - value;
    return n < 24 ? Buffer.from([0x20 + n]) : n < 256 ? Buffer.from([0x38, n]) : Buffer.from([0x39, n >> 8, n & 0xff]);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([bytes.length < 24 ? Buffer.from([0x60 + bytes.length]) : Buffer.from([0x78, bytes.length]), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([bytes.length < 24 ? Buffer.from([0x40 + bytes.length]) : Buffer.from([0x58, bytes.length]), bytes]);
  }
  if (value instanceof Map) {
    const parts = [Buffer.from([0xa0 | value.size])];
    for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
    return Buffer.concat(parts);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const parts = [Buffer.from([0xa0 | entries.length])];
    for (const [k, v] of entries) parts.push(cborEncode(k), cborEncode(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cannot encode ${String(value)}`);
}

/** the COSE key of a P-256 public key: EC2, ES256, curve P-256, x, y */
function coseEc2(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return cborEncode(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, x], [-3, y],
  ]));
}

/** rpIdHash || flags || signCount, then the attested credential data when the registration makes one */
function authenticatorData(rpId, flags, counter, attested) {
  const head = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter, 33);
  return attested ? Buffer.concat([head, attested]) : head;
}

/**
 * A key in this process. `registration({challenge, origin, rpId})` returns a RegistrationResponseJSON,
 * `assertion({challenge, origin, rpId})` an AuthenticationResponseJSON; the sign count rises by one each assertion.
 */
export function softwareAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  const cose = coseEc2(publicKey);
  let counter = 0;
  return {
    credentialId: b64url(credentialId),
    publicKey: b64url(cose),
    registration({ challenge, origin, rpId }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
      const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, cose]);
      const authData = authenticatorData(rpId, 0x45, 0, attested);
      const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: "public-key", response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) }, clientExtensionResults: {} };
    },
    assertion({ challenge, origin, rpId }) {
      counter += 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const authData = authenticatorData(rpId, 0x05, counter);
      const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
      const signature = sign("sha256", signed, privateKey);
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: "public-key", response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: null }, clientExtensionResults: {} };
    },
  };
}
