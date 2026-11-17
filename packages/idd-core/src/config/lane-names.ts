import type { BacklogRecord } from "../schema/records.ts";

/**
 * A name a repo writes in repos.yaml with values of the lane in braces: one string for every lane, or one
 * per source (a repo that takes in from both Linear and GitHub).
 */
export type NamePattern = string | { linear?: string; github?: string };

/** values a branch name may use */
export const BRANCH_FIELDS = ["idd_id", "idd_id_lower", "linear_id", "linear_identifier", "issue_number"] as const;
/** a branch rule must name at least one of these, or every lane of the repo would get the same branch */
export const LANE_FIELDS = BRANCH_FIELDS;
/** values a commit message may use: the branch's, the PR title as approved, and that title without the lane's own Issue suffix */
export const MESSAGE_FIELDS = [...BRANCH_FIELDS, "title", "summary"] as const;

export type LaneRecord = Pick<BacklogRecord, "idd_id" | "source_type" | "linear_issue_url" | "gh_issue_url">;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** APP-2240 from a Linear Issue URL (with or without the title slug) */
export function linearIdentifierOf(url: string | null | undefined): string | undefined {
  const m = /\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#]|$)/.exec(url ?? "");
  return m ? m[1].toUpperCase() : undefined;
}

/** 12 from a GitHub Issue URL */
export function issueNumberOf(url: string | null | undefined): string | undefined {
  return /\/issues\/(\d+)(?:[/?#]|$)/.exec(url ?? "")?.[1];
}

function laneValues(iddId: string, rec: LaneRecord | undefined): Record<string, string | undefined> {
  const linear = rec?.source_type === "linear" ? linearIdentifierOf(rec.linear_issue_url) : undefined;
  return {
    idd_id: iddId,
    idd_id_lower: iddId.toLowerCase(),
    linear_identifier: linear,
    linear_id: linear?.toLowerCase(),
    issue_number: rec?.source_type === "linear" ? undefined : issueNumberOf(rec?.gh_issue_url),
  };
}

function patternFor(pattern: NamePattern | undefined, source: string | undefined): string | undefined {
  if (pattern === undefined || typeof pattern === "string") return pattern;
  return source === "linear" ? pattern.linear : pattern.github;
}

function expand(pattern: string, values: Record<string, string | undefined>, what: string): string {
  return pattern.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${what} の {${name}} に当たる値がこの lane にありません（${pattern}）。Linear と GitHub で分けるなら { linear: ..., github: ... } で書いてください`);
    return value;
  });
}

/**
 * Check a pattern as repos.yaml has it: a string or a { linear, github } table, using only the named values.
 * The error names the entry so a typo in one repo does not read as a broken registry.
 */
export function parsePattern(where: string, raw: unknown, allowed: readonly string[], varying?: readonly string[]): NamePattern | undefined {
  if (raw === undefined || raw === null) return undefined;
  const check = (field: string, value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field}: 文字列で書いてください`);
    for (const m of value.matchAll(PLACEHOLDER)) {
      if (!allowed.includes(m[1])) throw new Error(`${field}: {${m[1]}} は使えません（使える値: ${allowed.map((a) => `{${a}}`).join(" ")}）`);
    }
    if (varying && ![...value.matchAll(PLACEHOLDER)].some((m) => varying.includes(m[1]))) {
      throw new Error(`${field}: lane ごとに違う値（${varying.map((a) => `{${a}}`).join(" ")} のどれか）を含めてください。含まないとどの lane も同じ branch になります`);
    }
    return value;
  };
  if (typeof raw === "string") return check(where, raw);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: 文字列か { linear, github } の表で書いてください`);
  const table = raw as Record<string, unknown>;
  const unknown = Object.keys(table).filter((k) => k !== "linear" && k !== "github");
  if (unknown.length) throw new Error(`${where}: 知らない欄 ${unknown.join(", ")}（使える欄: linear, github）`);
  return {
    ...(table.linear !== undefined ? { linear: check(`${where}.linear`, table.linear) } : {}),
    ...(table.github !== undefined ? { github: check(`${where}.github`, table.github) } : {}),
  };
}

/**
 * The branch a new lane is made on: the repo's rule when it has one for the lane's source, else feature/
 * with the Linear identifier (feature/app-2240), or the lane id in lower case (feature/idd-012).
 */
export function laneBranchName(pattern: NamePattern | undefined, iddId: string, rec: LaneRecord | undefined): string {
  const values = laneValues(iddId, rec);
  const rule = patternFor(pattern, rec?.source_type);
  if (rule) return expand(rule, values, "branch_name_pattern");
  return values.linear_id ? `feature/${values.linear_id}` : `feature/${values.idd_id_lower}`;
}

/**
 * Whether the branch a lane pushes is the one the repo's declared rule names for it. `rule` is the declared pattern
 * for the lane's source and `expected` the name it gives this lane; both are absent when the repo declares no rule
 * for this lane (the default `feature/…` is not a declaration, so it is not judged). A rule that cannot be filled in
 * for the lane gives no expected name, and the branch does not match.
 */
export function branchNameCheck(pattern: NamePattern | undefined, iddId: string, rec: LaneRecord | undefined, actual: string): { rule?: string; expected?: string; ok: boolean } {
  const rule = patternFor(pattern, rec?.source_type);
  if (!rule) return { ok: true };
  let expected: string | undefined;
  try { expected = expand(rule, laneValues(iddId, rec), "branch_name_pattern"); } catch { expected = undefined; }
  return { rule, ...(expected !== undefined ? { expected } : {}), ok: expected === actual };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the title with the lane's own Issue at its end taken off: "fix: 直す (APP-2240)" -> "fix: 直す" */
function summaryOf(title: string, values: Record<string, string | undefined>): string {
  const own = [values.linear_identifier, values.issue_number ? `#${values.issue_number}` : undefined].filter(Boolean) as string[];
  let summary = title.trim();
  for (const id of own) {
    const suffix = new RegExp(`\\s*\\(${escapeRegExp(id)}\\)$`, "i");
    summary = summary.replace(suffix, "");
  }
  return summary;
}

/** the message of the commit an export makes: the repo's pattern, or the PR title as it was approved */
export function commitMessageFor(pattern: NamePattern | undefined, iddId: string, rec: LaneRecord | undefined, title: string): string {
  const rule = patternFor(pattern, rec?.source_type);
  if (!rule) return title;
  const values = laneValues(iddId, rec);
  return expand(rule, { ...values, title, summary: summaryOf(title, values) }, "commit_message");
}
