import { execFile } from "node:child_process";

import { readSectionAt, sectionHash, type ConventionKind, type Conventions, type DraftedSection, type SectionRef } from "../config/conventions.ts";

/**
 * What a check found of one section the repo points at, as the public base has it. The text is not kept: `hash` is
 * the section's hash, and `baseline` the hash the earlier draft was made under, so the card can say the section moved
 * since without a copy of its words that would outlive the rule.
 */
export interface ConventionReading {
  kind: ConventionKind;
  file: string;
  section: string;
  found: boolean;
  /** why it was not found: the base has no such file, the file has no such heading, or the heading has no body */
  missing?: "file" | "section" | "body";
  hash?: string;
  /** the hash the previous draft of this lane was made under; absent when there was none to compare with */
  baseline?: string;
}

/**
 * The sections the drafts of this submit read, from the lane's events: the PR text is drafted once for a submit and the
 * commit message once for a head, so a PR draft of the round and the commit draft of `head` are the ones the card's
 * text came from. A draft that recorded no section (the repo points at none, or the base had none) adds nothing.
 */
export function draftedConventions(events: readonly { event: string; attrs?: Record<string, unknown> }[], head: string): DraftedSection[] {
  const start = Math.max(0, events.map((e) => e.event).lastIndexOf("s4_submit_started"));
  const out = new Map<ConventionKind, DraftedSection>();
  for (const e of events.slice(start)) {
    const own = e.event === "s4_pr_drafted" || (e.event === "s4_commit_drafted" && e.attrs?.head === head);
    const list = e.attrs?.conventions;
    if (!own || !Array.isArray(list)) continue;
    for (const d of list as Partial<DraftedSection>[]) {
      if (typeof d?.kind === "string" && typeof d.file === "string" && typeof d.section === "string" && typeof d.hash === "string") out.set(d.kind, d as DraftedSection);
    }
  }
  return [...out.values()];
}

/**
 * Read every section the repo points at from `ref` (the fetched public base of the lane's repo, in `repo`).
 * The baseline is the hash the draft of this head read, when one did. Without one, `previous` (the lane's earlier
 * check) gives it: a check of the same head keeps the earlier baseline (a section edited meanwhile stays "changed" until
 * the head moves), another head starts from the hash the earlier check saw.
 */
export function readConventions(repo: string, ref: string, pointers: Conventions, previous: { head: string; conventions?: ConventionReading[] } | null, head: string, drafted: readonly DraftedSection[] = []): ConventionReading[] {
  return (Object.entries(pointers) as [ConventionKind, SectionRef][]).map(([kind, pointer]) => {
    const read = readSectionAt(repo, ref, pointer);
    const earlier = previous?.conventions?.find((c) => c.kind === kind && c.file === pointer.file && c.section === pointer.section);
    const under = drafted.find((d) => d.kind === kind && d.file === pointer.file && d.section === pointer.section)?.hash;
    const baseline = under ?? (earlier ? (previous!.head === head ? earlier.baseline ?? earlier.hash : earlier.hash) : undefined);
    return {
      kind, file: pointer.file, section: pointer.section,
      found: read.found,
      ...(read.found ? { hash: sectionHash(read.text) } : { missing: read.missing }),
      ...(baseline ? { baseline } : {}),
    };
  });
}

/** whether the section's text is not the one the earlier draft was made under */
export function sectionChanged(reading: ConventionReading): boolean {
  return reading.found && reading.baseline !== undefined && reading.baseline !== reading.hash;
}

/** how many merged PRs are read as the team's practice */
export const MERGED_PR_LIMIT = 10;

/** how many merged PRs are asked of GitHub before the latest merged are picked: `gh pr list` orders by creation, not by merge */
const MERGED_PR_FETCH = 50;

/**
 * The titles of the repo's most recently merged PRs, latest merge first (by anyone: the author is not a filter, so a bot's
 * PR is as much the practice as a person's; no merged PR is an empty list), or undefined when GitHub cannot be asked.
 * Asked without blocking the event loop.
 */
export function recentMergedTitles(cwd: string, repo: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(process.env.IDD_GH_BIN?.trim() || "gh", ["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(MERGED_PR_FETCH), "--json", "title,mergedAt"], { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const prs = JSON.parse(stdout) as { title?: unknown; mergedAt?: unknown }[];
        const mergedAt = (p: { mergedAt?: unknown }) => (typeof p.mergedAt === "string" ? Date.parse(p.mergedAt) || 0 : 0);
        const titled = prs.map((p, i) => ({ p, i })).filter((x) => typeof x.p.title === "string" && (x.p.title as string).trim());
        const latest = titled.sort((a, b) => mergedAt(b.p) - mergedAt(a.p) || a.i - b.i).slice(0, MERGED_PR_LIMIT).map((x) => x.p);
        resolve(latest.map((p) => (p.title as string).trim()));
      } catch {
        resolve(undefined);
      }
    });
  });
}
