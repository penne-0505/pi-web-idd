/**
 * What penne approved on the submit card, read from the request: the push's commit message, a new PR's title and
 * body, and the passkey signature she made over the challenge.
 * Anything else in the request is ignored.
 */
export function shipApprovalOf(payload: Record<string, unknown>): { commitMessage?: string; pr?: { title: string; body: string }; nonce?: string; assertion?: unknown; pinProof?: unknown } {
  const pr = payload.pr && typeof payload.pr === "object" ? payload.pr as { title?: unknown; body?: unknown } : undefined;
  return {
    ...(typeof payload.commitMessage === "string" ? { commitMessage: payload.commitMessage } : {}),
    ...(pr ? { pr: { title: String(pr.title ?? ""), body: String(pr.body ?? "") } } : {}),
    ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
    ...(payload.assertion && typeof payload.assertion === "object" ? { assertion: payload.assertion } : {}),
    ...(payload.pinProof && typeof payload.pinProof === "object" ? { pinProof: payload.pinProof } : {}),
  };
}
