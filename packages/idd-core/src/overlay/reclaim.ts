import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { laneLocations } from "./export.ts";
import { readManifest, splitByManifest } from "./manifest.ts";
import { git, sha, tree, names, clean, mergeTrees, commitTree, dir, lock, read, save, recordPath } from "./git.ts";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";

export function reclaimLane(iddId: string): { ok: boolean; commit?: string; error?: string; recovery?: string } {
  let release: (() => void) | undefined;
  try {
    const loc = laneLocations(iddId);
    if (!loc) throw new Error("lane が見つかりません");
    release = lock(loc.work);
    const main = loc.config.local_path!;
    if (git(main, ["branch", "--show-current"]).trim() !== loc.config.work_base || !clean(main) || !clean(loc.work)) throw new Error("記録回収には作業本流と lane の clean な作業ツリーが必要です");
    const head = sha(loc.work), target = sha(main);
    // this lane head was already brought in; applying its records again would meet their own result
    const done = read<{ laneHead: string; workHead: string }>(recordPath("reclaimed", iddId));
    if (done?.laneHead === head) {
      try { git(main, ["merge-base", "--is-ancestor", done.workHead, target]); return { ok: true, commit: done.workHead }; } catch { /* the work branch moved away from it: reclaim again */ }
    }
    const base = git(main, ["merge-base", head, target]).trim();
    const manifest = readManifest(main);
    if (manifest.issues.length || readManifest(loc.work).issues.length) throw new Error("manifest が不正です");
    const paths = [...new Set([...manifest.paths, ...readManifest(loc.work).paths])];
    const held = splitByManifest(paths, names(main, base, head)).overlay;
    if (!held.length) return { ok: true, commit: target };
    const temp = mkdtempSync(join(dir("indexes"), "reclaim-"));
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    let records: string;
    try {
      git(main, ["read-tree", base], undefined, env);
      git(main, ["apply", "--cached", "--binary"], git(main, ["diff", "--binary", "--no-renames", base, head, "--", ...held]), env);
      records = git(main, ["write-tree"], undefined, env).trim();
    } finally { try { unlinkSync(env.GIT_INDEX_FILE); rmdirSync(temp); } catch { /* 診断用 index */ } }
    const merged = mergeTrees(main, tree(main, base), tree(main, target), records);
    if (merged.conflict) {
      const recovery = join(dir("record-conflicts"), randomBytes(10).toString("hex"));
      git(main, ["worktree", "add", "--detach", recovery, merged.localCommit]);
      try { git(recovery, ["-c", "user.name=IDD", "-c", "user.email=idd@localhost", "merge", "--no-commit", merged.incomingCommit]); } catch { /* 解消用 */ }
      return { ok: false, recovery, error: "記録の衝突があります。作業本流で内容を統合して再試行してください。lane は保持します" };
    }
    const commit = merged.tree === tree(main, target) ? target : commitTree(main, merged.tree, [target], `chore: recover lane records ${iddId}`);
    if (commit !== target) git(main, ["merge", "--ff-only", commit]);
    save(recordPath("reclaimed", iddId), { laneHead: head, workHead: commit, work: main, at: new Date().toISOString() });
    return { ok: true, commit };
  } catch (e) { return { ok: false, error: (e as Error).message }; } finally { release?.(); }
}
