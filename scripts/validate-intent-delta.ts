// Deno版 intent-delta presence validator: 「code diff があるのに QA round (Intent Delta)
// が伴わない」を機械検査する。常時 ON ループの Tier 1 の背骨。
// 併せて workflow-sensitive path への変更に Risk High 下限を適用する。
// 比較基準: DD_DELTA_BASE (git ref)。未設定なら HEAD (working tree + staged + untracked)。

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

const SENSITIVE_PREFIXES = [
  "scripts/",
  ".github/",
  "_docs/standards/",
  ".claude/",
  ".codex/",
  ".agents/",
] as const;
const SENSITIVE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const QA_FILE_RE = /^_docs\/qa\/.+\.md$/;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const isCode = (path: string): boolean =>
  CODE_EXTENSIONS.some((ext) => path.endsWith(ext));

export const isSensitive = (path: string): boolean =>
  (SENSITIVE_FILES as readonly string[]).includes(path) ||
  SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix));

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

const changedPaths = async (): Promise<string[] | null> => {
  let base: string | undefined;
  try {
    base = Deno.env.get("DD_DELTA_BASE")?.trim() || undefined;
  } catch {
    base = undefined;
  }
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
  const sensitiveChanges = paths.filter(isSensitive);
  const findings: Finding[] = [];

  const requiresQa = [...new Set([...codeChanges, ...sensitiveChanges])];
  if (requiresQa.length > 0 && qaChanges.length === 0) {
    findings.push({
      message:
        `changes requiring an Intent Delta (${requiresQa.length} files, e.g. ${
          requiresQa.slice(0, 3).join(", ")
        }) must be accompanied by a QA round: append a Round with an Intent Delta (DEC-xxx / applied: DEC-xxx / None: <reason>) to the task's qa.md or _docs/qa/<Area>/maintenance.md`,
    });
  }

  if (sensitiveChanges.length > 0 && qaChanges.length > 0) {
    let highFound = false;
    for (const qaPath of qaChanges) {
      const risk = await frontMatterRisk(qaPath);
      if (risk === "High" || risk === "Critical") {
        highFound = true;
        break;
      }
    }
    if (!highFound) {
      findings.push({
        message: `workflow-sensitive paths changed (e.g. ${
          sensitiveChanges.slice(0, 3).join(", ")
        }): the accompanying QA document must declare risk: High or Critical (path-based risk floor)`,
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
