import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scratchDir } from "./helpers/scratch.mjs";
import { mergedGh, noGh } from "./helpers/fake-gh.mjs";
import { SHIPPED_REPOS, shippedSkip } from "./helpers/shipped-repos.mjs";
import { ensureLaneWorktree } from "../src/worktree/ensure.ts";
import { proposeForTests as propose } from "../src/overlay/export.ts";
import { describeMutation } from "../src/overlay/gate.ts";
import { blockingFailures, blockingWhy } from "../src/overlay/check-reason.ts";
import { buildSubmit } from "../src/plan/ship.ts";
import { parseRepos } from "../src/config/areas.ts";
import { sectionHash } from "../src/config/conventions.ts";
import { commitConventionCheck, matchesCommitConvention } from "../src/plan/vocab.ts";

const original = process.cwd();
const NO_GH = noGh();
process.env.IDD_GH_BIN = NO_GH;
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@localhost", GIT_ALLOW_PROTOCOL: "file",
});
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function commit(cwd, message = "chore: fixture") { git(cwd, "add", "."); git(cwd, "commit", "-m", message); }

/** a repo with a work clone, an upstream clone, a lane worktree and one backlog row, as the overlay tests build it */
function setup({ checks = [], extra = {} } = {}) {
  process.chdir(original);
  const root = scratchDir("run-");
  const work = join(root, "work"), remote = join(root, "remote.git"), upstream = join(root, "upstream"), state = join(root, "state");
  mkdirSync(work); mkdirSync(state);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(work, "init", "--initial-branch=main");
  put(join(work, ".gitignore"), "node_modules/\n");
  put(join(work, "app.txt"), "one\ntwo\nthree\n");
  commit(work);
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "origin", "main");
  git(root, "clone", remote, upstream);
  git(upstream, "config", "user.name", "test");
  git(upstream, "config", "user.email", "test@localhost");
  git(work, "checkout", "-b", "work-main");
  put(join(work, "overlay.manifest"), "_docs/\noverlay.manifest\n");
  commit(work);
  const areas = join(root, "repos.yaml");
  const config = { github: "test/project", upstream, work, work_base: "work-main", public_base: "main", lanes_root: join(root, "lanes"), checks: typeof checks === "function" ? checks(root) : checks, issue_lane: { context: "personal", source_type_priority: "github" }, ...extra };
  put(areas, JSON.stringify({ repos: { demo: config } }));
  Object.assign(process.env, { IDD_REPOS_FILE: areas, IDD_STATE_DIR: state, IDD_INTENT_DIR: join(root, "unused") });
  const lane = ensureLaneWorktree("demo", "IDD-1");
  put(join(state, "backlog.jsonl"), JSON.stringify({ idd_id: "IDD-1", area: "demo", title: "Summary" }) + "\n");
  put(join(state, "executor-sessions.jsonl"), JSON.stringify({ idd_id: "IDD-1", worktree_path: lane.path, branch: lane.branch, executor_session_id: "s" }) + "\n");
  process.chdir(work);
  return { root, work, upstream, remote, state, lane };
}
function event(f, name, attrs = {}) {
  appendFileSync(join(f.state, "lifecycle-demo.jsonl"), JSON.stringify({ idd_id: "IDD-1", event: name, at: new Date().toISOString(), attrs }) + "\n");
}

// ------------------------------------------------------------------ the checks that hold the signature

test("a check that holds the signature is named whether it failed or did not run, and a count is only the fallback of an old record", () => {
  const checks = [
    { name: "typecheck", status: "pass", severity: "blocking" },
    { name: "docs", status: "fail", severity: "non-blocking", detail: "x" },
    { name: "lint", status: "not-applicable", severity: "blocking" },
    { name: "test", status: "fail", severity: "blocking", detail: "run\nerror boom\n3 failed" },
    { name: "moonbit", status: "skipped", severity: "blocking", detail: "準備に失敗したので回していません" },
    { name: "other", status: "skipped", severity: "blocking" },
  ];
  assert.deepEqual(blockingFailures(checks).map((f) => [f.name, f.status, f.reason]), [
    ["test", "fail", "error boom"],
    ["moonbit", "skipped", "準備に失敗したので回していません"],
    ["other", "skipped", "skipped"],
  ]);
  const why = blockingWhy(3, checks);
  assert.match(why, /^止めている検査: test（error boom）、moonbit（未実行: 準備に失敗したので回していません）、other（未実行）$/);
  assert.match(blockingWhy(4, [...checks, { name: "late", status: "fail", severity: "blocking", detail: "d" }]), /ほか 1 件$/);
  assert.equal(blockingWhy(2, undefined), "止める検査が 2 件あります");
  assert.equal(blockingWhy(2, [{ name: "ok", status: "pass", severity: "blocking" }]), "止める検査が 2 件あります");
});

// ------------------------------------------------------------------ the exit check names what it changed

test("a check that rewrote a tracked binary is named with its path as a generated file, and other kinds are listed as changed paths", () => {
  const f = setup();
  const repo = f.lane.path;
  put(join(repo, "pkg/__pycache__/m.pyc"), "");
  writeFileSync(join(repo, "pkg/__pycache__/m.pyc"), Buffer.from([0, 1, 2, 3, 0]));
  put(join(repo, "notes.txt"), "one\n");
  commit(repo, "feat: add");
  const submitted = git(repo, "rev-parse", "HEAD");
  // what a test run does to the copy: the binary is rewritten, a text file edited, a stray file left behind
  writeFileSync(join(repo, "pkg/__pycache__/m.pyc"), Buffer.from([0, 9, 9, 3, 0]));
  put(join(repo, "notes.txt"), "two\n");
  put(join(repo, "out/report.html"), "<html/>");
  const detail = describeMutation(repo, submitted);
  assert.match(detail, /^検査が提出内容を変更しました:/);
  assert.match(detail, / M pkg\/__pycache__\/m\.pyc/);
  assert.match(detail, / M notes\.txt/);
  assert.match(detail, /\?\? out\/report\.html/);
  const last = detail.split("\n").at(-1);
  assert.match(last, /変えた path 3 件。うち追跡されたバイナリ（生成物）1 件: pkg\/__pycache__\/m\.pyc/);
  assert.doesNotMatch(last, /notes\.txt|report\.html/);
  // the card reads a check's last line as its reason, so the path and the generated file are what it shows
  const failure = blockingFailures([{ name: "check-mutation", status: "fail", severity: "blocking", detail }])[0];
  assert.match(failure.reason, /m\.pyc/);
});

test("a tracked binary a check committed into the copy is named as a generated file as well as one it left uncommitted", () => {
  const f = setup();
  const repo = f.lane.path;
  put(join(repo, "pkg/__pycache__/m.pyc"), "");
  writeFileSync(join(repo, "pkg/__pycache__/m.pyc"), Buffer.from([0, 1, 2, 3, 0]));
  put(join(repo, "notes.txt"), "one\n");
  commit(repo, "feat: add");
  const submitted = git(repo, "rev-parse", "HEAD");
  // the check commits its own rewrite of the binary, and leaves a text edit uncommitted
  writeFileSync(join(repo, "pkg/__pycache__/m.pyc"), Buffer.from([0, 9, 9, 3, 0]));
  commit(repo, "chore: check output");
  put(join(repo, "notes.txt"), "two\n");
  const detail = describeMutation(repo, submitted);
  assert.match(detail, /C {2}pkg\/__pycache__\/m\.pyc/);
  assert.match(detail, / M notes\.txt/);
  assert.match(detail.split("\n").at(-1), /変えた path 2 件。うち追跡されたバイナリ（生成物）1 件: pkg\/__pycache__\/m\.pyc/);
});

test("the exit check of a real copy carries the path a test run rewrote, and no kind of product has to be known beforehand", async () => {
  const f = setup({ checks: [{ name: "rewrite", command: ["bash", "-c", "printf '\\000\\002' > data/blob.bin; echo done > stray.log"], required: true, scope: "public" }] });
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  mkdirSync(join(f.lane.path, "data"));
  writeFileSync(join(f.lane.path, "data/blob.bin"), Buffer.from([0, 1]));
  commit(f.lane.path, "feat: ours");
  const p = await propose("IDD-1", { title: "feat: exact title", body: "b\n" });
  assert.ok(!p.error, p.error);
  const mutation = p.checks.find((c) => c.name === "check-mutation");
  assert.equal(mutation.status, "fail");
  assert.match(mutation.detail, /data\/blob\.bin/);
  assert.match(mutation.detail, /stray\.log/);
  assert.match(mutation.detail, /追跡されたバイナリ（生成物）1 件: data\/blob\.bin/);
  assert.equal(p.blocking, 1);
});

// ------------------------------------------------------------------ the declaration of the commit message's form

test("the declaration is read beside the areas, its mistakes are config errors, and a repo with none has no declaration", () => {
  const text = (extra) => JSON.stringify({ repos: { "o/r": { upstream: "/u", work: "/w", ...extra } } });
  const file = parseRepos(text({ commit_convention: { types: ["feat", "fix", "docs", "chore"], source: "CONTRIBUTING.md" } }));
  assert.deepEqual(file.commitConvention["o/r"], { types: ["feat", "fix", "docs", "chore"], scope: false, source: "CONTRIBUTING.md" });
  assert.equal(parseRepos(text({})).commitConvention, undefined);
  // the settings that saved submits are hashed from do not move with the declaration
  const a = parseRepos(text({})).areas["o/r"], b = file.areas["o/r"];
  assert.deepEqual(a, b);
  for (const bad of [
    { types: ["feat"], source: "x", extra: 1 },
    { types: [], source: "x" },
    { types: "feat", source: "x" },
    { types: ["feat"], scope: "yes", source: "x" },
    { types: ["feat"] },
    { types: ["fe at"], source: "x" },
    "feat: x",
  ]) assert.throws(() => parseRepos(text({ commit_convention: bad })), /commit_convention/);
});

test("the message that goes out is judged by the declared type and form, and the precedent that disagrees is named in the same reason", () => {
  const convention = { types: ["feat", "fix", "docs", "chore"], scope: false, source: "CONTRIBUTING.md の Commit message" };
  assert.equal(matchesCommitConvention(convention, "feat: add x"), true);
  assert.equal(matchesCommitConvention(convention, "feat: add x\n\nbody"), true);
  for (const no of ["Summary", "feat:add", "feat(idd): x", "style: x", "Feat: x", "feat: ", ""]) assert.equal(matchesCommitConvention(convention, no), false, no);
  assert.equal(matchesCommitConvention({ ...convention, scope: true }, "chore(idd): x"), true);

  const bad = commitConventionCheck(convention, "Summary", []);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Summary/);
  assert.match(bad.reason, /CONTRIBUTING\.md の Commit message/);
  const good = commitConventionCheck(convention, "fix: stop it", ["chore: initial sandbox", "Merge branch 'x'"]);
  assert.equal(good.ok, true);
  assert.doesNotMatch(good.reason, /前例|直近/);
  // the declaration is the repo's word and the precedent is its practice: a disagreement is told, not followed
  const apart = commitConventionCheck(convention, "fix: stop it", ["chore(idd): x", "feat: y", "docs: z", "Merge pull request #1"]);
  assert.equal(apart.ok, true);
  assert.match(apart.reason, /直近の公開 commit 3 件のうち 1 件は宣言の形に沿っていません（例: 「chore\(idd\): x」）/);
  // the form reads as applying to every declared type, with or without a scope
  assert.match(bad.reason, /feat \/ fix \/ docs \/ chore のいずれか: 要約（CONTRIBUTING\.md/);
  assert.doesNotMatch(bad.reason, /\(scope\)/);
  const scoped = commitConventionCheck({ ...convention, scope: true }, "Summary", []);
  assert.match(scoped.reason, /feat \/ fix \/ docs \/ chore のいずれか: 要約（\(scope\) も可）（CONTRIBUTING\.md/);
  // no message yet is never a pass
  const none = commitConventionCheck(convention, "", []);
  assert.equal(none.ok, false);
  assert.match(none.label, /まだ見ていない/);
});

// ------------------------------------------------------------------ the record of a check, and the card built from it

test("a check run again at the same head records its time and whether the result moved, and the recent public subjects when a form is declared", async () => {
  const f = setup({ extra: { commit_convention: { types: ["feat", "fix", "docs", "chore"], source: "CONTRIBUTING.md の Commit message" } } });
  put(join(f.upstream, "ext.txt"), "x");
  commit(f.upstream, "Update stuff");
  git(f.upstream, "push", "origin", "main");
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  commit(f.lane.path, "feat: ours");
  const first = await propose("IDD-1", { title: "feat: t", body: "b\n" });
  assert.ok(!first.error, first.error);
  assert.match(first.checkedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(first.sinceLast, undefined, "the first check of a head has no earlier one to compare with");
  assert.ok(first.precedents.includes("Update stuff"));

  const second = await propose("IDD-1", { title: "feat: t", body: "b\n" });
  assert.ok(!second.error, second.error);
  assert.notEqual(second.token, first.token);
  assert.equal(second.sinceLast.changed, false);
  assert.deepEqual(second.sinceLast.changes, []);
  assert.equal(second.sinceLast.at, first.checkedAt);

  // a new head starts over: the earlier check was of another head
  writeFileSync(join(f.lane.path, "app.txt"), "ours2\n");
  commit(f.lane.path, "feat: ours 2");
  const third = await propose("IDD-1", { title: "feat: t", body: "b\n" });
  assert.equal(third.sinceLast, undefined);
});

test("a result that moved between two checks of the same head names the check", async () => {
  const f = setup({ checks: (root) => [{ name: "gate", command: ["bash", "-c", `test -f ${root}/go-ahead`], required: true, scope: "public" }] });
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  commit(f.lane.path, "feat: ours");
  const first = await propose("IDD-1", { title: "feat: t", body: "b\n" });
  assert.equal(first.checks.find((c) => c.name === "gate").status, "fail");
  put(join(f.root, "go-ahead"), "");
  const second = await propose("IDD-1", { title: "feat: t", body: "b\n" });
  assert.equal(second.checks.find((c) => c.name === "gate").status, "pass");
  assert.equal(second.sinceLast.changed, true);
  assert.deepEqual(second.sinceLast.changes, ["gate: fail → pass"]);
});

test("the card shows a commit message only when it goes out: a PR's title waiting for the draft is not one", async () => {
  const f = setup();
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  commit(f.lane.path, "feat: ours");
  event(f, "s4_submit_started", { head: git(f.lane.path, "rev-parse", "HEAD") });
  const p = await propose("IDD-1", { title: "Summary", body: "b\n" });
  assert.ok(!p.error, p.error);
  assert.equal(p.commitMessage, "Summary", "the record's message is the title when the repo declares no pattern");
  const head = git(f.lane.path, "rev-parse", "HEAD");

  const waiting = buildSubmit("IDD-1");
  assert.equal(waiting.commit.pending, true);
  assert.equal(waiting.commit.draft, undefined);
  assert.equal(waiting.commit.start, undefined, "the title is not carried as the message to start from");

  event(f, "s4_commit_draft_failed", { head, error: "no runner" });
  const failed = buildSubmit("IDD-1");
  assert.equal(failed.commit.failed, "no runner");
  assert.equal(failed.commit.pending, undefined);
  assert.equal(failed.commit.start, "Summary", "a failed draft leaves the lane a message to go on with, and says it failed");

  event(f, "s4_commit_drafted", { head, message: "feat: change the app" });
  const drafted = buildSubmit("IDD-1");
  assert.equal(drafted.commit.draft, "feat: change the app");
  assert.equal(drafted.commit.pending, undefined);
});

test("a repo with no declaration shows no line on the commit message's form, and a repo with one judges the draft that goes out, not the lane's commits", async () => {
  const none = setup();
  writeFileSync(join(none.lane.path, "app.txt"), "ours\n");
  commit(none.lane.path, "feat: ours");
  event(none, "s4_submit_started", { head: git(none.lane.path, "rev-parse", "HEAD") });
  await propose("IDD-1", { title: "Summary", body: "b\n" });
  assert.equal(buildSubmit("IDD-1").checks.some((c) => /commit message/.test(c.label)), false);
  assert.equal(buildSubmit("IDD-1").commitConvention, undefined);

  const f = setup({ extra: { commit_convention: { types: ["feat", "fix", "docs", "chore"], source: "CONTRIBUTING.md の Commit message" } } });
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  commit(f.lane.path, "feat: ours");
  const head = git(f.lane.path, "rev-parse", "HEAD");
  event(f, "s4_submit_started", { head });
  await propose("IDD-1", { title: "Summary", body: "b\n" });
  const line = (view) => view.checks.find((c) => c.key === "commit-convention");
  // the lane's own commit conforms, but nothing is drafted yet: no pass is shown for a message that does not exist
  assert.equal(line(buildSubmit("IDD-1")).ok, false);
  assert.match(line(buildSubmit("IDD-1")).label, /まだ見ていない/);
  event(f, "s4_commit_drafted", { head, message: "Summary" });
  assert.equal(line(buildSubmit("IDD-1")).ok, false);
  assert.match(line(buildSubmit("IDD-1")).reason, /1 行目「Summary」/);
  event(f, "s4_commit_drafted", { head, message: "feat: change the app" });
  const done = buildSubmit("IDD-1");
  assert.equal(line(done).ok, true);
  assert.deepEqual(done.commitConvention.convention.types, ["feat", "fix", "docs", "chore"]);
});

test("the registered overlay-sandbox declares its commit form, and its submit card judges the message that goes out by it", { skip: shippedSkip }, async () => {
  const registered = parseRepos(readFileSync(SHIPPED_REPOS, "utf8"));
  const declared = registered.commitConvention["penne-0505/overlay-sandbox"];
  assert.deepEqual(declared.types, ["feat", "fix", "docs", "chore"]);
  assert.match(declared.source, /CONTRIBUTING\.md/);
  // a repo whose CONTRIBUTING.md has no such line carries no declaration
  assert.equal(registered.commitConvention["penne-0505/waydroid_mpris"], undefined);

  const f = setup({ extra: { commit_convention: declared } });
  writeFileSync(join(f.lane.path, "app.txt"), "ours\n");
  commit(f.lane.path, "feat: ours");
  const head = git(f.lane.path, "rev-parse", "HEAD");
  event(f, "s4_submit_started", { head });
  await propose("IDD-1", { title: "Summary", body: "b\n" });
  const line = () => buildSubmit("IDD-1").checks.find((c) => c.key === "commit-convention");
  event(f, "s4_commit_drafted", { head, message: "Summary" });
  assert.equal(line().ok, false);
  assert.match(line().reason, /CONTRIBUTING\.md/);
  event(f, "s4_commit_drafted", { head, message: "docs: describe the sandbox" });
  assert.equal(line().ok, true);
});

// ------------------------------------------------------------------ the sections the repo points at, and the team's practice

const RULES = (commit, other = "other") => `# Rules\n\n## Commit\n\n${commit}\n\n## Other\n\n${other}\n`;
const POINT = { commit: { file: "RULES.md", section: "## Commit" } };
/** a public commit on main in the upstream clone, as the team would make it */
function publish(f, path, text, message = "docs: rules") {
  put(join(f.upstream, path), text);
  commit(f.upstream, message);
  git(f.upstream, "push", "origin", "main");
}
/** the lane commits and its submit is started; returns the head */
function startLane(f, text = "ours\n", message = "feat: ours") {
  writeFileSync(join(f.lane.path, "app.txt"), text);
  commit(f.lane.path, message);
  const head = git(f.lane.path, "rev-parse", "HEAD");
  event(f, "s4_submit_started", { head });
  return head;
}
const lines = (view, re) => view.checks.filter((c) => re.test(c.label));
/** a merged PR as `gh pr list --state merged` gives it */
const merged = (title, day, bot = false) => ({ title, author: { is_bot: bot }, mergedAt: `${day}T00:00:00Z` });
const check = () => propose("IDD-1", { title: "feat: t", body: "b\n" });
const lineOf = (re) => lines(buildSubmit("IDD-1"), re);

test("a pointer whose file or section the public base lacks is a failing line that names it, and the approval is not stopped", async () => {
  const f = setup({ extra: { conventions: POINT } });
  startLane(f);
  const noFile = await check();
  assert.ok(!noFile.error, noFile.error);
  assert.equal(noFile.blocking, 0);
  const [file] = lineOf(/規約の節が公開側に無い/);
  assert.equal(file.ok, false);
  assert.match(file.reason, /RULES\.md の ## Commit/);
  assert.match(file.reason, /file が無い/);

  publish(f, "RULES.md", "# Rules\n\n## Other\n\nx\n");
  const noSection = await check();
  assert.equal(noSection.blocking, 0);
  const [section] = lineOf(/規約の節が公開側に無い/);
  assert.match(section.reason, /見出しの節が無い/);

  // found: no failing line, and a passing one names the file and the section the draft followed, never the words
  publish(f, "RULES.md", RULES("Write feat: summary."), "docs: add the commit section");
  await check();
  assert.equal(lineOf(/規約の節が/).length, 0);
  const [followed] = lineOf(/下書きが従う規約の節/);
  assert.equal(followed.ok, true);
  assert.match(followed.reason, /RULES\.md の ## Commit/);
  assert.equal(followed.reason.includes("Write feat: summary."), false);
  assert.equal(lineOf(/前回の下書き/).length, 0, "a section that has not moved gives no line on a change");
});

test("a section that changed since the last draft sets itself beside the declared values until the head moves, and an edit elsewhere in the file is not a change", async () => {
  const f = setup({ extra: { conventions: POINT, commit_convention: { types: ["feat", "fix"] }, public_language: "en", issue_lane: { context: "personal", source_type_priority: "github", branch_name_pattern: "feature/{idd_id_lower}" } } });
  publish(f, "RULES.md", RULES("Write feat: summary."));
  startLane(f);
  const first = await check();
  assert.equal(first.conventions[0].found, true);
  assert.equal(first.conventions[0].baseline, undefined, "the first check has no earlier draft to compare with");
  assert.equal(JSON.stringify(first).includes("Write feat: summary."), false, "the record keeps a hash, never the section's words");
  assert.equal(lineOf(/前回の下書き/).length, 0);

  // an edit in another section moves the file but not the section
  publish(f, "RULES.md", RULES("Write feat: summary.", "changed"), "docs: other");
  await check();
  assert.equal(lineOf(/前回の下書き/).length, 0);

  publish(f, "RULES.md", RULES("Write fix: summary instead.", "changed"), "docs: commit rule");
  await check();
  const [changed] = lineOf(/前回の下書き/);
  assert.match(changed.label, /commit message/);
  assert.match(changed.reason, /RULES\.md の ## Commit/);
  assert.match(changed.reason, /commit の型: feat \/ fix のいずれか/);
  assert.match(changed.reason, /branch 名の型: feature\/\{idd_id_lower\}/);
  assert.match(changed.reason, /公開側の言語: en/);
  // checked again at the same head, it still says so: the draft of a head is made once
  await check();
  assert.equal(lineOf(/前回の下書き/).length, 1);
  // a new head is drafted under the section as it is now
  startLane(f, "ours2\n", "feat: ours 2");
  await check();
  assert.equal(lineOf(/前回の下書き/).length, 0);
});

/** what a draft records of the section it read, as the writer's runner hands it back */
const drafted = (commit) => [{ kind: "commit", file: "RULES.md", section: "## Commit", hash: sectionHash(`## Commit\n\n${commit}`) }];

test("the hash a draft recorded is the baseline of the first check, so a rule edited after the draft shows before any earlier check", async () => {
  const f = setup({ extra: { conventions: POINT, commit_convention: { types: ["feat", "fix"] } } });
  publish(f, "RULES.md", RULES("Write feat: summary."));
  const head = startLane(f);
  event(f, "s4_commit_drafted", { head, message: "feat: ours", conventions: drafted("Write feat: summary.") });
  publish(f, "RULES.md", RULES("Write fix: summary instead."), "docs: commit rule");
  const first = await check();
  assert.equal(first.conventions[0].baseline, sectionHash("## Commit\n\nWrite feat: summary."), "no earlier check, and the draft's hash is the baseline");
  assert.equal(lineOf(/前回の下書き/).length, 1);
  assert.equal(JSON.stringify(first).includes("Write feat: summary."), false, "the record keeps a hash, never the section's words");
  // a draft made under the section as it is now has nothing to be told apart from
  const next = startLane(f, "ours2\n", "feat: ours 2");
  event(f, "s4_commit_drafted", { head: next, message: "feat: ours 2", conventions: drafted("Write fix: summary instead.") });
  await check();
  assert.equal(lineOf(/前回の下書き/).length, 0);
  // a draft of another head is not the baseline of this one
  startLane(f, "ours3\n", "feat: ours 3");
  event(f, "s4_commit_drafted", { head: "0".repeat(40), message: "x", conventions: drafted("old words") });
  await check();
  assert.equal(lineOf(/前回の下書き/).length, 0);
});

test("a heading with no body is read as a section that is not there: a failing line that says so, and the approval is not stopped", async () => {
  const f = setup({ extra: { conventions: POINT } });
  publish(f, "RULES.md", RULES(""));
  startLane(f);
  const empty = await check();
  assert.ok(!empty.error, empty.error);
  assert.equal(empty.blocking, 0);
  assert.equal(empty.conventions[0].found, false);
  assert.equal(empty.conventions[0].missing, "body");
  const [line] = lineOf(/規約の節に本文が無い/);
  assert.equal(line.ok, false);
  assert.match(line.reason, /RULES\.md の ## Commit/);
  assert.match(line.reason, /本文がありません/);
  assert.equal(lineOf(/規約の節が公開側に無い/).length, 0);
});

test("the recent merged PRs' titles are set against the declared form: a line with the count and an example only when some are apart, whoever authored them", async () => {
  const answer = join(scratchDir("answer-"), "answer.json");
  const gh = mergedGh(answer, NO_GH);
  process.env.IDD_GH_BIN = gh;
  try {
    const f = setup({ extra: { commit_convention: { types: ["feat", "fix", "docs"], source: "RULES.md" } } });
    startLane(f);
    const titles = (list) => writeFileSync(answer, JSON.stringify(list.map(([title, bot]) => ({ title, author: { is_bot: bot === true } }))));
    titles([["feat: a"], ["fix: b"], ["Bump lodash from 1 to 2", true]]);
    const conforming = await check();
    // the author is not a filter: a bot's PR is one of the practice, and here it is apart from the form
    assert.deepEqual(conforming.mergedTitles, ["feat: a", "fix: b", "Bump lodash from 1 to 2"]);
    assert.match(lineOf(/merge された PR/)[0].reason, /3 件のうち 1 件/);
    titles([["feat: a"], ["fix: b"]]);
    await check();
    assert.equal(lineOf(/merge された PR/).length, 0);
    titles([["feat: a"], ["Summary"], ["[APP-1] 直す"], ["chore(ci): x"]]);
    await check();
    const [apart] = lineOf(/merge された PR/);
    assert.match(apart.reason, /4 件のうち 3 件/);
    assert.match(apart.reason, /例: 「Summary」/);
    assert.match(apart.reason, /どちらに合わせるか決めてください/);
    // no commit section is pointed at: the line does not say the draft followed one
    assert.match(apart.reason, /repo の規則と直近の commit に従って書かれています/);
    assert.doesNotMatch(apart.reason, /規約の節に従/);
    // the PRs come in creation order: the latest merged ten are read, not the ten latest created
    const many = Array.from({ length: 14 }, (_, i) => merged(`feat: m${i}`, `2026-10-${String(10 + i).padStart(2, "0")}`));
    many[13] = merged("Summary", "2026-10-01");
    many[0] = merged("Late", "2026-11-01");
    writeFileSync(answer, JSON.stringify(many));
    const ordered = await check();
    assert.equal(ordered.mergedTitles.length, 10);
    assert.equal(ordered.mergedTitles[0], "Late");
    assert.equal(ordered.mergedTitles[1], "feat: m12");
    assert.ok(!ordered.mergedTitles.includes("Summary"), "an old merge is not among the latest ten");
    // a run of bot PRs is the latest practice: it is not left out to reach the team's own
    const bots = Array.from({ length: 12 }, (_, i) => merged(`Bump dep ${i}`, `2026-10-${String(20 + i).padStart(2, "0")}`, true));
    writeFileSync(answer, JSON.stringify([...bots, merged("feat: old", "2026-10-09")]));
    const botRun = await check();
    assert.equal(botRun.mergedTitles.length, 10);
    assert.ok(botRun.mergedTitles.every((t) => t.startsWith("Bump dep")));
    assert.match(lineOf(/merge された PR/)[0].reason, /10 件のうち 10 件/);
    // no merged PR: read, but nothing to compare, and the card says so rather than showing nothing
    writeFileSync(answer, "[]");
    const nothing = await check();
    assert.deepEqual(nothing.mergedTitles, []);
    assert.equal(nothing.mergedTitlesUnread, undefined);
    const [none] = lineOf(/merge された PR|PR の題/);
    assert.equal(none.ok, true);
    assert.match(none.label, /比べられる merge 済みの PR の題が無い/);
    // GitHub cannot be asked: the card says the practice was not checked, and the approval is not stopped
    process.env.IDD_GH_BIN = NO_GH;
    const unread = await check();
    assert.equal(unread.mergedTitles, undefined);
    assert.equal(unread.mergedTitlesUnread, true);
    const [said] = lineOf(/merge された PR/);
    assert.equal(said.ok, false);
    assert.match(said.label, /確かめられなかった/);
  } finally { process.env.IDD_GH_BIN = NO_GH; }
  // a repo that declares no form shows no line, and asks nothing
  const none = setup();
  startLane(none);
  const p = await check();
  assert.equal(p.mergedTitles, undefined);
  assert.equal(p.mergedTitlesUnread, undefined);
});

test("a merged title apart from the form says the draft followed the section only when the section was read", async () => {
  const answer = join(scratchDir("answer-"), "answer.json");
  process.env.IDD_GH_BIN = mergedGh(answer, NO_GH);
  try {
    writeFileSync(answer, JSON.stringify([{ title: "Summary", author: { is_bot: false } }]));
    const f = setup({ extra: { conventions: POINT, commit_convention: { types: ["feat", "fix"] } } });
    startLane(f);
    // the section is not in the base: the draft was made without it, and the line does not say it followed it
    await check();
    const [without] = lineOf(/merge された PR/);
    assert.match(without.reason, /repo の規則と直近の commit に従って書かれています/);
    assert.doesNotMatch(without.reason, /規約の節に従/);
    publish(f, "RULES.md", RULES("Write feat: summary."));
    await check();
    const [read] = lineOf(/merge された PR/);
    assert.match(read.reason, /下書きは規約の節に従っています/);
  } finally { process.env.IDD_GH_BIN = NO_GH; }
});

test("the branch that goes out is set against the repo's declared rule: a pass when it is that name, a failing line when it is not, nothing without a rule", async () => {
  const lane = { context: "personal", source_type_priority: "github" };
  const f = setup({ extra: { issue_lane: { ...lane, branch_name_pattern: "idd/{idd_id}" } } });
  startLane(f);
  await check();
  const [ok] = lineOf(/branch 名/);
  assert.equal(ok.ok, true);
  assert.match(ok.reason, /idd\/IDD-1（型: idd\/\{idd_id\}）/);

  // the rule changes after the lane's branch was made: the name is not changed, and the card says it is off the rule
  const areas = JSON.parse(readFileSync(process.env.IDD_REPOS_FILE, "utf8"));
  areas.repos.demo.issue_lane.branch_name_pattern = "feature/{idd_id_lower}";
  writeFileSync(process.env.IDD_REPOS_FILE, JSON.stringify(areas));
  const p = await check();
  assert.ok(!p.error, p.error);
  assert.equal(p.blocking, 0);
  const [off] = lineOf(/branch 名/);
  assert.equal(off.ok, false);
  assert.match(off.reason, /idd\/IDD-1 は型 feature\/\{idd_id_lower\} がこの lane に与える名前（feature\/idd-1）と違います/);
  assert.equal(git(f.lane.path, "rev-parse", "--abbrev-ref", "HEAD"), "idd/IDD-1", "no branch is made again");

  // no declared rule: the default name is not judged
  const none = setup();
  startLane(none);
  await check();
  assert.equal(lineOf(/branch 名/).length, 0);
});
