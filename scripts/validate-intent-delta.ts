// Deno版 intent-delta presence validator: 「code diff か、repo が宣言した危ないパスの diff があるのに、qa の文書の
// 変更（lane の外の手の変更なら Choice か Waive を持つ Round）が伴わない」を機械検査する。常時 ON ループの Tier 1 の背骨。
// lane の Choice の記録と Waive は Harness の状態にあり、巡ごとの有無は `idd intent check` の round の規則が見る。
// 併せて、repo が宣言した危ないパス（IDD_RISK_PATHS）への変更に Risk High 下限を適用する。検査は既定の危ないパスを持たない
// （workflow.md の「repo の risk の宣言」）。下限は、qa の frontmatter の risk か、diff が足した Round の Risk で満たす。
// 比較基準: DD_DELTA_BASE (git ref)。未設定なら HEAD (working tree + staged + untracked)。

import { roundRiskWord } from "./round-fields.ts";

type Finding = {
  message: string;
};

const CODE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".dart",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".sh",
  ".fish",
  ".sql",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
] as const;

// The six kinds of harm Risk High is about (workflow.md の Risk 分類). The repo declares its own dangerous paths by kind in
// config/repos.yaml's `risk_paths`, and the harness hands the declaration down in IDD_RISK_PATHS. The key is fixed.
const RISK_KEYS = [
  "auth",
  "authz",
  "billing",
  "permission",
  "data_loss",
  "secret",
] as const;

type RiskPaths = Record<string, string[]>;

const QA_FILE_RE = /^_docs\/qa\/.+\.md$/;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const isCode = (path: string): boolean =>
  CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

const gitLines = async (args: string[]): Promise<string[] | null> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    return null;
  }
  if (!output.success) return null;
  return new TextDecoder()
    .decode(output.stdout)
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
};

const deltaBase = (): string | undefined => {
  try {
    return Deno.env.get("DD_DELTA_BASE")?.trim() || undefined;
  } catch {
    return undefined;
  }
};

const changedPaths = async (): Promise<string[] | null> => {
  const base = deltaBase();
  if (base) {
    return await gitLines(["diff", "--name-only", `${base}...HEAD`]);
  }
  const tracked = await gitLines(["diff", "--name-only", "HEAD"]);
  if (tracked === null) return null;
  const untracked = await gitLines([
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return [...new Set([...tracked, ...(untracked ?? [])])];
};

const frontMatterRisk = async (path: string): Promise<string | null> => {
  let src: string;
  try {
    src = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const lines = src.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") break;
    const match = lines[i].match(/^risk:\s*(\S+)/);
    if (match) return match[1];
  }
  return null;
};

/** a file's text at a git revision, or null when the revision does not hold it */
const textAt = async (rev: string, path: string): Promise<string | null> => {
  try {
    const output = await new Deno.Command("git", {
      args: ["show", `${rev}:${path}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return output.success ? new TextDecoder().decode(output.stdout) : null;
  } catch {
    return null;
  }
};

/** the revision the diff is taken from: the merge base with DD_DELTA_BASE, else HEAD */
const baseRevision = async (): Promise<string> => {
  const base = deltaBase();
  if (!base) return "HEAD";
  return (await gitLines(["merge-base", base, "HEAD"]))?.[0] ?? base;
};

/** the rounds of a qa document's Rounds section, each with its heading line and body */
const roundsOf = (src: string): { heading: string; block: string }[] => {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Rounds");
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^##\s+/.test(line));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end);
  const out: { heading: string; block: string }[] = [];
  for (const line of body) {
    if (/^###\s+Round\b/.test(line)) {
      out.push({ heading: line.trim(), block: "" });
    } else if (out.length) out[out.length - 1].block += `${line}\n`;
  }
  return out;
};

/**
 * The Risk of each round the diff added to a qa document (a heading the base did not have). A maintenance.md holds
 * rounds of every weight under one frontmatter, so a change on a declared dangerous path meets the floor with its
 * own round's Risk (`- **Risk**: High`) as well as with the document's.
 */
const addedRoundRisks = async (path: string): Promise<string[]> => {
  let current: string;
  try {
    current = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  const before = await textAt(await baseRevision(), path);
  const known = new Set(before ? roundsOf(before).map((r) => r.heading) : []);
  return roundsOf(current)
    .filter((r) => !known.has(r.heading))
    .map((r) => roundRiskWord(r.block) ?? "")
    .filter(Boolean);
};

/**
 * The repo's declared dangerous paths, read from IDD_RISK_PATHS: null when the harness passed none (every repo
 * without a declaration, and the engine's own checks), an error message when a passed value cannot be read (a
 * broken declaration read as "no declaration" would silently drop the floor).
 */
const declaredRiskPaths = ():
  | { paths: RiskPaths }
  | { error: string }
  | null => {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("IDD_RISK_PATHS")?.trim() || undefined;
  } catch {
    raw = undefined;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: `IDD_RISK_PATHS が読めません（JSON として解釈できません）`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error:
        "IDD_RISK_PATHS が読めません（種類ごとのパスの一覧ではありません）",
    };
  }
  const paths: RiskPaths = {};
  for (
    const [key, value] of Object.entries(parsed as Record<string, unknown>)
  ) {
    if (!(RISK_KEYS as readonly string[]).includes(key)) {
      return { error: `IDD_RISK_PATHS に未知の種類があります: ${key}` };
    }
    if (
      !Array.isArray(value) ||
      value.some((p) => typeof p !== "string" || !p.trim())
    ) {
      return { error: `IDD_RISK_PATHS.${key} がパスの一覧ではありません` };
    }
    paths[key] = (value as string[]).map((p) => p.trim()).filter(Boolean);
  }
  return { paths };
};

/** the declared kinds each changed path falls under, one line per path, kinds in the declaration's order */
const declaredHits = (
  declared: RiskPaths,
  paths: string[],
): { kind: string; path: string }[] => {
  const out: { kind: string; path: string }[] = [];
  for (const path of paths) {
    for (const kind of RISK_KEYS) {
      if (
        (declared[kind] ?? []).some((prefix) =>
          prefix && path.startsWith(prefix)
        )
      ) {
        out.push({ kind, path });
      }
    }
  }
  return out;
};

const run = async (): Promise<void> => {
  const paths = await changedPaths();
  if (paths === null) {
    console.warn(
      "WARN: validate-intent-delta could not run git (need --allow-run=git); skipping",
    );
    return;
  }

  const codeChanges = paths.filter(isCode);
  const qaChanges = paths.filter((path) => QA_FILE_RE.test(path));
  const findings: Finding[] = [];

  // a passed-but-unreadable declaration fails the check: reading it as "no declaration" would drop the floor
  const declared = declaredRiskPaths();
  if (declared && "error" in declared) {
    console.error(`ERROR: (diff)\n  - ${declared.error}`);
    Deno.exit(1);
  }
  const riskHits = declared && "paths" in declared
    ? declaredHits(declared.paths, paths)
    : [];

  const requiresQa = [
    ...new Set([...codeChanges, ...riskHits.map((h) => h.path)]),
  ];
  if (requiresQa.length > 0 && qaChanges.length === 0) {
    findings.push({
      message:
        `changes requiring a QA round (${requiresQa.length} files, e.g. ${
          requiresQa.slice(0, 3).join(", ")
        }) must be accompanied by a QA round: append a Round that declares a Choice or a Waive (applied: <Choice ID> / no-choice: <reason>) to the task's qa.md or _docs/qa/<Area>/maintenance.md`,
    });
  }

  if (riskHits.length > 0 && qaChanges.length > 0) {
    const high = (risk: string | null) =>
      risk === "High" || risk === "Critical";
    let highFound = false;
    for (const qaPath of qaChanges) {
      if (
        high(await frontMatterRisk(qaPath)) ||
        (await addedRoundRisks(qaPath)).some(high)
      ) {
        highFound = true;
        break;
      }
    }
    if (!highFound) {
      const shown = riskHits.slice(0, 3).map((h) => `${h.kind}: ${h.path}`)
        .join(", ");
      findings.push({
        message:
          `declared dangerous paths changed (${shown}): the accompanying QA document must declare risk: High or Critical, or the round this change adds must carry "- **Risk**: High" (repo-declared risk floor)`,
      });
    }
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`ERROR: (diff)\n  - ${finding.message}`);
    }
    Deno.exit(1);
  }
};

if (import.meta.main) {
  await run();
}
