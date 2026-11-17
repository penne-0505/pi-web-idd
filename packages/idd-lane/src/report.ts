import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expandHome } from "./paths.ts";

export type Severity = "must" | "should" | "nit";

export type RecommendedAction = "fix" | "followup" | "skip";

export interface Finding {
  severity: Severity;
  path: string;
  line: number | null;
  claim: string;
  evidence: string;
  is_guess: boolean;
  /** the reviewer's recommended handling, on the stages whose report carries it */
  action?: RecommendedAction;
  /** how often the finding is expected to happen, and under what conditions */
  frequency?: string;
  /**
   * the reviewer's how-to-fix, on the stages that read the whole diff. It is read here so a report that carries it
   * is read whole; a report without it (an older one) reads as it always did.
   */
  how?: string;
  /** which lane produced it */
  source?: string;
  /** set by merge when an existing comment already covers it */
  duplicate_of?: string;
}

/** the recommended handling a finding carries, or nothing when the field is absent or malformed */
export function recommendedAction(v: unknown): RecommendedAction | undefined {
  return v === "fix" || v === "followup" || v === "skip" ? v : undefined;
}

export interface ExistingComment {
  id: string;
  author: string;
  body: string;
  path?: string;
}

const SEVERITY_ORDER: Record<Severity, number> = { must: 0, should: 1, nit: 2 };

function tokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[`*_#>|]/g, " ")
      .split(/[^\p{L}\p{N}_.:/-]+/u)
      .filter((t) => t.length >= 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n / Math.min(a.size, b.size);
}

/** character bigrams over a normalized string; word tokens miss Japanese claims (no spaces), bigrams do not */
function bigrams(text: string): Set<string> {
  const n = text.toLowerCase().replace(/[`*_#>|\s、。,.（）()「」]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i += 1) out.add(n.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return (2 * n) / (a.size + b.size);
}

/**
 * Same finding from two lanes: same path and either word overlap ≥ 0.6 or bigram Dice ≥ 0.45.
 * Thresholds calibrated on APP-1837 (4 lanes, 22 findings): every true pair ≥ 0.46, every false pair ≤ 0.35.
 */
export function sameFinding(a: Finding, b: Finding): boolean {
  if (a.path !== b.path) return false;
  if (overlap(tokens(a.claim), tokens(b.claim)) >= 0.6) return true;
  return dice(bigrams(a.claim), bigrams(b.claim)) >= 0.45;
}

export function readFindings(jsonPath: string, source?: string): Finding[] {
  const abs = resolve(expandHome(jsonPath));
  if (!existsSync(abs)) return [];
  const raw = JSON.parse(readFileSync(abs, "utf8")) as { findings?: Finding[]; new_findings?: Finding[] };
  const list = [...(raw.findings ?? []), ...(raw.new_findings ?? [])];
  return list.filter((f) => f && typeof f.claim === "string").map((f) => ({
    severity: (["must", "should", "nit"] as Severity[]).includes(f.severity) ? f.severity : "nit",
    path: String(f.path ?? ""),
    line: typeof f.line === "number" ? f.line : null,
    claim: f.claim,
    evidence: String(f.evidence ?? ""),
    is_guess: Boolean(f.is_guess),
    ...(recommendedAction(f.action) ? { action: recommendedAction(f.action) } : {}),
    ...(typeof f.frequency === "string" && f.frequency.trim() ? { frequency: f.frequency.trim() } : {}),
    ...(typeof f.how === "string" && f.how.trim() ? { how: f.how.trim() } : {}),
    ...(source ? { source } : {}),
  }));
}

/** Split PR comment bodies into per-heading items so each bot finding can be matched individually. */
export function splitComments(comments: { author: string; body: string; created_at?: string }[]): ExistingComment[] {
  const out: ExistingComment[] = [];
  comments.forEach((c, i) => {
    const sections = c.body.split(/\n(?=#{2,4} )/);
    sections.forEach((s, j) => {
      const pathMatch = s.match(/`([\w./-]+\.(?:dart|ts|tsx|md|yaml|yml|py|kt|swift))(?::\d+)?`/);
      out.push({ id: `c${i}-${j}`, author: c.author, body: s, ...(pathMatch ? { path: pathMatch[1] } : {}) });
    });
  });
  return out;
}

export interface MergeResult {
  findings: Finding[];
  duplicates: number;
  by_severity: Record<Severity, number>;
}

/**
 * Merge lane findings, dedupe among lanes, and mark ones already raised in existing comments. Only findings of
 * different lanes are folded: two findings of one lane are two findings, however alike they read (a lane's
 * findings on decision.md share the path and much of the wording).
 */
export function mergeFindings(lists: Finding[][], existing: ExistingComment[] = [], threshold = 0.5): MergeResult {
  const merged: Finding[] = [];
  /** which lists each merged finding already holds one of */
  const from: Set<number>[] = [];
  lists.forEach((list, li) => {
    for (const f of list) {
      const at = merged.findIndex((m, i) => !from[i].has(li) && sameFinding(m, f));
      if (at >= 0) {
        const same = merged[at];
        from[at].add(li);
        if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[same.severity]) same.severity = f.severity;
        if (f.source) {
          // by name, not by substring: plan-reviewer is not plan-reviewer-flash
          const names = (same.source ?? "").split(",").filter(Boolean);
          for (const n of f.source.split(",")) if (n && !names.includes(n)) names.push(n);
          same.source = names.join(",");
        }
        continue;
      }
      merged.push({ ...f });
      from.push(new Set([li]));
    }
  });
  let duplicates = 0;
  for (const f of merged) {
    const ft = tokens(`${f.claim} ${f.evidence}`);
    const base = f.path.split("/").pop() ?? f.path;
    for (const c of existing) {
      const samePath = !c.path || !f.path || c.path.endsWith(base) || f.path.endsWith(c.path.split("/").pop() ?? "");
      if (!samePath) continue;
      if (overlap(ft, tokens(c.body)) >= threshold) { f.duplicate_of = `${c.author}:${c.id}`; duplicates += 1; break; }
    }
  }
  merged.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path));
  const by = { must: 0, should: 0, nit: 0 } as Record<Severity, number>;
  for (const f of merged) if (!f.duplicate_of) by[f.severity] += 1;
  return { findings: merged, duplicates, by_severity: by };
}

/** Render a review draft in the team style: severity label, claim, evidence; nits collapsed. */
export function renderDraft(result: MergeResult, opts: { intro?: string; includeDuplicates?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.intro) { lines.push(opts.intro); lines.push(""); }
  const live = result.findings.filter((f) => opts.includeDuplicates || !f.duplicate_of);
  for (const f of live.filter((f) => f.severity !== "nit")) {
    const loc = f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\`` : "";
    const guess = f.is_guess ? "（推測）" : "";
    lines.push(`**[${f.severity}]** ${f.claim}${loc ? ` ${loc}` : ""}${guess}${f.evidence ? ` ${f.evidence}` : ""}`);
    lines.push("");
  }
  const nits = live.filter((f) => f.severity === "nit");
  if (nits.length) {
    lines.push(`**[nit]** ${nits.map((f) => `${f.claim}${f.path ? `（\`${f.path}${f.line ? `:${f.line}` : ""}\`）` : ""}`).join(" ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
