import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { isOverlayPath, parseManifest, MANIFEST_FILE } from "../../idd-core/src/overlay/manifest.ts";
import { git, gitBytes, gitTry, runShell, tail } from "./git.ts";
import { expandHome } from "./paths.ts";
import { changeStartOf } from "./gate.ts";
import { RECORDLESS_MARK, repoForPath, type LaneRepo } from "./repos.ts";

export interface WorktreeMeta {
  path: string;
  repo: string;
  pr?: number;
  branch?: string;
  head: string;
  base: string;
  merge_base: string;
  created_at: string;
  setup: { command: string; exit: number }[];
}

function gh(args: string[], cwd: string): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
}

/** merge-base against <remote>/<base> when it exists, else the local <base> */
function mergeBaseOf(repo: LaneRepo, baseRef: string, head: string): string {
  const candidates = [...(repo.remote ? [`${repo.remote}/${baseRef}`] : []), baseRef];
  for (const ref of candidates) {
    const mb = gitTry(repo.clone, ["merge-base", ref, head]);
    if (mb) return mb.trim();
  }
  throw new Error(`merge-base を求められません: ${baseRef} と ${head}`);
}

export interface AddOptions {
  pr?: number;
  rev?: string;
  suffix?: string;
  name?: string;
  skipSetup?: boolean;
}

/** Create a detached review copy of a PR head (or any rev) under the repo's reviewRoot. */
export function addWorktree(repo: LaneRepo, opts: AddOptions): WorktreeMeta {
  if (!opts.pr && !opts.rev) throw new Error("--pr か --rev のどちらかが必要です");
  let head = "";
  let branch: string | undefined;
  let baseRef = repo.base;
  if (opts.pr) {
    if (!repo.github) throw new Error(`repo ${repo.name} に github（owner/name）がありません`);
    const info = JSON.parse(gh(["pr", "view", String(opts.pr), "--repo", repo.github, "--json", "headRefName,headRefOid,baseRefName,state"], repo.clone)) as { headRefName: string; headRefOid: string; baseRefName: string; state: string };
    branch = info.headRefName;
    head = info.headRefOid;
    baseRef = info.baseRefName;
    const remote = repo.remote || "origin";
    git(repo.clone, ["fetch", "--quiet", remote, info.baseRefName, `+refs/pull/${opts.pr}/head:refs/remotes/${remote}/pr/${opts.pr}`]);
    if (!gitTry(repo.clone, ["cat-file", "-e", `${head}^{commit}`])) git(repo.clone, ["fetch", "--quiet", remote, branch]);
  } else {
    if (repo.remote) { try { git(repo.clone, ["fetch", "--quiet", repo.remote, repo.base]); } catch { /* remote 無しの clone は local の base で足りる */ } }
    head = git(repo.clone, ["rev-parse", "--verify", `${opts.rev}^{commit}`]).trim();
  }
  const name = opts.name ?? (opts.pr ? `pr-${opts.pr}` : `rev-${head.slice(0, 9)}`) + (opts.suffix ? `-${opts.suffix}` : "");
  const path = join(repo.reviewRoot, name);
  if (existsSync(path)) throw new Error(`既に存在します: ${path}（idd wt rm か --suffix を使う）`);
  mkdirSync(repo.reviewRoot, { recursive: true });
  git(repo.clone, ["worktree", "add", "--detach", path, head]);
  for (const f of repo.copy) {
    const src = join(repo.clone, f);
    if (existsSync(src)) copyFileSync(src, join(path, f));
  }
  const mergeBase = mergeBaseOf(repo, baseRef, head);
  const setup: WorktreeMeta["setup"] = [];
  if (!opts.skipSetup) {
    for (const cmd of repo.setup) {
      const r = runShell(path, cmd, { timeoutMs: 15 * 60 * 1000 });
      setup.push({ command: cmd, exit: r.exit });
      if (r.exit !== 0) throw new Error(`setup に失敗: ${cmd}\n${tail(r.stderr || r.stdout)}`);
    }
  }
  const meta: WorktreeMeta = {
    path, repo: repo.name, ...(opts.pr ? { pr: opts.pr } : {}), ...(branch ? { branch } : {}),
    head, base: baseRef, merge_base: mergeBase, created_at: new Date().toISOString(), setup,
  };
  writeFileSync(join(repo.reviewRoot, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/**
 * The overlay manifest's rows as the lane's revs have them: the union of what the revs' own manifests list, since a
 * manifest that gained a row in the lane still has to take that row out of the base's side. Empty when no rev has a
 * manifest, which is a repo with no records to take out. A merge's two parents are revs the copy keeps as well
 * (`addRecordlessCopy`), so their manifests count too: a path only the merge or one side lists is still a record.
 */
export function manifestRowsAt(worktree: string, revs: string[]): string[] {
  const rows = new Set<string>();
  const all = new Set<string>(revs);
  for (const rev of revs) {
    const parents = gitTry(worktree, ["rev-list", "--parents", "-n", "1", rev])?.trim().split(" ").slice(1) ?? [];
    if (parents.length > 1) for (const parent of parents) all.add(parent);
  }
  for (const rev of all) {
    const text = gitTry(worktree, ["show", `${rev}:${MANIFEST_FILE}`]);
    if (text === null) continue;
    for (const row of parseManifest(MANIFEST_FILE, text).paths) rows.add(row);
  }
  return [...rows];
}

/** the revs a recordless copy keeps, by the name the caller reads them under */
export type CopyRevs = Record<string, string | undefined>;

export interface RecordlessCopy {
  meta: WorktreeMeta;
  /** each rev the caller named, as the commit the copy holds for it; the copy holds no other commit but a merge's parents */
  refs: Record<string, string>;
}

/** where a copy holds each rev the caller named, so that no commit it keeps is reachable only by luck */
const COPY_REV_REF_PREFIX = "refs/idd/rev/";

export { RECORDLESS_MARK };

/** the repo as the registry has it: `repo.base` is a rev on the review route, which no ref in the copy is named after */
function registeredRepo(repo: LaneRepo): LaneRepo | null {
  try { return repoForPath(repo.clone) ?? null; } catch { return null; }
}

const COPY_IDENTITY = { GIT_AUTHOR_NAME: "review", GIT_AUTHOR_EMAIL: "review@localhost", GIT_COMMITTER_NAME: "review", GIT_COMMITTER_EMAIL: "review@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };

/** the tree of `rev` with every path the rows name taken out, written into `src`'s object store */
function strippedTree(src: string, rev: string, rows: string[], scratch: string): string {
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  rmSync(env.GIT_INDEX_FILE, { force: true });
  gitBytes(src, ["read-tree", rev], { env });
  const files = gitBytes(src, ["ls-files", "-z"], { env }).toString("utf8").split("\0").filter(Boolean);
  const drop = files.filter((f) => isOverlayPath(rows, f));
  if (drop.length) gitBytes(src, ["update-index", "--force-remove", "-z", "--stdin"], { env, input: Buffer.from(`${drop.join("\0")}\0`) });
  return gitBytes(src, ["write-tree"], { env }).toString("utf8").trim();
}

/** where the copy's root commit is taken from, when the registry knows the repo: the head's merge base with the repo's base; null when the copy has no base, no head or no registered repo */
function copyChangeStart(repo: LaneRepo, baseSha: string | undefined, headSha: string | undefined): string | null {
  const registered = registeredRepo(repo);
  return baseSha && registered && headSha ? changeStartOf(repo.clone, registered, headSha) : null;
}

/**
 * Every row a copy cut by `addRecordlessCopy(repo, { revs, rows, head })` takes out: `rows` and, for a registered repo,
 * the manifest of the root commit the copy starts its list of changed files from, since a row the lane dropped is still
 * a record in an older tree. A caller that builds anything from the paths the copy holds (a route, a focus) must
 * leave out these rows, not only the ones it read from the revs.
 */
export function recordlessRows(repo: LaneRepo, opts: { revs: CopyRevs; rows: string[]; head: string }): string[] {
  const shaOf = (rev: string | undefined) => (rev ? gitTry(repo.clone, ["rev-parse", "--verify", rev])?.trim() || undefined : undefined);
  const start = copyChangeStart(repo, shaOf(opts.revs.base), shaOf(opts.revs[opts.head]));
  return start ? [...new Set([...opts.rows, ...manifestRowsAt(repo.clone, [start])])] : opts.rows;
}

/**
 * Create a review copy of the lane's revs with the records taken out, as a repository of its own. A linked worktree
 * shares the clone's object store and refs, so the records stay readable there from `git log --all`, `git show` and
 * `git cat-file` whatever the working tree holds. The copy is instead a fresh repository holding one commit per rev
 * the caller names (and a merge's two parents), each of a tree with the rows' paths removed, so neither the working
 * tree, nor a diff between any two of its commits, nor any object in it carries a record.
 */
export function addRecordlessCopy(repo: LaneRepo, opts: { name: string; revs: CopyRevs; rows: string[]; head: string }): RecordlessCopy {
  const path = join(repo.reviewRoot, opts.name);
  if (existsSync(path)) throw new Error(`既に存在します: ${path}（idd wt rm か --suffix を使う）`);
  mkdirSync(repo.reviewRoot, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "idd-recordless-"));
  const src = repo.clone;
  // a tree-ish is as good as a commit: only its tree is kept
  const resolveRev = (rev: string) => git(src, ["rev-parse", "--verify", rev]).trim();
  try {
    const wanted = Object.entries(opts.revs).flatMap(([k, v]) => (v ? [[k, resolveRev(v)] as const] : []));
    const revOf = (key: string) => wanted.find(([k]) => k === key)?.[1];
    const baseSha = revOf("base");
    // the root every other commit descends from is where the lane's worktree starts its list of changed files: the
    // merge base of the head with the registry's base, found by the path the worktree uses. Not the lane's origin
    // (`laneBase`), which is the work clone's mainline and may be ahead of the public base. Where the registry gives no
    // base the worktree has no list either, and the root falls back to the origin. A copy with no `base` has no root
    // and so no list
    const registered = registeredRepo(repo);
    const headSha = revOf(opts.head);
    const start = copyChangeStart(repo, baseSha, headSha);
    const rootSha = baseSha ? start ?? revOf("laneBase") ?? baseSha : undefined;
    // the root's own manifest counts too: a row the lane dropped is still a record in an older tree
    const rows = start ? [...new Set([...opts.rows, ...manifestRowsAt(src, [start])])] : opts.rows;
    // a merge keeps its two parents so that `git show --cc` reads its resolution; no other ancestry is kept
    const parentsOf = (sha: string) => gitTry(src, ["rev-list", "--parents", "-n", "1", sha])?.trim().split(" ").slice(1) ?? [];
    const shas = new Set<string>([...wanted.map(([, sha]) => sha), ...(rootSha ? [rootSha] : [])]);
    for (const sha of [...shas]) {
      const parents = parentsOf(sha);
      if (parents.length > 1) for (const parent of parents) shas.add(parent);
    }
    const trees = new Map<string, string>();
    for (const sha of shas) trees.set(sha, strippedTree(src, sha, rows, scratch));
    mkdirSync(path, { recursive: true });
    gitBytes(path, ["init", "--quiet"]);
    // the copy is a repository of its own, so it does not share the clone's exclude: without it the links the setup
    // makes (node_modules) are untracked files, and a role that must leave the copy clean fails on them
    const exclude = resolve(src, git(src, ["rev-parse", "--git-path", "info/exclude"]).trim());
    if (existsSync(exclude)) {
      const kept = readFileSync(exclude, "utf8").split("\n").filter((line) => {
        const pattern = line.trim().replace(/^!/, "").replace(/^\//, "");
        const dir = `${pattern.replace(/\/$/, "")}/`;
        // a line on a record, under one, or over one (a directory that holds a record) names where the records were
        return pattern !== "" && !pattern.startsWith("#") && !isOverlayPath(rows, pattern) && !isOverlayPath(rows, dir) && !rows.some((row) => row.startsWith(dir));
      });
      mkdirSync(join(path, ".git", "info"), { recursive: true });
      writeFileSync(join(path, ".git", "info", "exclude"), kept.length ? `${kept.join("\n")}\n` : "");
    }
    const objects = gitBytes(src, ["rev-list", "--objects", ...new Set(trees.values())]);
    const pack = gitBytes(src, ["pack-objects", "--stdout", "--quiet"], { input: objects });
    gitBytes(path, ["unpack-objects", "-q"], { input: pack });
    const made = new Map<string, string>();
    const commitOf = (sha: string, withParents: boolean): string => {
      const had = made.get(sha);
      if (had) return had;
      const parents = withParents ? parentsOf(sha) : [];
      const kept = parents.length > 1 ? parents : rootSha && sha !== rootSha ? [rootSha] : [];
      const args = ["commit-tree", trees.get(sha) as string, ...kept.flatMap((p) => ["-p", commitOf(p, false)]), "-m", "review copy"];
      const out = gitBytes(path, args, { env: COPY_IDENTITY }).toString("utf8").trim();
      made.set(sha, out);
      return out;
    };
    const refs: Record<string, string> = {};
    for (const [key, sha] of wanted) refs[key] = commitOf(sha, true);
    // the root is made even when no rev the caller named is it; every other commit descends from it
    const rootCommit = rootSha ? commitOf(rootSha, false) : undefined;
    const headSyn = refs[opts.head];
    if (!headSyn) throw new Error(`複製の head ${opts.head} がありません`);
    // a commit no ref reaches is lost to the first prune, and the revs the brief names must stay readable
    for (const [key, commit] of Object.entries(refs)) gitBytes(path, ["update-ref", `${COPY_REV_REF_PREFIX}${key}`, commit]);
    // the root under the name the registry gives the base, which is where the list of changed files looks for it
    const baseName = registered?.base || null;
    if (baseName && rootCommit) gitBytes(path, ["update-ref", `refs/heads/${baseName}`, rootCommit]);
    // what the copy took out, and the repo it was cut for: `idd wait-run --check` reads them, to find the repo's checks (the copy
    // lies outside every root the registry knows) and to say so beside a result that cannot see those paths
    writeFileSync(join(path, ".git", RECORDLESS_MARK), `${JSON.stringify({ stripped: rows, ...(registered ? { repo: registered.name } : {}) })}\n`);
    gitBytes(path, ["checkout", "--quiet", "--detach", headSyn]);
    for (const f of repo.copy) {
      const from = join(repo.clone, f);
      if (existsSync(from) && !isOverlayPath(rows, f)) copyFileSync(from, join(path, f));
    }
    const meta: WorktreeMeta = { path, repo: repo.name, head: headSyn, base: repo.base, merge_base: headSyn, created_at: new Date().toISOString(), setup: [] };
    writeFileSync(join(repo.reviewRoot, `${opts.name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    return { meta, refs };
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A copy its caller cut and recorded (a review lane names its copy after itself): it may lie outside today's
 * reviewRoot when the root was moved after it was cut.
 */
export interface RecordedCopy {
  /** the name the copy was cut with */
  name: string;
  /** the PR its meta must name, when known */
  pr?: number;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** the linked worktrees of a clone, the clone itself left out */
function linkedWorktrees(clone: string): string[] {
  const out = gitTry(clone, ["worktree", "list", "--porcelain"]) ?? "";
  return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9))).slice(1);
}

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function readMeta(path: string): Partial<WorktreeMeta> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Partial<WorktreeMeta>; } catch { return null; }
}

/** a meta that names this copy of this repo (its path may be written through a link to the copy's directory) */
const namesCopy = (meta: Partial<WorktreeMeta> | null, repo: LaneRepo, at: string) =>
  !!meta && typeof meta.path === "string" && real(resolve(meta.path)) === at && meta.repo === repo.name;

interface CopyPlace {
  /** the copy's real path: what git is given */
  at: string;
  metaPath: string;
  /** for a copy outside the reviewRoot, the clone it was found in */
  owner?: string;
}

/**
 * Where a copy really is and where its meta lives. A symlink is never a copy. Under the reviewRoot the copy must
 * really be under it and not inside a clone or the lanes' root (unless the root itself is). Outside the root only a
 * recorded copy is taken, and only when it is a linked worktree of this repo's clone or work clone, not inside a
 * clone or the lanes' root, named as recorded, and its own meta beside it (written when it was cut) names it.
 */
function copyPlace(repo: LaneRepo, abs: string, recorded: RecordedCopy | undefined): CopyPlace {
  const inRoot = abs.startsWith(`${repo.reviewRoot}/`);
  if (!inRoot && !recorded) throw new Error(`reviewRoot 配下ではありません: ${abs}`);
  const refuse = (why: string) => new Error(`review 用の複製として扱えません（${why}）: ${abs}`);
  if (isLink(abs)) throw refuse("symlink");
  const at = real(abs);
  const metaPath = join(dirname(at), `${basename(at)}.json`);
  const roots = [repo.clone, repo.work, repo.lanesRoot].map(real);
  if (inRoot) {
    const root = real(repo.reviewRoot);
    if (!at.startsWith(`${root}/`)) throw refuse("reviewRoot の外にある");
    for (const r of roots) if (within(at, r) && !within(root, r)) throw refuse(`${r} の中にある`);
    return { at, metaPath };
  }
  const rec = recorded as RecordedCopy;
  if (basename(at) !== rec.name) throw refuse(`名前が記録の ${rec.name} と違う`);
  for (const r of roots) if (within(at, r)) throw refuse(`${r} の中にある`);
  const owner = [repo.clone, repo.work].find((c) => linkedWorktrees(c).includes(at));
  if (!owner) throw refuse(`${repo.name} の clone の worktree ではない`);
  const meta = readMeta(metaPath);
  if (!meta) throw refuse(`複製の記録 ${metaPath} が読めない`);
  if (!namesCopy(meta, repo, at)) throw refuse(`複製の記録 ${metaPath} が別の path か repo を指す`);
  if (rec.pr !== undefined && meta.pr !== rec.pr) throw refuse(`複製の記録の PR が #${rec.pr} ではない`);
  return { at, metaPath, owner };
}

/** Move an existing detached copy to a new head (re-review after the author pushed). */
export function moveWorktree(repo: LaneRepo, path: string, opts: { pr?: number; rev?: string; recorded?: RecordedCopy }): WorktreeMeta {
  const abs = resolve(expandHome(path));
  const { at, metaPath } = copyPlace(repo, abs, opts.recorded);
  const prev = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as WorktreeMeta : null;
  const pr = opts.pr ?? prev?.pr;
  let head = "";
  let baseRef = prev?.base ?? repo.base;
  if (pr) {
    if (!repo.github) throw new Error("github がありません");
    const info = JSON.parse(gh(["pr", "view", String(pr), "--repo", repo.github, "--json", "headRefOid,baseRefName"], repo.clone)) as { headRefOid: string; baseRefName: string };
    head = info.headRefOid; baseRef = info.baseRefName;
    git(repo.clone, ["fetch", "--quiet", repo.remote || "origin", baseRef, `+refs/pull/${pr}/head:refs/remotes/${repo.remote || "origin"}/pr/${pr}`]);
  } else if (opts.rev) {
    head = git(repo.clone, ["rev-parse", "--verify", `${opts.rev}^{commit}`]).trim();
  } else throw new Error("--pr か --rev が必要です");
  if (git(at, ["status", "--short"]).trim()) throw new Error(`worktree が dirty です: ${abs}`);
  const mergeBase = mergeBaseOf(repo, baseRef, head);
  git(at, ["checkout", "--quiet", "--detach", head]);
  const meta: WorktreeMeta = {
    path: abs, repo: repo.name, ...(pr ? { pr } : {}), ...(prev?.branch ? { branch: prev.branch } : {}),
    head, base: baseRef, merge_base: mergeBase,
    created_at: prev?.created_at ?? new Date().toISOString(), setup: prev?.setup ?? [],
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function removeWorktree(repo: LaneRepo, path: string, opts: { force?: boolean; recorded?: RecordedCopy } = {}): { removed: string } {
  const abs = resolve(expandHome(path));
  const place = copyPlace(repo, abs, opts.recorded);
  const { at } = place;
  const dirty = git(at, ["status", "--short"]).trim() !== "";
  if (dirty && !opts.force) throw new Error(`worktree が dirty です（--force で削除）: ${abs}`);
  // remove from the clone the copy belongs to (a copy cut from the work clone is not the upstream's)
  let owner = place.owner;
  let standalone = false;
  if (!owner) {
    const common = git(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    // a copy that is a repository of its own (a recordless copy) has no clone to be removed from: its directory is all of it
    standalone = real(common) === join(at, ".git");
    owner = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : repo.clone;
  }
  // an older move of a copy outside the root wrote its meta into today's root; that one goes too when it names this copy.
  // Read before the copy is gone, while its path still resolves
  const stray = join(repo.reviewRoot, `${basename(at)}.json`);
  const metas = [place.metaPath, ...(real(stray) !== real(place.metaPath) && namesCopy(readMeta(stray), repo, at) ? [stray] : [])];
  if (standalone) rmSync(at, { recursive: true, force: true });
  else git(owner, ["worktree", "remove", ...(opts.force ? ["--force"] : []), at]);
  for (const m of metas) {
    // the copy is gone: a meta left behind does not make the removal a failure
    try { rmSync(m, { force: true }); } catch { /* ignore */ }
  }
  return { removed: abs };
}

export function listWorktrees(repo: LaneRepo): { path: string; head: string; branch: string | null }[] {
  const out: { path: string; head: string; branch: string | null }[] = [];
  let cur: { path: string; head: string; branch: string | null } | null = null;
  for (const line of git(repo.clone, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), head: "", branch: null }; out.push(cur); }
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
  }
  return out.filter((w) => w.path.startsWith(`${repo.reviewRoot}/`));
}
