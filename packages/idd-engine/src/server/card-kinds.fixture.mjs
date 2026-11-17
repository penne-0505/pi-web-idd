/** Cards of each kind the engine returns, shared by the engine's and the screen's tests of the answer on a card. */
export const AT = "2026-10-05T11:30:00Z";
const ref = { kind: "lane", label: "#1" };

/** one card of each of the fourteen kinds the engine returns */
export const FOURTEEN = [
  { kind: "duplicate", iddId: "RV-1", reviewId: "RV-1", incoming: { title: "a", ref }, existing: { title: "b", ref }, similarity: 1, reason: "r" },
  { kind: "question", iddId: "#1", batchId: "b1", open: [{ questionId: "q1", question: "?", facts: [], options: [{ index: 1, label: "a" }] }], askedTotal: 1, answeredCount: 0 },
  { kind: "granularity", iddId: "#1", title: "t", proposal: { kind: "split", reason: "r", approvable: true, limit: 4, children: [{ title: "c", whole: "w", places: [], after: [] }] } },
  { kind: "go", iddId: "#1", title: "t", decisions: [], criteria: [] },
  { kind: "review", iddId: "#1", target: { title: "t", ref }, diffFiles: [], criteria: [] },
  { kind: "ship", iddId: "#1", title: "t", branch: { from: "a", to: "b", repo: "r" }, pr: { title: "t", body: [], commits: [] }, checks: [] },
  { kind: "land-batch", iddId: "batch:x", title: "t", repo: "/w", repoName: "r", workBase: "main", lanes: [] },
  { kind: "outbound", iddId: "#1", outKind: "gh-issue", targetLabel: "T", title: "t", draft: "d", proposed: "p", createdAt: AT },
  { kind: "stuck", iddId: "#1", title: "t", reason: "r", open: [], escalated: [], oscillations: [], rejected: [], fixRounds: 1 },
  { kind: "requeue", iddId: "#1", title: "t", from: "#0", context: "c" },
  { kind: "storage", cleanup: false, minFreeGb: 10, freeBytes: 1, totalBytes: 2, topPlaces: [], candidateCount: 0, candidateBytes: 0, heldLanes: [] },
  { kind: "reload", iddId: "engine-reload", title: "t", waiting: "conversations", open: [{ sessionId: "s", title: "会話" }], requests: [], waitedMs: 60000 },
  { kind: "proposal", proposalId: "P-1", proposalKind: "overview", repo: "r", handle: "h", reason: "w", before: [], after: [], from: { at: AT }, effect: "now" },
  { kind: "sync_conflict", repo: "r", conflictId: "CF-1", unit: "project_body", subject: "PRJ-1", label: "l", external: "e", base: "b", propter: "p" },
];
