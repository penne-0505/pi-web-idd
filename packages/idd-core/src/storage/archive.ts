import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** one file the archive held before it was written: its path relative to the state root, and its size */
export interface ArchiveMember {
  abs: string;
  rel: string;
}

export type ArchiveResult = { ok: true; target: string } | { ok: false; reason: string };

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ code: err ? 1 : 0, stdout: stdout ?? "", stderr: `${stderr ?? ""}${err ? String(err) : ""}` });
    });
  });
}

/** every regular file under a path, its size, and whether a link: symlink targets are never walked */
function walk(abs: string, root: string, out: Map<string, number | "link">): void {
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) { out.set(relative(root, abs), "link"); return; }
  if (st.isFile()) { out.set(relative(root, abs), st.size); return; }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(abs)) walk(join(abs, name), root, out);
}

/** the members an archive at `target` already holds: regular file path -> size, symlinks as "link" */
async function listedMembers(target: string): Promise<Map<string, number | "link"> | null> {
  const list = await run("tar", ["--zstd", "-tvf", target]);
  if (list.code !== 0) return null;
  const out = new Map<string, number | "link">();
  for (const line of list.stdout.split("\n")) {
    const m = /^([-dl])(?:[rwxsStT-]{9})\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.*)$/.exec(line.trimEnd());
    if (!m) continue;
    const [, kind, size, rest] = m;
    const path = kind === "l" ? rest.split(" -> ")[0] : rest;
    out.set(path.replace(/\/$/, ""), kind === "l" ? "link" : Number(size));
  }
  return out;
}

/** whether every wanted member is present in the archive with the same size */
function holds(archive: Map<string, number | "link">, wanted: Map<string, number | "link">): boolean {
  for (const [rel, size] of wanted) {
    if (size === "link") continue; // a symlink may be stored as a link or left out; its target is never read
    if (archive.get(rel) !== size) return false;
  }
  return true;
}

function freeNumbered(dir: string, lane: string): string {
  for (let n = 2; ; n += 1) {
    const p = join(dir, `${lane}.${n}.tar.zst`);
    if (!existsSync(p) && !existsSync(`${p}.partial`)) return p;
  }
}

/**
 * Write one lane's records into a single compressed file under `archiveDir`. The file is written under a
 * `.partial` name, checked (the compressor's own test, and every regular file present with the same size), and
 * only then renamed to its real name. An existing real-name file is never overwritten: when it already holds
 * every wanted regular file the archive counts as written, else the rest goes to a numbered name. Symlinks are
 * stored as links (tar's default) and their targets are never read.
 */
export async function archiveLane(opts: { archiveDir: string; stateRoot: string; lane: string; members: ArchiveMember[] }): Promise<ArchiveResult> {
  const { archiveDir, stateRoot } = opts;
  if (!existsSync(archiveDir)) return { ok: false, reason: `保存先が見えません: ${archiveDir}` };
  try { if (!statSync(archiveDir).isDirectory()) return { ok: false, reason: `保存先が dir ではありません: ${archiveDir}` }; } catch { return { ok: false, reason: `保存先を見られません: ${archiveDir}` }; }
  const wanted = new Map<string, number | "link">();
  for (const m of opts.members) walk(m.abs, stateRoot, wanted);
  if (!wanted.size) return { ok: false, reason: "写す記録がありません" };
  const existing = join(archiveDir, `${opts.lane}.tar.zst`);
  if (existsSync(existing)) {
    const have = await listedMembers(existing);
    if (have && holds(have, wanted)) return { ok: true, target: existing };
  }
  const target = existsSync(existing) ? freeNumbered(archiveDir, opts.lane) : existing;
  const partial = `${target}.partial`;
  const rels = [...new Set(opts.members.map((m) => relative(stateRoot, resolve(m.abs))))].sort();
  try { rmSync(partial, { force: true }); } catch { /* a stale partial from the last run */ }
  // tar runs with the state root as its cwd, and never dereferences a symlink (no -h)
  const made = await run("tar", ["--zstd", "-cf", partial, "--", ...rels], stateRoot);
  if (made.code !== 0) { try { rmSync(partial, { force: true }); } catch { /* ignored */ } return { ok: false, reason: `圧縮に失敗しました: ${made.stderr.split("\n")[0]?.slice(0, 200)}` }; }
  const intact = await run("zstd", ["-t", partial]);
  if (intact.code !== 0) { try { rmSync(partial, { force: true }); } catch { /* ignored */ } return { ok: false, reason: "圧縮の検査に通りませんでした" }; }
  const listed = await listedMembers(partial);
  if (!listed || !holds(listed, wanted)) { try { rmSync(partial, { force: true }); } catch { /* ignored */ } return { ok: false, reason: "中の一覧が元と一致しません" }; }
  if (existsSync(target)) {
    const have = await listedMembers(target);
    if (have && holds(have, wanted)) { try { rmSync(partial, { force: true }); } catch { /* ignored */ } return { ok: true, target }; }
    // the real name changed under us: the rest goes to a numbered name
    const numbered = freeNumbered(archiveDir, opts.lane);
    renameSync(partial, numbered);
    return { ok: true, target: numbered };
  }
  try {
    renameSync(partial, target);
  } catch (err) {
    return { ok: false, reason: `保存先へ書けません: ${String(err).slice(0, 200)}` };
  }
  return { ok: true, target };
}
