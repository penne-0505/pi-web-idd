import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The credential each conversation's agent carries, minted by this engine process and held only in its memory. The
 * agent token is one file every agent on the machine can read, so it cannot say which session is calling; this one is
 * handed to a conversation's own child process alone, so a caller that presents it is that conversation. A lane's
 * agent is never given one, and a credential does not outlive the engine: a pi that survives a restart is refused
 * until it is started again.
 */
const credentials = new Map<string, string>();

function credentialOf(sessionId: string): string {
  let credential = credentials.get(sessionId);
  if (!credential) {
    credential = randomBytes(24).toString("base64url");
    credentials.set(sessionId, credential);
  }
  return credential;
}

/** whether what a caller presented is the credential this engine gave that conversation's session */
export function conversationCredentialMatches(sessionId: string, presented: string | null | undefined): boolean {
  const expected = credentials.get(sessionId);
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The identity a conversation's agent carries in its environment. It is a session, never a lane: an engine started
 * from inside a lane inherits that lane's `IDD_ID`, and a conversation that kept it would be taken for the lane's own
 * session, and refused the one door a conversation has onto the user's instructions (a lane proposes nothing). The
 * conversation's own session id rides as `IDD_SESSION_ID`, which the CLI names the caller by, and its credential as
 * `IDD_SESSION_TOKEN`, which the door checks against the session the caller names.
 */
export function withConversationIdentity(env: NodeJS.ProcessEnv, sessionId?: string): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.IDD_ID;
  delete out.IDD_RUN_LANE;
  delete out.IDD_HOLD_TOKEN;
  delete out.IDD_SESSION_TOKEN;
  if (sessionId) {
    out.IDD_SESSION_ID = sessionId;
    out.IDD_SESSION_TOKEN = credentialOf(sessionId);
  } else delete out.IDD_SESSION_ID;
  return out;
}
