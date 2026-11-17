import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { load as yamlLoad } from "js-yaml";

/** a public-side check copied from what the repo itself declares, with where it was found */
export interface DetectedCheck {
  name: string;
  command: string;
  from: string;
}

export interface DetectedChecks {
  checks: DetectedCheck[];
  /** the install lines the declaration runs before its checks; reported, and written to the check copy's setup in repos.yaml */
  setupHints: string[];
}

/** the commands that run the repo's own tests or static checks (installs and builds are not checks) */
const CHECK_BODY = String.raw`(?:npm|pnpm|yarn|bun)(?: run)? (?:test|lint|typecheck|check)|(?:python3? -m )?(?:pytest|unittest|mypy|ruff|flake8)|tsc|eslint|vitest|jest|cargo (?:test|check|clippy)|go (?:test|vet)|make (?:test|check|lint)|moon (?:check|test)|deno (?:test|lint|check)|bundle exec rspec|rspec|rake test|dotnet test|flutter (?:test|analyze)|dart (?:test|analyze)|node (?:--[\w=-]+ )*--test|(?:\.\/)?gradlew (?:test|check)|gradle (?:test|check)|(?:\.\/)?mvnw? (?:test|verify)|swift test|mix test`;
/** what may stand before the command without changing which command it is: env assignments and runners */
const CHECK_PREFIX = String.raw`(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:(?:npx(?: -{1,2}[\w-]+)*|pnpm (?:exec|dlx)|bunx|yarn exec|uv run|poetry run|pipenv run|(?:python3? -m )?coverage run -m|time|exec|sudo|env) )*`;
/** a piece of a CI line that starts a check; a mention of one as an argument (`echo npm test`) does not */
const CHECK_START = new RegExp(`^[({!\\s]*${CHECK_PREFIX}(?:${CHECK_BODY})(?![\\w-])`);
/** whether a CI line runs a check as one of its commands (cut at `&&` and `;`, outside quotes) */
const runsCheck = (piece: string) => splitShell(piece).some((p) => CHECK_START.test(p));
/** a repo's own script that runs its tests or checks, by where it lives and what it is called */
const SCRIPT_LINE = /^(?:(?:bash|sh) )?(?:\.\/)?((?:scripts?|bin)\/[\w./-]*(?:test|check|lint)[\w.-]*)(?:\s|$)/;
const INSTALL_LINE = /^(?:(?:npm|pnpm|bun) (?:ci|install|i)\b|yarn(?:\s+install\b|(?:\s+--?[\w-]+(?:=\S+)?)*\s*$)|(?:python3? -m )?pip3? install\b|poetry install\b|uv sync\b|bundle install\b|go mod download\b|cargo fetch\b|(?:flutter|dart) pub get\b)/;
/** what a local run cannot reproduce: a CI expression, or a runner variable */
const CI_ONLY = /\$\{\{|\$\{?(?:GITHUB|RUNNER)_/;

function nameOf(command: string): string {
  if (/lint|eslint|ruff|flake8|clippy|\bvet\b|analyze/.test(command)) return "lint";
  if (/tsc|typecheck|mypy|\bcheck\b/.test(command)) return "check";
  return "test";
}

export function dedupeChecks(checks: DetectedCheck[]): DetectedCheck[] {
  const seen = new Set<string>();
  const used = new Map<string, number>();
  const out: DetectedCheck[] = [];
  for (const c of checks) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    const n = (used.get(c.name) ?? 0) + 1;
    used.set(c.name, n);
    out.push({ ...c, name: n === 1 ? c.name : `${c.name}-${n}` });
  }
  return out;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** the working-directory a step runs in: its own, then the job's default, then the workflow's */
function stepDir(step: Record<string, unknown>, job: Record<string, unknown>, flow: Record<string, unknown>): string | null {
  for (const holder of [step, asRecord(asRecord(job.defaults).run), asRecord(asRecord(flow.defaults).run)]) {
    const d = holder["working-directory"];
    if (typeof d === "string" && d.trim() && !CI_ONLY.test(d) && d.trim() !== ".") return d.trim();
  }
  return null;
}

/** a shell word that stays one word whatever the directory is called */
const shellWord = (v: string) => /^[\w./@%+=:,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;

/** the triggers of a normal submission; a schedule, a manual dispatch or a release is not one */
const SUBMISSION_TRIGGERS = ["push", "pull_request", "pull_request_target", "merge_group"];

/** whether a workflow declares that it runs when work is submitted (`on` as a string, a list or a map) */
function runsOnSubmission(flow: Record<string, unknown>): boolean {
  const on = flow.on;
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.filter((v): v is string => typeof v === "string") : Object.keys(asRecord(on));
  return names.some((n) => SUBMISSION_TRIGGERS.includes(n));
}

/** a line cut at `&&` and `;`, leaving quotes, parentheses, `||` and `|` whole */
function splitShell(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && quote !== "'" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    if (depth === 0) {
      if (c === "|" && line[i + 1] === "|") { cur += "||"; i++; continue; }
      if (c === "&" && line[i + 1] === "&") { parts.push(cur); cur = ""; i++; continue; }
      if (c === ";") { parts.push(cur); cur = ""; continue; }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** the directory a simple `cd DIR` moves to, or null for any other piece */
function cdTarget(piece: string): string | null {
  const m = /^cd\s+(?!-$)([\w./@%+=:,-]+)$|^cd\s+(['"])([^'"$`\\]+)\2$/.exec(piece);
  return m ? (m[1] ?? m[3]) : null;
}

/** the check lines of the GitHub Actions workflows under .github/workflows */
function fromWorkflows(repo: string): DetectedChecks {
  const dir = join(repo, ".github", "workflows");
  const found: DetectedCheck[] = [];
  const hints: string[] = [];
  if (!existsSync(dir)) return { checks: [], setupHints: [] };
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    let flow: Record<string, unknown>;
    try { flow = asRecord(yamlLoad(readFileSync(join(dir, file), "utf8"))); } catch { continue; }
    // a workflow that does not declare a normal submission (or whose trigger cannot be read) is no source of a required check
    if (!runsOnSubmission(flow)) continue;
    const from = `.github/workflows/${file}`;
    for (const job of Object.values(asRecord(flow.jobs))) {
      const j = asRecord(job);
      if (!Array.isArray(j.steps)) continue;
      for (const raw of j.steps) {
        const step = asRecord(raw);
        if (typeof step.run !== "string") continue;
        const at = stepDir(step, j, flow);
        // a `cd DIR` on a line of its own moves every later line of this step (it is not carried to the next step)
        let moved = "";
        let movedTo = at ?? "";
        let lost = false;
        for (const rawLine of step.run.split("\n")) {
          if (lost) break;
          const line = rawLine.trim();
          // a continued line or a heredoc cannot be lifted out of its script
          if (!line || line.startsWith("#") || line.endsWith("\\") || line.includes("<<") || CI_ONLY.test(line)) continue;
          const simpleCd = /^cd\s+(?!-$)[\w./@%+=:,-]+$|^cd\s+(['"])[^'"$`\\]+\1$/.test(line);
          if (simpleCd) {
            moved = moved ? `${moved} && ${line}` : line;
            movedTo = join(movedTo, line.replace(/^cd\s+/, "").replace(/^(['"])(.*)\1$/, "$2"));
            continue;
          }
          // any other move (`cd a && npm ci`, `cd $X`) leaves the lines after it somewhere unknown: this line is read, the rest of the step is not
          if (/^cd(\s|$)/.test(line)) lost = true;
          const parts = splitShell(line);
          // an install chained to a check (`npm ci && npm test`) is told apart from it; a line without one stays whole
          const hasInstall = parts.some((p) => INSTALL_LINE.test(p));
          const pieces = hasInstall ? parts : [line];
          let prefix = [at ? `cd ${shellWord(at)}` : "", moved].filter(Boolean).join(" && ");
          // a `cd DIR` inside the line moves the script that follows it, whether the line is cut into pieces or kept whole
          let within = movedTo;
          let unknown = false;
          const whole = !hasInstall;
          for (const piece of whole ? parts : pieces) {
            const to = cdTarget(piece);
            if (to !== null || /^cd(\s|$)/.test(piece)) {
              // a move that cannot be read leaves the scripts after it somewhere unknown
              if (to !== null) within = join(within, to); else unknown = true;
              if (!whole) prefix = prefix ? `${prefix} && ${piece}` : piece;
              continue;
            }
            if (whole) {
              // a script only counts when the repo holds it: a generated or fetched one cannot be run from a clone
              const script = SCRIPT_LINE.exec(piece)?.[1];
              if (script && !unknown && existsSync(join(repo, within, script))) { found.push({ name: nameOf(piece), command: prefix ? `${prefix} && ${line}` : line, from }); break; }
              if (runsCheck(piece)) { found.push({ name: nameOf(piece), command: prefix ? `${prefix} && ${line}` : line, from }); break; }
              continue;
            }
            const command = prefix ? `${prefix} && ${piece}` : piece;
            if (INSTALL_LINE.test(piece)) { if (!hints.includes(command)) hints.push(command); continue; }
            const script = SCRIPT_LINE.exec(piece)?.[1];
            if (script && !unknown && existsSync(join(repo, within, script))) { found.push({ name: nameOf(piece), command, from }); continue; }
            if (runsCheck(piece)) found.push({ name: nameOf(piece), command, from });
          }
        }
      }
    }
  }
  return { checks: dedupeChecks(found), setupHints: hints };
}

function runnerOf(repo: string): { run: string; install: string } {
  if (existsSync(join(repo, "bun.lock")) || existsSync(join(repo, "bun.lockb"))) return { run: "bun run", install: "bun install --frozen-lockfile" };
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return { run: "pnpm run", install: "pnpm install --frozen-lockfile" };
  if (existsSync(join(repo, "yarn.lock"))) return { run: "yarn run", install: "yarn install --frozen-lockfile" };
  // without a lockfile a plain `npm install` writes one into the check copy, which reads as the setup changing the submission
  return { run: "npm run", install: existsSync(join(repo, "package-lock.json")) ? "npm ci" : "npm install --no-package-lock" };
}

/** the entrances an ecosystem gives a repo: package.json scripts, Makefile targets, and the toolchain's own commands */
function fromEcosystem(repo: string): DetectedChecks {
  const found: DetectedCheck[] = [];
  const hints: string[] = [];
  const has = (p: string) => existsSync(join(repo, p));
  if (has("package.json")) {
    try {
      const scripts = asRecord(asRecord(JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))).scripts);
      const runner = runnerOf(repo);
      for (const key of ["test", "lint", "typecheck", "check"]) {
        const body = scripts[key];
        // npm init writes a placeholder test script that only fails
        if (typeof body !== "string" || /no test specified/.test(body)) continue;
        found.push({ name: key === "typecheck" ? "check" : key, command: key === "test" && runner.run === "npm run" ? "npm test" : `${runner.run} ${key}`, from: `package.json の scripts.${key}` });
      }
      if (found.length) hints.push(runner.install);
    } catch { /* an unreadable package.json declares nothing */ }
  }
  if (has("Makefile")) {
    const make = readFileSync(join(repo, "Makefile"), "utf8");
    for (const target of ["test", "check", "lint"]) {
      if (new RegExp(`^${target}\\s*:`, "m").test(make)) found.push({ name: target === "check" ? "check" : target, command: `make ${target}`, from: `Makefile の ${target}` });
    }
  }
  if (has("Cargo.toml")) found.push({ name: "test", command: "cargo test", from: "Cargo.toml" });
  if (has("go.mod")) found.push({ name: "test", command: "go test ./...", from: "go.mod" });
  if (has("moon.mod.json")) found.push({ name: "test", command: "moon test", from: "moon.mod.json" });
  if (has("pytest.ini") || (has("pyproject.toml") && /\[tool\.pytest/.test(readFileSync(join(repo, "pyproject.toml"), "utf8")))) {
    found.push({ name: "test", command: "python3 -m pytest", from: has("pytest.ini") ? "pytest.ini" : "pyproject.toml の [tool.pytest]" });
  }
  if (has("deno.json") || has("deno.jsonc")) {
    try {
      const file = has("deno.json") ? "deno.json" : "deno.jsonc";
      if ("test" in asRecord(asRecord(JSON.parse(readFileSync(join(repo, file), "utf8"))).tasks)) found.push({ name: "test", command: "deno task test", from: `${file} の tasks.test` });
    } catch { /* deno.jsonc may carry comments; then it declares nothing we can read */ }
  }
  return { checks: dedupeChecks(found), setupHints: hints };
}

/**
 * The public-side checks a repo already declares: its CI first, then the entrances of its ecosystem. Nothing is
 * made up: a repo that declares neither yields no check, and the caller stops.
 */
export function detectPublicChecks(repo: string): DetectedChecks {
  const ci = fromWorkflows(repo);
  if (ci.checks.length) return ci;
  return fromEcosystem(repo);
}

/**
 * The installs a repo's CI runs before its checks, read whether or not the checks are the CI's own. A check the user
 * names with --check still needs what the CI sets up first; the ecosystem entrances are not read, since their installs
 * belong to the checks they declare.
 */
export function detectCiSetupHints(repo: string): string[] {
  return fromWorkflows(repo).setupHints;
}

/** the name a check given on the command line gets */
export function nameForCommand(command: string): string {
  return nameOf(command);
}

/** build products an ecosystem leaves in a clone, by the files that show the ecosystem */
export function generatedPatterns(tracked: string[]): string[] {
  const has = (re: RegExp) => tracked.some((f) => re.test(f));
  const out: string[] = [];
  if (has(/(^|\/)(pyproject\.toml|setup\.py|requirements[\w.-]*\.txt)$/) || has(/\.py$/)) out.push("__pycache__/", "*.pyc");
  // no trailing slash: a lane's worktree may link node_modules in as a symlink, which a directory-only pattern misses
  if (has(/(^|\/)package\.json$/)) out.push("node_modules");
  if (has(/(^|\/)Cargo\.toml$/)) out.push("target/");
  if (has(/(^|\/)moon\.mod(\.json)?$/)) out.push("_build/", ".mooncakes/");
  return out;
}

/** the labels of a GitHub repo, or null when gh cannot say (not installed, not signed in, no such repo) */
export function ghLabels(github: string): string[] | null {
  try {
    const out = execFileSync("gh", ["label", "list", "--repo", github, "--limit", "1000", "--json", "name"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    const parsed = JSON.parse(out) as { name?: unknown }[];
    return parsed.map((l) => String(l.name));
  } catch {
    return null;
  }
}
