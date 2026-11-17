import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { areasPath, parseRepos } from "../config/areas.ts";
import { checkoutRoot } from "../config/files.ts";
import { describeReferences, overlayReferences, readManifest } from "../overlay/manifest.ts";
import { readCheckList, renderCheckList, type CheckList } from "./checks-list.ts";
import { dedupeChecks, detectCiSetupHints, detectPublicChecks, generatedPatterns, ghLabels, nameForCommand, type DetectedCheck } from "./prerequisites.ts";

/** pi-web-idd itself: the template was folded into this monorepo, so the skeleton comes from here */
export function templateRoot(): string {
  return checkoutRoot();
}

const home = (p: string) => resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** the real place a path names, also when it is not made yet: the nearest parent that exists is resolved (symlinks included, a dangling one by where it points) and the rest is added back */
function realPlace(p: string): string {
  const rest: string[] = [];
  let at = resolve(p);
  for (let hops = 0; hops < 40; hops++) {
    try { return join(realpathSync(at), ...[...rest].reverse()); } catch { /* not there (yet), or a link that dangles */ }
    try {
      if (lstatSync(at).isSymbolicLink()) { at = resolve(dirname(at), readlinkSync(at)); continue; }
    } catch { /* no link here either */ }
    const up = dirname(at);
    if (up === at) break;
    rest.push(basename(at));
    at = up;
  }
  return resolve(p);
}
/** whether the filesystem at the nearest existing parent of a path ignores letter case (macOS by default): the parent's name in the other case still names the same directory */
export function ignoresCase(p: string): boolean {
  let at = realPlace(p);
  for (;;) {
    try {
      const here = lstatSync(at);
      const name = basename(at);
      const swapped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
      if (swapped !== name) {
        const other = lstatSync(join(dirname(at), swapped));
        return other.ino === here.ino && other.dev === here.dev;
      }
    } catch { /* not there, or no other spelling of it: ask one level up (a path that is not made yet has no inode of its own) */ }
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/** the place a path really is, folded to lower case when its filesystem ignores letter case, so two spellings of one place compare equal; `fold` says whether to fold (`ignoresCase` decides) */
export function foldedPlace(p: string, fold: boolean): string {
  const place = realPlace(p);
  return fold ? place.toLowerCase() : place;
}

const isThere = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
}
function gitTry(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

export interface InitOptions {
  /** owner/name on GitHub */
  github: string;
  upstream: string;
  work: string;
  /** the upstream path is an existing clone to adopt as the upstream */
  existing?: boolean;
  /** clone source for a fresh upstream (defaults to the GitHub URL; tests pass a local path) */
  url?: string;
  publicBase?: string;
  workBase?: string;
  name?: string;
  /** take GitHub Issues into the Issue lane by these labels; left out it is `idd-ready`, and null opts out */
  issueLane?: { labels: string[] } | null;
  /** public-side check commands the user names (replaces looking for what the repo declares) */
  checks?: string[];
  /** a list of checks and setup the user went over (written by `checksOut`, edited, handed back): the registration declares exactly it */
  checksFile?: string;
  /** write the checks and setup the registration would declare to this file for the user to go over; only with `dryRun`, and the one file a dry run writes */
  checksOut?: string;
  /** the author of the commits published from the upstream clone, for the keys git does not resolve there */
  author?: { name?: string; email?: string };
  /** what the repo is, in the user's words: the statement of P-1 (written by the caller through the engine's door) */
  overview?: string;
  /** the labels of the GitHub repo, or null when they cannot be read (defaults to `gh`; tests pass a stub) */
  listLabels?: (github: string) => string[] | null;
  /** what to do with records an existing project already has */
  records?: "keep" | "drop";
  source?: string;
  reposFile?: string;
  dryRun?: boolean;
  /** skip the immediate record check (tests); the registry still names the package's check */
  skipCheck?: boolean;
}

export interface Inventory {
  /** records the project already has (IDD template, docs_driven_dev_template, or an equivalent _docs/) */
  template: "idd" | "docs_driven_dev_template" | "records" | null;
  lockTag?: string;
  docs: number;
  decs: number;
  /** code lines that mention DEC-nnn / INV-nnn (intent pointers the overlay mode forbids) */
  pointerComments: number;
  /** the files those lines are in, with their counts */
  pointerFiles: { path: string; count: number }[];
  /** skeleton paths the upstream already has (left as they are) */
  conflicts: string[];
}

/** what a lane needs from a registered repo, and whether the registration found it */
export interface Prerequisites {
  intake: { declared: boolean; labels: string[]; missingLabels: string[]; labelCheck: "checked" | "unchecked" | "none" };
  publicChecks: {
    /** found: copied from the repo's CI or entrances; given: named by --check; confirmed: the list the user went over; none / deferred: nothing to declare */
    state: "found" | "given" | "confirmed" | "none" | "deferred";
    checks: DetectedCheck[];
    setupHints: string[];
    /** what the registration declares without the user having gone over it, and where to correct it; absent when the user confirmed it all */
    unconfirmed?: { checks: string[]; setup: string[]; fix: string };
  };
  author: { state: "found" | "given" | "missing" | "deferred"; name?: string; email?: string; missing: string[]; from: Record<string, "git" | "flag"> };
  /** present: null until the upstream clone can be read */
  gitignore: { present: boolean | null; excluded: string[] };
  overview: { state: "none" | "pending" | "raised" | "kept" | "unreachable"; statement?: string; note?: string };
}

export interface InitResult {
  /** the registration succeeded, or (with dryRun) nothing would stop it */
  ok: boolean;
  /** set on a --dry-run: nothing was changed */
  dryRun?: true;
  steps: string[];
  inventory: Inventory;
  prerequisites: Prerequisites;
  warnings: string[];
  blockers: string[];
  commit?: string;
}

const DEFAULT_LABELS = ["idd-ready"];

/**
 * The paths an earlier template copied into a project (its norms, its validators, the agent-workflow cases and the
 * Deno config). `idd repo init` copies none of them: the package keeps them, and a repo that already holds one is
 * reported as a conflict (`takeInventory`). The agent-workflow cases are the package's own verification material and
 * stay out of the kit (`document_contracts.md` の「配る範囲の定義」).
 */
const SKELETON_COPY = ["_docs/standards", "_meta/agent-workflows", "scripts", "deno.json"];
const AGENT_DIRS = [".agents", ".claude", ".codex"];
const RECORD_DIRS = ["_docs/archives", "_docs/guide", "_docs/intent", "_docs/plan", "_docs/qa", "_docs/reference"];
const TEMPLATE_SCRIPTS = /^(agent-workflow-hook|check-docs|generate-doc-probe|scope|test-agent-workflow-hook|validate-[a-z-]+)(\.test)?\.(ts|sh)$/;
/** scripts an earlier template release put into a project (any version, any extension) */
const TEMPLATE_ASSET_SCRIPTS = /^scripts\/(agent-workflow-hook|check-docs|create-template-archive|generate-doc-probe|scope|test-agent-workflow-(hook|smoke)|test-validators|validate-[a-z-]+)(\.test)?\.(ts|mjs|js|sh)$/;

const HOOK_CONFIGS = [".claude/settings.json", ".codex/hooks.json"];

/**
 * The names the package shipped under `_docs/standards/` before the v2 standards (2026-10-22), relative to that
 * directory. An adopted repo that copied the norms holds these; `repo migrate` takes exactly these out, and a repo
 * that still holds one keeps its own norms. The v2 standards added generic names (records, work, checks, ...) that a
 * repo may well hold as documents of its own, so the package's current file list must never decide what is removed.
 */
const PRE_V2_STANDARDS: readonly string[] = Object.freeze([
  "workflow.md",
  "document_contracts.md",
  "template_operations.md",
  "brief.md",
  "granularity.md",
  "templates/context.md",
  "templates/guide.md",
  "templates/intent.md",
  "templates/plan.md",
  "templates/qa.md",
  "templates/reference.md",
  "templates/survey.md",
]);

// exported for `repo migrate`, which takes an earlier template's copies out of an adopted repo
export { SKELETON_COPY, AGENT_DIRS, HOOK_CONFIGS, TEMPLATE_SCRIPTS, TEMPLATE_ASSET_SCRIPTS, PRE_V2_STANDARDS };
export { templateHookConfig };

/** a hook config that holds nothing but hooks, each running the template's workflow hook */
function templateHookConfig(path: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!data || typeof data !== "object" || Object.keys(data).some((k) => k !== "hooks")) return false;
  const commands: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "command" && typeof x === "string") commands.push(x);
        else walk(x);
      }
    }
  };
  walk(data);
  return commands.length > 0 && commands.every((c) => c.includes("scripts/agent-workflow-hook."));
}

function countFiles(dir: string, pred: (p: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += countFiles(p, pred);
    else if (pred(p)) n += 1;
  }
  return n;
}

export function takeInventory(repo: string): Inventory {
  const lock = join(repo, "docs-template.lock.json");
  const hasDocs = existsSync(join(repo, "_docs"));
  const readme = existsSync(join(repo, "README.md")) ? readFileSync(join(repo, "README.md"), "utf8") : "";
  const template: Inventory["template"] = existsSync(lock) ? "idd"
    : /docs_driven_dev_template|docs-driven/i.test(readme) ? "docs_driven_dev_template"
      : hasDocs ? "records" : null;
  let lockTag: string | undefined;
  try { lockTag = (JSON.parse(readFileSync(lock, "utf8")) as { revision?: { tag?: string } }).revision?.tag; } catch { /* no lock */ }
  const docs = countFiles(join(repo, "_docs"), (p) => p.endsWith(".md"));
  const decs = hasDocs ? Number((gitTry(repo, ["grep", "-c", "-E", "^### DEC-[0-9]{3,}", "--", "_docs"]) ?? "").split("\n").filter(Boolean).reduce((a, l) => a + Number(l.split(":").pop() ?? 0), 0)) : 0;
  const pointer = gitTry(repo, ["grep", "-I", "-c", "-E", "\\b(DEC|INV)-[0-9]{3,}\\b", "--", ".", ":(exclude)_docs", ":(exclude)_meta", ":(exclude)*.md", ":(exclude)TODO.md"]) ?? "";
  const pointerFiles = pointer.split("\n").filter(Boolean).map((l) => {
    const at = l.lastIndexOf(":");
    return { path: l.slice(0, at), count: Number(l.slice(at + 1)) };
  })
    // the template's validators name DEC / INV in patterns and fixtures; that is not the project's code
    .filter((f) => !TEMPLATE_ASSET_SCRIPTS.test(f.path));
  const pointerComments = pointerFiles.reduce((a, f) => a + f.count, 0);
  const conflicts = [...SKELETON_COPY, ...AGENT_DIRS, "AGENTS.override.md", "CLAUDE.local.md", "overlay.manifest", "TODO.md", "docs-template.lock.json"]
    .filter((p) => existsSync(join(repo, p)));
  return { template, ...(lockTag ? { lockTag } : {}), docs, decs, pointerComments, pointerFiles, conflicts };
}

/** the TODO's rule sections (0-8) from the template, with no tasks and the ID counter reset */
export function emptyTodo(source: string): string {
  const src = readFileSync(join(source, "starter", "TODO.md"), "utf8");
  const cut = src.indexOf("\n## Inbox");
  const rules = (cut >= 0 ? src.slice(0, cut) : src).replace(/`Next ID No: \d+`/, "`Next ID No: 1`");
  return `${rules.trimEnd()}\n\n## Inbox\n\n## Backlog\n\n## Ready\n\n## In Progress\n`;
}

export interface BacklogTask {
  area: string;
  category: string;
  title: string;
  goal: string;
  criteria: string[];
  steps: string[];
  context: string;
  notes: string;
  /** a qa.md or the area's maintenance.md: the schema has no task without a place for its QA rounds */
  qa: string;
  /** a lane's number: the task is numbered `<Area>-<Kind>-<lane>-<serial>` and `Next ID No` is left alone */
  lane?: string;
}

/** an area's maintenance QA file with no rounds yet */
export function emptyMaintenance(area: string, date: string): string {
  return [
    "---",
    `title: "QA rounds: ${area} maintenance"`,
    "status: active",
    "qa_status: in-progress",
    "risk: Low",
    "qa_schema: 5",
    `created_at: ${date}`,
    `updated_at: ${date}`,
    "references: []",
    "related_issues: []",
    "related_prs: []",
    "---",
    "",
    `# QA rounds: ${area} maintenance`,
    "",
    "## Rounds",
    "",
  ].join("\n");
}

/**
 * Append a task to the end of the TODO's Backlog in the template schema. Without `t.lane` it is numbered from the
 * `Next ID No` counter, which is then incremented; with one, it takes `<Area>-<Kind>-<lane>-<serial>` where the
 * serial counts the tasks this lane already has in the TODO, and the counter is left untouched. Null when the TODO
 * has no Backlog, or no counter and no lane to number the task from.
 */
export function appendBacklogTask(todo: string, t: BacklogTask): { todo: string; id: string } | null {
  const counter = /`Next ID No: (\d+)`/.exec(todo);
  const backlog = todo.indexOf("\n## Backlog");
  if (backlog < 0) return null;
  let id: string;
  let counterLine: string | null = null;
  if (t.lane) {
    let serial = 0;
    for (const m of todo.matchAll(new RegExp(`^###\\s+[A-Za-z][A-Za-z0-9_-]*-[A-Za-z]+-${t.lane}-([1-9]\\d*):`, "gm"))) serial = Math.max(serial, Number(m[1]));
    id = `${t.area}-${t.category}-${t.lane}-${serial + 1}`;
  } else {
    if (!counter) return null;
    const n = Number(counter[1]);
    id = `${t.area}-${t.category}-${n}`;
    counterLine = `\`Next ID No: ${n + 1}\``;
  }
  const title = `[${t.category}] ${t.title}`;
  const block = [
    `### ${id}: ${title}`,
    "",
    `- **Title**: ${title}`,
    `- **ID**: ${id}`,
    "- **Priority**: P2",
    "- **Size**: S",
    "- **Risk**: Low",
    `- **Area**: ${t.area}`,
    "- **Dependencies**: []",
    `- **Goal**: ${t.goal}`,
    "- **Acceptance Criteria**:",
    ...t.criteria.map((c, i) => `  - AC-${String(i + 1).padStart(3, "0")}: ${c}`),
    "- **Steps**:",
    ...t.steps.map((s, i) => `  ${i + 1}. [ ] ${s}`),
    "- **Description**:",
    `  - Context: ${t.context}`,
    `  - Notes: ${t.notes}`,
    "- **Plan**: None",
    "- **Intent**: None",
    `- **QA**: ${t.qa}`,
    "",
  ].join("\n");
  // the end of the Backlog is the next section heading, or the rule just above it
  const next = todo.indexOf("\n## ", backlog + 1);
  let end = next < 0 ? todo.length : next + 1;
  const rule = todo.lastIndexOf("\n---\n", end);
  if (rule > backlog && !todo.slice(rule + 5, end).trim()) end = rule + 1;
  const head = todo.slice(0, end).replace(/\n*$/, "\n\n");
  const body = `${head}${block}\n${todo.slice(end)}`;
  const out = counterLine === null ? body : body.replace(counter![0], counterLine);
  return { todo: out, id };
}

/** upper half: the upstream's AGENTS.md as is; lower half: the template's norms */
export function composeOverride(upstreamAgents: string | null, norms: string): string {
  return [
    "# AGENTS.override.md",
    "",
    "IDD の作業規範。**この file が workspace 規範の正本**で、overlay 側にあり出力面には出ない。",
    "コード空間の規約は上段の embed（`AGENTS.md` の写し）に従い、記録空間は下段に従う。",
    "",
    "---",
    "",
    "## 上段: 出力面 AGENTS.md の embed（手編集禁止・`AGENTS.md` の写し）",
    "",
    "<!-- embed:begin AGENTS.md -->",
    upstreamAgents?.trim() ? upstreamAgents.trim() : "（upstream に AGENTS.md はありません）",
    "<!-- embed:end AGENTS.md -->",
    "",
    "## 下段: IDD の規範",
    "",
    norms.trim(),
    "",
  ].join("\n");
}

/** a YAML scalar that survives any command or label text */
const yamlText = (v: string) => JSON.stringify(v);

/** the branch the public side's PRs go to: the flag, else the clone's default (a dry run with no clone yet uses `main` as a placeholder) */
function publicBaseOf(upstream: string, opts: InitOptions): string {
  if (opts.publicBase) return opts.publicBase;
  if (!existsSync(join(upstream, ".git"))) return "main";
  return (gitTry(upstream, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) ?? "").trim().replace(/^origin\//, "") || (gitTry(upstream, ["branch", "--show-current"]) ?? "main").trim();
}

function repoEntry(opts: InitOptions, publicBase: string, workBase: string, checkCommand: string, lane: { labels: string[] } | null, publicChecks: DetectedCheck[], setup: string[]): string {
  const name = opts.name ?? opts.github.split("/")[1];
  const lines = [
    "",
    `  ${opts.github}:`,
    `    name: ${name}`,
    `    upstream: ${opts.upstream}`,
    `    work: ${opts.work}`,
    `    public_base: ${publicBase}`,
    `    work_base: ${workBase}`,
    "    remote: origin",
    "    copy: []",
    ...(setup.length ? ["    setup:", ...setup.map((c) => `      - ${yamlText(c)}`)] : ["    setup: []"]),
    "    checks:",
    // the repo's own checks guard its public side; the record check guards the records
    ...publicChecks.map((c) => `      - { name: ${yamlText(c.name)}, command: ${yamlText(c.command)}, required: true, scope: public, timeout_minutes: 10 }`),
    `      - { name: docs, command: '${checkCommand}', required: false, scope: records, timeout_minutes: 10 }`,
  ];
  if (lane) {
    lines.push("    issue_lane:", "      context: personal", "      source_type_priority: github", `      intake_filter: { github_labels: [${lane.labels.map(yamlText).join(", ")}] }`);
  }
  return `${lines.join("\n")}\n`;
}

/** the author git resolves in a directory (local, then global, then system); a flag wins for its key */
function probeAuthor(cwd: string, given: InitOptions["author"]): Prerequisites["author"] {
  const from: Record<string, "git" | "flag"> = {};
  const got: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, flag] of [["user.name", given?.name?.trim()], ["user.email", given?.email?.trim()]] as const) {
    const value = flag || (gitTry(cwd, ["config", "--get", key]) ?? "").trim();
    if (!value) { missing.push(key); continue; }
    got[key] = value;
    from[key] = flag ? "flag" : "git";
  }
  const state = missing.length ? "missing" : Object.values(from).includes("flag") ? "given" : "found";
  return { state, ...(got["user.name"] ? { name: got["user.name"] } : {}), ...(got["user.email"] ? { email: got["user.email"] } : {}), missing, from };
}

const checksBlocker = "公開側の検査を見つけられませんでした。repo の CI（.github/workflows）の run: 行と、package.json・Makefile・Cargo.toml などの入口を読みましたが、test / lint の command として読めるものがありませんでした。propter は command を作らないので止めました。CI がここで読めない形で検査を回しているなら、その command を --check 'COMMAND' で渡すか、--dry-run --checks-out FILE で書き出した一覧に検査の行を足して --checks-file FILE で渡してください";

const authorBlocker = (missing: string[]) =>
  `公開側の clone で git の ${missing.join(" と ")} が決まりません。公開する commit の作者に使うので、--git-user-name / --git-user-email で渡すか、git config --global で設定してください`;

interface Probe {
  publicChecks: Prerequisites["publicChecks"];
  author: Prerequisites["author"];
  gitignore: Prerequisites["gitignore"];
  blockers: string[];
}

/** the list the user went over, as the public checks the registration declares */
const confirmedChecks = (list: CheckList): Prerequisites["publicChecks"] => ({ state: "confirmed", checks: list.checks, setupHints: list.setup });

const givenChecks = (opts: InitOptions): DetectedCheck[] =>
  dedupeChecks((opts.checks ?? []).map((c) => c.trim()).filter(Boolean).map((command) => ({ name: nameForCommand(command), command, from: "--check" })));

/** what the upstream clone shows: the checks it declares, the author git resolves in it and its .gitignore. Writes nothing. */
function probeUpstream(upstream: string, opts: InitOptions, confirmed: CheckList | null): Probe {
  const blockers: string[] = [];
  const tracked = (gitTry(upstream, ["ls-files"]) ?? "").split("\n").filter(Boolean);
  const given = givenChecks(opts);
  let publicChecks: Prerequisites["publicChecks"];
  // the list the user went over replaces what the repo declares: it is where the user's corrections are
  if (confirmed) publicChecks = confirmedChecks(confirmed);
  else if (given.length) publicChecks = { state: "given", checks: given, setupHints: detectCiSetupHints(upstream) };
  else {
    const found = detectPublicChecks(upstream);
    publicChecks = { state: found.checks.length ? "found" : "none", checks: found.checks, setupHints: found.setupHints };
    if (!found.checks.length) blockers.push(checksBlocker);
  }
  const author = probeAuthor(upstream, opts.author);
  if (author.missing.length) blockers.push(authorBlocker(author.missing));
  return { publicChecks, author, gitignore: { present: tracked.includes(".gitignore"), excluded: generatedPatterns(tracked) }, blockers };
}

/**
 * A dry run that has no upstream clone yet reads a throwaway clone of the same source the run would clone, so it
 * stops for the checks and the author as the run does. The clone is removed whatever happens; nothing persists.
 */
function probeFresh(opts: InitOptions, confirmed: CheckList | null): Probe {
  const tmp = mkdtempSync(join(tmpdir(), "idd-init-probe-"));
  try {
    const at = join(tmp, "clone");
    try {
      git(tmp, ["clone", "-q", "--depth", "1", opts.url ?? `https://github.com/${opts.github}.git`, at]);
    } catch (err) {
      const author = probeAuthor(tmp, opts.author);
      const given = givenChecks(opts);
      const blockers = [`upstream を clone できないので、公開側の検査を確かめられません（実行も同じ clone で止まります）: ${String((err as { stderr?: Buffer }).stderr ?? err).trim().slice(-200)}`];
      if (author.missing.length) blockers.push(authorBlocker(author.missing));
      return {
        publicChecks: confirmed ? confirmedChecks(confirmed) : given.length ? { state: "given", checks: given, setupHints: [] } : { state: "deferred", checks: [], setupHints: [] },
        author,
        gitignore: { present: null, excluded: [] },
        blockers,
      };
    }
    return probeUpstream(at, opts, confirmed);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** the Issue lane the registry will declare, and whether its labels exist on GitHub */
function intakeOf(opts: InitOptions, warnings: string[]): { lane: { labels: string[] } | null; intake: Prerequisites["intake"] } {
  const asked = opts.issueLane === undefined ? { labels: DEFAULT_LABELS } : opts.issueLane;
  const lane = asked && asked.labels.length ? asked : null;
  if (!lane) {
    // an explicit opt-out is the user's own choice; only an empty label list that left no lane needs telling
    warnings.push(opts.issueLane === null
      ? "Issue を取り込まない設定にしました（issue_lane を書きません）。この repo の Issue は lane になりません"
      : "Issue を取り込むラベルが空なので、issue_lane を書きません。この repo の Issue は lane になりません");
    return { lane, intake: { declared: false, labels: [], missingLabels: [], labelCheck: "none" } };
  }
  const have = (opts.listLabels ?? ghLabels)(opts.github);
  if (have === null) {
    warnings.push(`GitHub の ${opts.github} のラベルを確かめられませんでした（gh が無い、認証が無い、repo が見えないのどれか）。${lane.labels.join(", ")} があるか確かめてください`);
    return { lane, intake: { declared: true, labels: lane.labels, missingLabels: [], labelCheck: "unchecked" } };
  }
  const missingLabels = lane.labels.filter((l) => !have.includes(l));
  if (missingLabels.length) warnings.push(`ラベル ${missingLabels.join(", ")} が GitHub の ${opts.github} にありません。このラベルの Issue は作れず、取り込みは何も拾いません。登録は GitHub に書かないので、gh label create ${missingLabels[0]} --repo ${opts.github} などで作ってください`);
  return { lane, intake: { declared: true, labels: lane.labels, missingLabels, labelCheck: "checked" } };
}

/**
 * What a registration declares without the user having gone over it, named so the result can say it and say where to
 * correct it. A check the user named with --check is theirs; the setup beside it is still copied from the CI. Nothing
 * when the user confirmed the list, or when there is nothing to declare.
 */
function unconfirmedOf(publicChecks: Prerequisites["publicChecks"], github: string, reposFile: string, dryRun: boolean): Prerequisites["publicChecks"]["unconfirmed"] {
  if (publicChecks.state !== "found" && publicChecks.state !== "given") return undefined;
  const checks = publicChecks.state === "found" ? publicChecks.checks.map((c) => `${c.name}（${c.command}）`) : [];
  const setup = publicChecks.setupHints;
  if (!checks.length && !setup.length) return undefined;
  const afterwards = `登録の後は ${reposFile} の ${github} の checks（scope: public）と setup を直してください（登録済みの repo は登録し直せないので、手で編集します）`;
  return {
    checks,
    setup,
    fix: dryRun
      ? `登録の前に確かめるなら、--dry-run --checks-out FILE で一覧を書き出し、直して --checks-file FILE で渡してください。${afterwards}`
      : afterwards,
  };
}

const unconfirmedWarning = (u: NonNullable<Prerequisites["publicChecks"]["unconfirmed"]>) =>
  `${[u.checks.length ? `検査 ${u.checks.join(" ; ")}` : "", u.setup.length ? `setup ${u.setup.join(" ; ")}` : ""].filter(Boolean).join(" と ")} は、利用者が確かめていません（repo の CI と入口から写しただけです）。誤った検査は required で登録され、その repo のすべての提出と取り込みを止めます。${u.fix}`;

function overviewOf(opts: InitOptions, warnings: string[]): Prerequisites["overview"] {
  const statement = opts.overview?.trim();
  if (statement) return { state: "pending", statement };
  warnings.push(`概要（P-1）を渡していないので作りませんでした。最初の lane の計画役が repo の前提を推測で補います。登録の後に idd intent raise purpose --repo ${opts.github} --session SESSION --file FILE（FILE は {"id":"P-1","statement":"…","origin":"…"}）で打ってください（登録済みの repo は登録し直せないので、--overview は最初の登録でだけ渡せます）`);
  return { state: "none", note: "概要を渡していないので P-1 は作っていません" };
}

const PRE_PUSH = `#!/usr/bin/env bash
echo "work repo からは push しない。公開は idd の提出（propose → 承認 → export）経由で行う。" >&2
exit 1
`;

/**
 * Bring a project into the two-clone overlay layout. Stops before changing anything when a blocker is
 * found (dirty or unpushed work in an existing clone, existing records without a --records choice).
 */
export function runInit(opts: InitOptions): InitResult {
  const source = resolve(opts.source ?? templateRoot());
  const upstream = home(opts.upstream);
  const work = home(opts.work);
  const reposFile = resolve(opts.reposFile ?? areasPath());
  const steps: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const empty: Inventory = { template: null, docs: 0, decs: 0, pointerComments: 0, pointerFiles: [], conflicts: [] };

  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.github)) blockers.push("--github は owner/name");
  if (existsSync(work)) blockers.push(`work の置き場が既にあります: ${work}`);
  if (existsSync(reposFile) && parseRepos(readFileSync(reposFile, "utf8")).areas[opts.github]) blockers.push(`${opts.github} は config/repos.yaml に登録済みです`);

  // the list the user went over is read first: one that cannot be read stops the registration before anything is written
  let confirmed: CheckList | null = null;
  if (opts.checksFile) {
    if (opts.checks?.length) blockers.push("--checks-file と --check は同時に使えません（検査は一覧に書いてください）");
    if (opts.checksOut) blockers.push("--checks-file と --checks-out は同時に使えません（一覧を書き出すのと、直した一覧で登録するのは別の実行です）");
    const read = readCheckList(resolve(opts.checksFile));
    if ("error" in read) blockers.push(read.error);
    else if (!read.list.checks.length) blockers.push(`検査と setup の一覧 ${resolve(opts.checksFile)} に検査がありません。公開側の検査が無いと、公開側の差分が検査されないまま通ります。検査の行を足してください`);
    else confirmed = read.list;
  }
  // the one file a dry run may write: the one the user named for the list, never inside a clone
  const checksOut = opts.checksOut ? resolve(opts.checksOut) : null;
  if (checksOut) {
    // compared by where each really is, so a symlink or a registry that is not made yet cannot lead the write into what a dry run keeps
    // and on a filesystem that ignores letter case, by the folded spelling, so a place not made yet cannot slip past by its case
    // (one decision for all four, so a pair on different filesystems is still compared in the same spelling)
    const fold = [checksOut, upstream, work, reposFile].some((p) => ignoresCase(p));
    const target = foldedPlace(checksOut, fold);
    const under = (dir: string, path: string) => { const r = relative(dir, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
    const inside = (dir: string) => under(foldedPlace(dir, fold), target);
    const registry = foldedPlace(reposFile, fold);
    if (!opts.dryRun) blockers.push("--checks-out は --dry-run と一緒に使います（一覧を書き出すだけの実行で、登録はしません）");
    if (isThere(checksOut)) blockers.push(`一覧の書き出し先が既にあります（直した一覧を消さないため上書きしません）: ${checksOut}`);
    else if (inside(upstream) || inside(work) || under(target, foldedPlace(upstream, fold)) || under(target, foldedPlace(work, fold))) blockers.push(`一覧は upstream と work の外に書き出してください: ${checksOut}`);
    else if (under(registry, target) || under(target, registry)) blockers.push(`一覧の書き出し先が config/repos.yaml かその配下・親です（登録の file を壊すため書きません）: ${checksOut}`);
  }

  // 1. the upstream clone
  if (opts.existing) {
    if (!existsSync(join(upstream, ".git"))) blockers.push(`既存の clone がありません: ${upstream}`);
    else {
      if ((gitTry(upstream, ["status", "--porcelain"]) ?? "x").trim()) blockers.push("既存の clone に未 commit の変更があります。片付けてから導入してください");
      const ahead = gitTry(upstream, ["rev-list", "--count", "@{upstream}..HEAD"]);
      if (ahead === null) blockers.push("既存の clone の branch に追跡先がありません（未 push の作業が無いか確かめられません）");
      else if (Number(ahead.trim()) > 0) blockers.push(`既存の clone に未 push の commit が ${ahead.trim()} 件あります`);
      steps.push(`既存の clone を upstream にする: ${upstream}`);
    }
  } else if (existsSync(upstream)) blockers.push(`upstream の置き場が既にあります（既存の clone なら --existing）: ${upstream}`);
  else steps.push(`upstream を clone: ${opts.url ?? `https://github.com/${opts.github}.git`} → ${upstream}`);

  const inventory = opts.existing && existsSync(upstream) ? takeInventory(upstream) : empty;
  if (inventory.template && !opts.records) {
    blockers.push(`既存の記録があります（${inventory.template}${inventory.lockTag ? ` ${inventory.lockTag}` : ""}、文書 ${inventory.docs}・DEC ${inventory.decs}・コード中の DEC / INV への言及 ${inventory.pointerComments}）。--records keep（work 側へ移す）か --records drop（捨てる）を指定してください`);
  }
  if (inventory.template) warnings.push("公開側が既存の記録（overlay に入るパス）を追跡している間は、提出と取り込みが止まります。最初の提出の前に、公開側から記録を外す PR を出してください（共有 repo ではこの削除に合意を取ってください）");
  steps.push(`work を clone（fetch は GitHub、push は塞ぐ）: ${work}`, "work 側の base branch を作る", "骨格を置いて commit", `config/repos.yaml に ${opts.github} を足す`, "記録の検査（idd rules check）で確認");
  const { lane, intake } = intakeOf(opts, warnings);
  const overview = overviewOf(opts, warnings);
  const deferred: Prerequisites = {
    intake,
    publicChecks: { state: "deferred", checks: [], setupHints: [] },
    author: { state: "deferred", missing: [], from: {} },
    gitignore: { present: null, excluded: [] },
    overview,
  };
  if (blockers.length || opts.dryRun) {
    if (inventory.pointerComments > 0) warnings.push(`コード中の DEC / INV への言及が ${inventory.pointerComments} 件あります。意図とコードの対応を記録の place（旧い形では DEC の Anchors）へ移してコードから外す作業を TODO に積みます`);
    // a stop above is not read further; a dry run with nothing in the way reads the clone (or a throwaway one) as the run would
    const probe = blockers.length ? null : opts.existing ? probeUpstream(upstream, opts, confirmed) : probeFresh(opts, confirmed);
    if (probe) blockers.push(...probe.blockers);
    // the list is written whether or not the registration would go on: a repo whose checks were not found needs it to be filled in
    if (probe && checksOut && probe.publicChecks.state !== "deferred") {
      mkdirSync(dirname(checksOut), { recursive: true });
      writeFileSync(checksOut, renderCheckList({ checks: probe.publicChecks.checks, setup: probe.publicChecks.setupHints }));
      steps.push(`検査と setup の一覧を書き出した: ${checksOut}。直して --checks-file ${checksOut} で渡すと、そのとおりに登録します`);
    }
    // the entry the run would write is read by the same parser, so a dry run does not pass an input the run would be stopped on
    if (probe && !blockers.length) {
      const entry = repoEntry(opts, publicBaseOf(upstream, opts), opts.workBase ?? "work-main", `"${join(source, "bin", "idd")}" rules check`, lane, probe.publicChecks.checks, probe.publicChecks.setupHints);
      try {
        parseRepos(`${existsSync(reposFile) ? readFileSync(reposFile, "utf8") : "repos:\n"}${entry}`);
      } catch (err) {
        blockers.push(`config/repos.yaml に足す項目が不正です（実行も同じ理由で止まります）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (opts.dryRun) steps.push(`dry-run: ${steps.some((s) => s.startsWith("検査と setup の一覧を書き出した")) ? "一覧の file のほかは" : ""}何も変えていません（upstream・work・config/repos.yaml・P-1）`);
    // a dry run that is not writing the list for the user to go over says what the run would leave unconfirmed
    const unconfirmed = probe && !blockers.length && !checksOut ? unconfirmedOf(probe.publicChecks, opts.github, reposFile, true) : undefined;
    if (unconfirmed) warnings.push(unconfirmedWarning(unconfirmed));
    const prerequisites: Prerequisites = probe ? { ...deferred, publicChecks: { ...probe.publicChecks, ...(unconfirmed ? { unconfirmed } : {}) }, author: probe.author, gitignore: probe.gitignore } : deferred;
    return { ok: blockers.length === 0, ...(opts.dryRun ? { dryRun: true as const } : {}), steps, inventory, prerequisites, warnings, blockers };
  }

  // 1. upstream
  const cloned = !opts.existing;
  if (cloned) {
    mkdirSync(dirname(upstream), { recursive: true });
    git(dirname(upstream), ["clone", "-q", opts.url ?? `https://github.com/${opts.github}.git`, upstream]);
  }
  // what the lane needs from the public side is read before the work clone and the registry are written: a
  // repo that declares no check, or has no author, stops here with nothing but the upstream (a clone made now is removed)
  const probe = probeUpstream(upstream, opts, confirmed);
  if (probe.blockers.length) {
    if (cloned) rmSync(upstream, { recursive: true, force: true });
    return { ok: false, steps, inventory, prerequisites: { ...deferred, publicChecks: probe.publicChecks, author: probe.author, gitignore: probe.gitignore }, warnings, blockers: probe.blockers };
  }
  const originUrl = (gitTry(upstream, ["remote", "get-url", "origin"]) ?? "").trim();
  const publicBase = publicBaseOf(upstream, opts);
  const workBase = opts.workBase ?? "work-main";
  // the registry entry is checked whole before any clone of ours is made for the work side, so a bad entry stops early
  const checkCommand = `"${join(source, "bin", "idd")}" rules check`;
  const entry = repoEntry(opts, publicBase, workBase, checkCommand, lane, probe.publicChecks.checks, probe.publicChecks.setupHints);
  const registry = existsSync(reposFile) ? readFileSync(reposFile, "utf8") : "repos:\n";
  try {
    parseRepos(`${registry}${entry}`);
  } catch (err) {
    // a clone made by this run is not left for the next run to trip over
    if (cloned) rmSync(upstream, { recursive: true, force: true });
    throw err;
  }
  // the registration is known to go on, so only now is the clone's config changed: the published commits take their author from this clone's own config; only what the user passed is written, and never to the global config
  for (const [key, value] of [["user.name", opts.author?.name?.trim()], ["user.email", opts.author?.email?.trim()]] as const) {
    if (value) git(upstream, ["config", "--local", key, value]);
  }
  if (probe.publicChecks.state !== "confirmed" && probe.publicChecks.setupHints.length) warnings.push(`repo の CI は検査の前に次を回しているので、検査の複製の準備（config/repos.yaml の setup）に写しました。読み違いなら setup を直してください: ${probe.publicChecks.setupHints.join(" ; ")}`);
  const unconfirmed = unconfirmedOf(probe.publicChecks, opts.github, reposFile, false);
  if (unconfirmed) warnings.push(unconfirmedWarning(unconfirmed));
  if (probe.gitignore.present === false) {
    warnings.push(`公開側に .gitignore がありません。${probe.gitignore.excluded.length ? `生成物（${probe.gitignore.excluded.join(" ")}）は work の clone の exclude で外しました。` : "言語を見分けられなかったので、生成物は外していません。"}.gitignore は repo の持ち主の判断なので登録は書きません`);
  }

  // 2. work: a local clone whose fetch goes to GitHub and whose push goes nowhere
  mkdirSync(dirname(work), { recursive: true });
  git(dirname(work), ["clone", "-q", upstream, work]);
  git(work, ["remote", "set-url", "origin", originUrl || upstream]);
  git(work, ["remote", "set-url", "--push", "origin", "no-push://work-repo-must-not-push"]);
  // an identity set only in the upstream clone's own config would not reach the work clone
  for (const key of ["user.name", "user.email"]) {
    const value = (gitTry(upstream, ["config", "--local", "--get", key]) ?? "").trim();
    if (value) git(work, ["config", "--local", key, value]);
  }
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, PRE_PUSH);
  chmodSync(hook, 0o755);
  gitTry(work, ["fetch", "-q", "origin"]);
  const start = (gitTry(work, ["rev-parse", "--verify", `origin/${publicBase}`]) ?? git(work, ["rev-parse", "HEAD"])).trim();
  git(work, ["checkout", "-q", "-b", workBase, start]);

  // records of an existing project: keep them in the overlay, or drop them
  if (opts.records === "drop") {
    for (const p of ["_docs", "_meta", "TODO.md", "docs-template.lock.json"]) if (existsSync(join(work, p))) git(work, ["rm", "-r", "-q", p]);
  }

  // 3. skeleton: the record places, the TODO, the lock, the validator settings and the manifest. The norms,
  // the validators, the skills and the AGENTS files stay with the package or the user; this repo holds none of them.
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(work, rel)), { recursive: true }); writeFileSync(join(work, rel), body); };
  // the monorepo's own validator settings name its paths; a project starts from the overlay mode alone
  if (!existsSync(join(work, "docs-validators.json"))) put("docs-validators.json", `${JSON.stringify({ comments: { exclude: [], mode: "overlay" } }, null, 2)}\n`);
  for (const d of RECORD_DIRS) if (!existsSync(join(work, d))) put(join(d, ".gitkeep"), "");
  if (!existsSync(join(work, "TODO.md"))) put("TODO.md", emptyTodo(source));
  if (inventory.pointerComments > 0) {
    const files = inventory.pointerFiles.map((f) => `\`${f.path}\`（${f.count}）`).join("、");
    const queued = appendBacklogTask(readFileSync(join(work, "TODO.md"), "utf8"), {
      area: "Workflow",
      category: "Chore",
      title: "Move DEC / INV references out of code",
      goal: "コードから DEC / INV への言及がなくなり、統治対象のパス・シンボルは意図の記録の place（Choice の place。旧い形の DEC なら Anchors 節）にある。",
      criteria: [
        "コード中（`_docs/` `_meta/` と Markdown を除く）に `DEC-nnn` / `INV-nnn` への言及が残っていない。",
        "外した言及が指していたパス・シンボルが、該当する Choice の place（旧い形の DEC なら Anchors 節）にある。",
        "コメントを外す以外の挙動の変更がない。",
      ],
      steps: ["言及ごとに指している DEC / INV を確かめる", "パス・シンボルを Choice の place（`idd intent reanchor`。旧い形の DEC なら Anchors 節）へ移す", "コードから言及を外し、検査を通す"],
      context: `idd repo init で overlay 構成へ移したとき、コード中に DEC / INV への言及が ${inventory.pointerComments} 件あった。overlay 構成では記録は公開側に出ないので、コードからは参照できない。`,
      notes: `対象: ${files}`,
      qa: "_docs/qa/Workflow/maintenance.md",
    });
    if (queued) {
      writeFileSync(join(work, "TODO.md"), queued.todo);
      if (!existsSync(join(work, "_docs/qa/Workflow/maintenance.md"))) put("_docs/qa/Workflow/maintenance.md", emptyMaintenance("Workflow", new Date().toISOString().slice(0, 10)));
      warnings.push(`コード中の DEC / INV への言及が ${inventory.pointerComments} 件あります。記録の place へ移してコードから外す作業を TODO の ${queued.id} に積みました`);
    } else {
      warnings.push(`コード中の DEC / INV への言及が ${inventory.pointerComments} 件あります。TODO に Next ID No か Backlog が無いので、タスクは積んでいません（手で起票してください）`);
    }
  }
  const sourceCommit = (gitTry(source, ["rev-parse", "HEAD"]) ?? "").trim();
  const lockPath = join(work, "docs-template.lock.json");
  if (existsSync(lockPath)) {
    // an existing template user keeps its lock (the norms it started with); the validators and the adoption point
    // move to the package
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    put("docs-template.lock.json", `${JSON.stringify({ ...lock, validators_from: { source: "pi-web-idd", commit: sourceCommit }, adopted_base: start, adopted_at: new Date().toISOString() }, null, 2)}\n`);
  } else {
    put("docs-template.lock.json", `${JSON.stringify({ schema: 1, source: "pi-web-idd", revision: { commit: sourceCommit }, adopted_base: start, adopted_at: new Date().toISOString() }, null, 2)}\n`);
  }
  const manifest = [
    "# overlay manifest — 出力面に出さないパスの唯一の情報源（idd repo init が作成）",
    "# 行は path prefix。末尾の / はディレクトリ。この file 自身も含める。",
    "",
    "_docs/",
    "_meta/",
    "TODO.md",
    "overlay.manifest",
    "docs-template.lock.json",
    "docs-validators.json",
    "",
  ].join("\n");
  put("overlay.manifest", manifest);
  // the lane brief writes its scratch files under _meta/scratch; keep them out of git without touching .gitignore
  ensureScratchExcluded(work);
  // build products the ecosystem leaves in a clone stay out of a lane's commit, again without a tracked file
  ensureExcluded(work, probe.gitignore.excluded);
  git(work, ["add", "-A"]);
  git(work, ["-c", "user.name=idd", "-c", "user.email=idd@localhost", "commit", "-q", "-m", "chore(idd): overlay の骨格を導入（idd repo init）"]);
  const commit = git(work, ["rev-parse", "HEAD"]).trim();
  steps.push(`骨格を commit: ${commit.slice(0, 9)}`);
  const refs = overlayReferences(work, "HEAD", readManifest(work).paths);
  if (refs.length) warnings.push(`公開側のファイルが記録側のパスを参照しています。最初の提出までに公開側から外すか、公開側へ移してください: ${describeReferences(refs)}`);

  // 4. registry: the record check is the package's validator, so an adopted repo keeps no copy of it
  if (!existsSync(reposFile)) writeFileSync(reposFile, "repos:\n");
  appendFileSync(reposFile, entry);
  steps.push(`config/repos.yaml に追加: ${opts.github}`);

  // 5. smoke: the same mouth the registry names, run against the work clone
  if (!opts.skipCheck) {
    try {
      execFileSync("bash", ["-c", checkCommand], { cwd: work, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
      steps.push("記録の検査: pass");
    } catch (err) {
      warnings.push(`記録の検査が通りません（導入直後の確認として見てください）: ${String((err as { stderr?: Buffer }).stderr ?? err).slice(-300)}`);
    }
  }
  return { ok: true, steps, inventory, prerequisites: { intake, publicChecks: { ...probe.publicChecks, ...(unconfirmed ? { unconfirmed } : {}) }, author: probe.author, gitignore: probe.gitignore, overview }, warnings, blockers, commit };
}

/** add `_meta/scratch/` to a clone's own exclude file (not .gitignore: no tracked file is added) */
export function ensureScratchExcluded(repo: string): boolean {
  return ensureExcluded(repo, ["_meta/scratch/"]).length > 0;
}

/** add lines to a clone's own exclude file; returns the lines that were not there yet */
export function ensureExcluded(repo: string, lines: string[]): string[] {
  // asked of git: in a linked worktree `.git` is a file, and info/exclude lives in the common git dir
  const exclude = resolve(repo, git(repo, ["rev-parse", "--git-path", "info/exclude"]).trim());
  mkdirSync(dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const have = new Set(text.split("\n").map((l) => l.trim()));
  const added = lines.filter((l) => !have.has(l));
  if (!added.length) return [];
  appendFileSync(exclude, `${text === "" || text.endsWith("\n") ? "" : "\n"}${added.join("\n")}\n`);
  return added;
}
