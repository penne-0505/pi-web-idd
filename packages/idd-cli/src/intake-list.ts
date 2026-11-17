import type { IntakeCandidate, IssueBlocker, UnassignedIssue } from "../../idd-core/src/index.ts";

/** a blocker as one short token: its ref and the state intake read (`#12(open)`) */
function blockerText(blockers: IssueBlocker[]): string {
  return blockers.map((b) => `${b.ref}(${b.state})`).join(", ");
}

/** Linear's priority number as the name a person reads; 0 is Linear's own «no priority» */
const PRIORITY_NAMES: Record<number, string> = { 0: "なし", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
function priorityText(priority: number): string {
  return PRIORITY_NAMES[priority] ?? String(priority);
}
function estimateText(estimate: number | null): string {
  return typeof estimate === "number" ? String(estimate) : "なし";
}
/** what a person reads to decide on an Issue: shown in the list, never a condition, an order, or a record */
function linearFacts(issue: { estimate: number | null; priority: number }): string {
  return ` — 優先度 ${priorityText(issue.priority)}、見積り ${estimateText(issue.estimate)}`;
}

/** the lines of `idd intake --list`: what a run would open as lanes, what it would leave out, and why */
export function formatIntakeList(list: {
  candidates: IntakeCandidate[];
  skipped: { ref: string; title: string; reason: string }[];
  failures: { area: string; reason: string }[];
  /** dependencies intake read but did not follow (another repo / team) */
  ignoredBlockers?: { ref: string; title: string; blocker: IssueBlocker }[];
  /** unassigned Issues of repos that do not take them in: shown apart, and no lane this run either way */
  unassigned?: UnassignedIssue[];
}): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const held = list.candidates.filter((c) => c.hold);
  for (const c of list.candidates) {
    const facts = c.source === "linear" ? linearFacts({ estimate: c.estimate ?? null, priority: c.priority ?? 0 }) : "";
    // an Issue waiting on an open blocker will not get a lane this run: it is shown apart from the new ones
    if (c.hold) {
      const blockers = c.hold.blockers.length ? ` — blocker: ${blockerText(c.hold.blockers)}` : "";
      stdout.push(`[依存待ち] ${c.ref} ${c.title} (${c.area})${facts} — ${c.hold.reason}${blockers}`);
      continue;
    }
    const mark = c.alreadyInBacklog ? `[${c.alreadyInBacklog}]` : "[new]";
    stdout.push(`${mark} ${c.ref} ${c.title} (${c.area})${facts}`);
  }
  for (const s of list.skipped) stdout.push(`[skip] ${s.ref} ${s.title} — ${s.reason}`);
  for (const d of list.ignoredBlockers ?? []) stdout.push(`[範囲外] ${d.ref} の依存 ${d.blocker.ref}（${d.blocker.scope}）は追いません`);
  // these rows are read only because they were asked for: they are not lanes either way, so they are marked apart
  for (const u of list.unassigned ?? []) {
    stdout.push(`[未アサイン] ${u.ref} ${u.title} (${u.area})${linearFacts(u)} — ${u.area} は未アサインの Issue を取り込みません（設定で取り込めます）`);
  }
  const fresh = list.candidates.filter((c) => !c.alreadyInBacklog && !c.hold).length;
  const wait = held.length ? `、依存待ち ${held.length} 件` : "";
  const extra = list.unassigned?.length ? `、未アサイン ${list.unassigned.length} 件（取り込みません）` : "";
  stdout.push(`${list.candidates.length} 件（新規 ${fresh} 件${wait}）${list.skipped.length ? `、飛ばした Linear の Issue ${list.skipped.length} 件` : ""}${extra}`);
  return { stdout, stderr: list.failures.map((f) => `[fail] ${f.area}: ${f.reason}`) };
}
