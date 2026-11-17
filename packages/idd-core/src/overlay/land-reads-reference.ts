/**
 * The landing's four readings as they were written in TypeScript, kept off the running path.
 *
 * The running path reads these answers from the MoonBit fold (`packages/idd-fold/land_reads.mbt`) through
 * `laneAnswer`: the landing card's "can sign", the lane screen's "waits for the merge", the tick's "may merge",
 * and the submit's "the head S3 and R2 saw" all come from that one answer (P-4,
 * C-195-1). What is left here is the reading this file's answers were taken from, and only the cross-check and
 * the tests read it: `crosscheck.mjs` holds the two against a real ledger, and the fixture test holds them over
 * the rows a real ledger rarely carries. Nothing on the running path may import this file.
 *
 * What stays in TypeScript is what a row cannot answer: the signature's key (`passkey.ts` / `pin.ts`), the git
 * tree and the manifest a reviewed head is compared with (`unreviewedChange`), and the records-only refusal
 * (C-195-2).
 */

/** the close an approval records: the destination and the one-liner the tick runs later */
export interface LandCloseReference {
  repo: string;
  issue: number;
  comment: string;
  url: string;
}

/** a lifecycle row, as the readings below take it */
export interface LandRowReference {
  event: string;
  attrs?: Record<string, unknown>;
}

/**
 * The events after an approval that take it back: penne's send-back (her own, or the harness's on a conflict),
 * new work the executor returned, and a new S3 round. An approval older than any of them is no longer in force.
 */
const KILLS_APPROVAL_REFERENCE: readonly string[] = [
  "s4_land_approval_dropped",
  "s4_verify_user_judgment_answered",
  "s2_result",
  "s2_fix_sent",
  "s3_ready",
  "s4_submit_started",
];

/** the close an approval recorded, or undefined when it recorded none */
function readApprovalCloseReference(raw: unknown): LandCloseReference | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const repo = typeof c.repo === "string" ? c.repo : "";
  const issue = Number(c.issue ?? 0);
  const comment = typeof c.comment === "string" ? c.comment : "";
  if (!repo || !Number.isInteger(issue) || issue <= 0 || !comment) return undefined;
  return { repo, issue, comment, url: typeof c.url === "string" ? c.url : "" };
}

/**
 * The approval in force for a lane: the last `s4_land_approved`, valid only while nothing after it took it back
 * and while the lane still stands at the head it approved. Only an approval whose signature was checked counts.
 */
export function currentLandApprovalReference(events: LandRowReference[]): { head: string; at: number; close?: LandCloseReference } | null {
  let at = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event === "s4_land_approved") { at = i; break; }
  if (at < 0) return null;
  if (events[at].attrs?.signed !== true) return null;
  if (events.slice(at + 1).some((e) => KILLS_APPROVAL_REFERENCE.includes(e.event))) return null;
  const head = events[at].attrs?.head;
  if (typeof head !== "string" || !head) return null;
  const close = readApprovalCloseReference(events[at].attrs?.close);
  return { head, at, ...(close ? { close } : {}) };
}

/** why the approved landing has not gone in yet, read by the card, or "" */
export function lastLandHoldReference(events: LandRowReference[]): string {
  const last = [...events].reverse().find((e) => e.event === "s4_land_hold");
  return last ? String(last.attrs?.reason ?? "") : "";
}

function lastIndexReference(evs: LandRowReference[], name: string): number {
  for (let i = evs.length - 1; i >= 0; i -= 1) if (evs[i].event === name) return i;
  return -1;
}

/**
 * The head S3 and R2 last looked at for the current submit: the head the R2 of this S3 reviewed, or, without one,
 * the head the loop's last review looked at, or the head the submit was opened at. A round skipped because the head
 * was only the mainline merged in stands where a review round would, so the head it stood for is read as the
 * review's head.
 */
export function reviewedHeadReference(evs: LandRowReference[]): { commit: string; by: string } | null {
  const r2 = lastIndexReference(evs, "s3_r2_started");
  const r2Head = r2 > lastIndexReference(evs, "s3_ready") ? evs[r2].attrs?.head : undefined;
  if (typeof r2Head === "string" && r2Head) return { commit: r2Head, by: "R2 が見た" };
  const reviewed = Math.max(lastIndexReference(evs, "s2_review_started"), lastIndexReference(evs, "s2_review_merged_skipped"));
  const review = reviewed >= 0 ? evs[reviewed].attrs?.head : undefined;
  if (typeof review === "string" && review) return { commit: review, by: "最後のレビューが見た" };
  const opened = evs[lastIndexReference(evs, "s4_submit_started")]?.attrs?.head;
  return typeof opened === "string" && opened ? { commit: opened, by: "提出前確認を開いたときの" } : null;
}
