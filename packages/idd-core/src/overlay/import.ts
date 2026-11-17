import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readAreas, resolveAreaKey } from "../config/areas.ts";
import { readManifest, splitByManifest } from "./manifest.ts";
import { checkInCopy, runGate, blockingCount } from "./gate.ts";
import type { GateCheck } from "./gate.ts";
import { laneLocations, custodyPath, invalidateProposal, readProposal, proposalPath } from "./export.ts";
import type { Custody } from "./export.ts";
import { heavyLockOrRefuse } from "./heavy-lock.ts";
import { attempt, git, sha, tree, filteredTree, mergeTrees, commitTree, names, clean, key, dir, recordPath, read, save, lock, remoteTip, fetchPublic, destination, refuseOverlap } from "./git.ts";

export interface ImportOptions { laneId?: string; branch?: string }
export interface ImportView {
  area: string; work: string; branch: string; from: string; to: string; apply: string[]; held: string[];
  commits: string[]; dirty: boolean; recovery: string; conflict: boolean; token?: string; checks: GateCheck[];
  diff: string; expiresAt?: string;
  /** the public branch the receive takes in */
  remoteBranch: string;
}
interface Receipt extends ImportView {
  id: string; head: string; configKey: string; manifestKey: string; upstream: string;
  destinationKey: string; laneId?: string; recoveryHead?: string; acceptedHead?: string; applyingHead?: string;
  /** where the recovery was cut: a conflict is resolved once the recovery stands on a commit of someone's resolution */
  recoveryBase?: string;
  /** the public side's commit the recovery merges: a resolution is a commit that has it as an ancestor */
  recoveryIncoming?: string;
  /** whether the receive was cut with a conflict: such a recovery holds a person's resolution, which a newer public tip does not void */
  conflicted?: boolean;
}
interface ImportMark { last_import: string; work_head: string }
function identity(area: string, options: ImportOptions): string { return options.laneId ? `lane:${options.laneId}` : `area:${area}`; }
function receiptPath(area: string, options: ImportOptions): string { return recordPath("receipts", identity(area, options)); }
/** the registry key for the area as given (a short name is accepted), so the receipts stay keyed by it */
function areaKey(area: string): string {
  const resolved = resolveAreaKey(area);
  if ("error" in resolved) throw new Error(resolved.error);
  return resolved.key;
}
export function proposeImport(given: string, options: ImportOptions = {}): ImportView | { error: string } {
  let release: (() => void) | undefined;
  try {
    const area = areaKey(given);
    const cfg = readAreas().areas[area];
    const loc = options.laneId ? laneLocations(options.laneId) : null;
    if (!cfg?.work_base || !cfg.public_base || !cfg.local_path || !cfg.upstream_path || (options.laneId && (!loc || loc.area !== area))) throw new Error("repo の作業本流・公開先が未設定です");
    const work = loc?.work ?? cfg.local_path;
    release = lock(work);
    const branch = git(work, ["branch", "--show-current"]).trim();
    if (!branch || (!loc && branch !== cfg.work_base)) throw new Error(`受け入れ先は ${cfg.work_base} です。別 branch の作業は変更しません`);
    if (!clean(work)) throw new Error("受け入れ先に未 commit の変更があります");
    const manifest = readManifest(work);
    if (manifest.issues.length) throw new Error("受け入れ先の manifest が不正です");
    const previous = read<Receipt>(receiptPath(area, options));
    if (previous && !previous.acceptedHead && existsSync(previous.recovery)) {
      refuseOverlap(work, previous.to, manifest.paths, previous.remoteBranch, "受け入れ");
      return previous;
    }
    const head = sha(work);
    const custody = loc ? read<Custody>(custodyPath(options.laneId!)) : null;
    const remoteBranch = options.branch ?? custody?.branch ?? cfg.public_base;
    const endpoint = destination(cfg.upstream_path);
    // a lane's public branch deleted from the remote has nothing to take in: the lane is checked again from the card
    if (custody && !options.branch && remoteTip(cfg.upstream_path, remoteBranch) === null) {
      throw new Error(`公開 branch ${remoteBranch} が公開先から消えているので、受け入れるものがありません。提出前確認で検査し直すと、公開本流の上に出し直す push をカードで承認できます`);
    }
    const to = fetchPublic(work, cfg.upstream_path, remoteBranch);
    refuseOverlap(work, to, manifest.paths, remoteBranch, "受け入れ");
    const mark = read<ImportMark>(recordPath("imports", `${work}:${branch}`));
    if (mark) git(work, ["merge-base", "--is-ancestor", mark.work_head, head]);
    const from = custody?.publicTip ?? mark?.last_import ?? git(work, ["merge-base", head, to]).trim();
    const baseTree = custody?.workTree ?? filteredTree(work, from, manifest.paths);
    const targetTree = filteredTree(work, to, manifest.paths);
    const merged = mergeTrees(work, baseTree, tree(work, head), targetTree);
    const recovery = join(dir("recovery"), randomBytes(10).toString("hex"));
    git(work, ["worktree", "add", "--detach", recovery, merged.localCommit]);
    if (merged.conflict) {
      try { git(recovery, ["-c", "user.name=IDD", "-c", "user.email=idd@localhost", "merge", "--no-commit", "--no-ff", merged.incomingCommit]); } catch { /* 解消対象の index と worktree を保持する */ }
    } else {
      const result = commitTree(work, merged.tree, [merged.localCommit], "received external changes");
      git(recovery, ["merge", "--ff-only", result]);
    }
    if (existsSync(join(work, "node_modules")) && !existsSync(join(recovery, "node_modules"))) symlinkSync(join(work, "node_modules"), join(recovery, "node_modules"));
    const result: Receipt = {
      id: identity(area, options), area, work, branch, from, to, head, upstream: cfg.upstream_path,
      apply: splitByManifest(manifest.paths, names(work, head, merged.tree)).keep,
      held: splitByManifest(manifest.paths, names(work, from, to)).overlay,
      commits: git(work, ["log", "--reverse", "--format=%s", `${from}..${to}`]).trim().split("\n").filter(Boolean),
      dirty: false, recovery, recoveryBase: merged.localCommit, recoveryIncoming: merged.incomingCommit, conflict: merged.conflict, conflicted: merged.conflict, checks: [], diff: git(work, ["diff", head, merged.tree]),
      destinationKey: endpoint.fingerprint, configKey: key(cfg), manifestKey: key(readFileSync(join(work, "overlay.manifest"), "utf8")), remoteBranch, laneId: options.laneId,
    };
    save(receiptPath(area, options), result);
    return result;
  } catch (e) { return { error: (e as Error).message }; } finally { release?.(); }
}
export async function reviewImport(given: string, options: ImportOptions = {}): Promise<ImportView | { error: string }> {
  let release: (() => void) | undefined;
  try {
    const area = areaKey(given);
    const saved = read<Receipt>(receiptPath(area, options));
    const cfg = readAreas().areas[area];
    if (!saved || !cfg) throw new Error("受け入れ準備がありません");
    // the lock is held across the checks and marks them (DEC-2325 / DEC-2327)
    release = lock(saved.work, { checks: true });
    if (!clean(saved.recovery)) throw new Error(`衝突解消と commit を完了してください: ${saved.recovery}`);
    if (key(cfg) !== saved.configKey || sha(saved.work) !== saved.head) throw new Error("受け入れ先か設定が変わりました");
    const manifest = readManifest(saved.work);
    const changed = names(saved.work, saved.head, sha(saved.recovery));
    if (splitByManifest(manifest.paths, changed).overlay.length) throw new Error("解消結果が overlay を変更しています");
    saved.recoveryHead = sha(saved.recovery);
    // the repo's heavy checks run one at a time: the import takes the heavy-checks lock inside the overlay lock it holds
    // (overlay → heavy), for as long as its checks run. One another holds (the checks before an S2 loop converges) is a
    // wait, refused as a held overlay lock is
    const heavy = cfg.checks?.length ? heavyLockOrRefuse(saved.work, `import-${area}`) : () => undefined;
    try {
      // the recovery is where a person resolves; the checks run in a prepared copy of what it holds
      saved.checks = cfg.checks?.length
        ? [...await runGate(saved.recovery, readManifest(saved.recovery), saved.apply, []), ...await checkInCopy(saved.work, saved.recoveryHead, cfg.checks, { area, from: cfg.local_path!, deps: join(saved.work, "node_modules"), changed: changed.filter(p => existsSync(join(saved.recovery, p))), ...(saved.laneId ? { laneId: saved.laneId } : {}) })]
        : await runGate(saved.recovery, readManifest(saved.recovery), saved.apply, cfg.checks);
    } finally { heavy(); }
    saved.apply = splitByManifest(manifest.paths, changed).keep;
    saved.diff = git(saved.work, ["diff", saved.head, saved.recoveryHead]);
    saved.conflict = false;
    saved.token = randomBytes(24).toString("base64url");
    saved.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    save(receiptPath(area, options), saved);
    return saved;
  } catch (e) { return { error: (e as Error).message }; } finally { release?.(); }
}
/** `stale`: the public branch moved while the receive was being checked, and the receipt can be cut again from the new tip (`renewReceipt`) */
export interface ImportResult { ok: boolean; from?: string; to?: string; branch?: string; files?: number; error?: string; stale?: true }
export function importUpstream(given: string, token: string, options: ImportOptions = {}): ImportResult {
  let release: (() => void) | undefined;
  try {
    const area = areaKey(given);
    const saved = read<Receipt>(receiptPath(area, options));
    const cfg = readAreas().areas[area];
    if (!saved || !cfg || !token || token !== saved.token) throw new Error("受け入れ token が一致しません");
    release = lock(saved.work);
    if (saved.acceptedHead) return { ok: true, from: saved.from, to: saved.to, branch: saved.branch, files: saved.apply.length };
    const alreadyApplied = Boolean(saved.applyingHead && sha(saved.work) === saved.applyingHead);
    if ((!alreadyApplied && (!saved.expiresAt || Date.parse(saved.expiresAt) < Date.now())) || blockingCount(saved.checks)) throw new Error("再確認または必須検査の完了が必要です");
    if (destination(saved.upstream).fingerprint !== saved.destinationKey) throw new Error("Git の公開先が変更されました");
    if (key(cfg) !== saved.configKey || key(readFileSync(join(saved.work, "overlay.manifest"), "utf8")) !== saved.manifestKey) throw new Error("設定が変更されました");
    if (sha(saved.work) !== saved.head && sha(saved.work) !== saved.applyingHead || !clean(saved.work) || git(saved.work, ["branch", "--show-current"]).trim() !== saved.branch) throw new Error("受け入れ先が変更されました");
    if (!saved.recoveryHead || sha(saved.recovery) !== saved.recoveryHead || !clean(saved.recovery)) throw new Error("解消結果が変更されました");
    if (!alreadyApplied && remoteTip(saved.upstream, saved.remoteBranch) !== saved.to) {
      // a receipt nobody touched is cut again from the new tip by the next receive; one that holds a person's work is not, so it stops
      return { ok: false, error: "公開先が再更新されました", ...(untouched(saved) ? { stale: true as const } : {}) };
    }
    const head = saved.applyingHead ?? commitTree(saved.work, tree(saved.work, saved.recoveryHead), [saved.head], `chore: receive ${saved.remoteBranch}`);
    saved.applyingHead = head;
    save(receiptPath(area, options), saved);
    if (sha(saved.work) !== head) git(saved.work, ["merge", "--ff-only", head]);
    if (saved.laneId) {
      const manifest = readManifest(saved.work);
      save(custodyPath(saved.laneId), { branch: saved.remoteBranch, publicTip: saved.to, workTree: filteredTree(saved.work, saved.to, manifest.paths), workHead: head } satisfies Custody);
      invalidateProposal(saved.laneId);
      const prior = readProposal(saved.laneId);
      // a push this receive took in is done with, whether it was saved or not (a prepared record whose commit reached
      // the branch): left `prepared`, it would be finished again with a head it no longer matches
      const tookIn = prior?.status === "prepared" && Boolean(prior.outputCommit) && prior.branch === saved.remoteBranch
        && attempt(saved.work, ["merge-base", "--is-ancestor", prior.outputCommit!, saved.to]) !== null;
      if (prior?.status === "pushed" || tookIn) save(proposalPath(saved.laneId), { ...prior!, status: "complete", expiresAt: new Date(0).toISOString() });
    } else save(recordPath("imports", `${saved.work}:${saved.branch}`), { last_import: saved.to, work_head: head } satisfies ImportMark);
    saved.acceptedHead = head;
    save(receiptPath(area, options), saved);
    return { ok: true, from: saved.from, to: saved.to, branch: saved.branch, files: saved.apply.length };
  } catch (e) { return { ok: false, error: (e as Error).message }; } finally { release?.(); }
}

/** whether the saved receive's recovery holds nothing a person made: cut without a conflict, clean, and still on the commit it was cut as */
function untouched(saved: Receipt): boolean {
  if (saved.conflicted !== false || saved.acceptedHead || saved.applyingHead || saved.laneId || !saved.recoveryBase || !existsSync(saved.recovery)) return false;
  try { return clean(saved.recovery) && git(saved.recovery, ["rev-parse", "HEAD^"]).trim() === saved.recoveryBase; } catch { return false; }
}
/**
 * Bring the area's saved receive up to date before it is read: a receipt that the public tip, the work branch or the
 * destination has moved past is dropped when nobody has worked in its recovery (the receive then cuts a new one from
 * the present tip); one that holds a conflict's resolution is kept, since it is a person's work. A receipt whose only
 * difference is the area's settings (the checks a person fixed) is kept and takes the present settings; the review runs
 * the checks again under them. A lock refusal or anything unreadable leaves the receipt as it is, and the receive that follows says why.
 */
export function renewReceipt(given: string): void {
  let release: (() => void) | undefined;
  try {
    const area = areaKey(given);
    const cfg = readAreas().areas[area];
    if (!cfg?.local_path || !cfg.upstream_path) return;
    release = lock(cfg.local_path);
    const saved = read<Receipt>(receiptPath(area, {}));
    if (!saved || saved.acceptedHead || saved.applyingHead || saved.laneId) return;
    const stale = saved.work !== cfg.local_path || saved.upstream !== cfg.upstream_path || sha(saved.work) !== saved.head
      || git(saved.work, ["branch", "--show-current"]).trim() !== saved.branch
      || destination(cfg.upstream_path).fingerprint !== saved.destinationKey
      || remoteTip(cfg.upstream_path, saved.remoteBranch) !== saved.to;
    if (stale && untouched(saved)) {
      cancelImport(area);
      try { git(saved.work, ["worktree", "remove", "--force", saved.recovery]); } catch { /* already gone */ }
      return;
    }
    if (saved.configKey !== key(cfg)) {
      // the token and the checks were read under the old settings
      delete saved.token; delete saved.expiresAt;
      saved.checks = [];
      saved.configKey = key(cfg);
      save(receiptPath(area, {}), saved);
    }
  } catch { /* left as it is */ } finally { release?.(); }
}

export function cancelImport(given: string, options: ImportOptions = {}): { ok: boolean; recovery?: string; error?: string } {
  let area: string;
  try {
    area = areaKey(given);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const saved = read<Receipt>(receiptPath(area, options));
  if (!saved) return { ok: false, error: "受け入れ準備がありません" };
  if (saved.applyingHead && !saved.acceptedHead) return { ok: false, error: "反映途中です。同じ token で再試行してください" };
  save(recordPath("receipt-history", `${saved.id}:${saved.head}:${Date.now()}`), saved);
  save(receiptPath(area, options), null);
  return { ok: true, recovery: saved.recovery };
}
/**
 * Mark the area's saved receive as taken in when the work branch already holds the public tip: nothing is left to
 * apply, and the mark (what `importedCurrent` reads) says the tip is in. It is written only after reading that the tip
 * is still the one the receipt saw, the work branch still stands where the receipt was cut, and the tip is an ancestor of
 * it (or an earlier receive's mark already names it); any other no-op (no commit to take, but the tip not shown to be in)
 * is an error and writes nothing.
 */
export function markImportedNoop(given: string): { ok: boolean; error?: string; stale?: true } {
  let release: (() => void) | undefined;
  try {
    const area = areaKey(given);
    const saved = read<Receipt>(receiptPath(area, {}));
    if (!saved || saved.acceptedHead || saved.laneId) throw new Error("受け入れ準備がありません");
    release = lock(saved.work);
    if (git(saved.work, ["branch", "--show-current"]).trim() !== saved.branch || sha(saved.work) !== saved.head || !clean(saved.work)) throw new Error("受け入れ先が変更されました");
    if (remoteTip(saved.upstream, saved.remoteBranch) !== saved.to) return { ok: false, error: "公開先が再更新されました", stale: true };
    const markPath = recordPath("imports", `${saved.work}:${saved.branch}`);
    const mark = read<ImportMark>(markPath);
    // a receive lands as a commit that does not have the tip as a parent, so a tip taken in before is shown by the mark that says so
    if (mark?.last_import === saved.to && attempt(saved.work, ["merge-base", "--is-ancestor", mark.work_head, saved.head]) !== null) return { ok: true };
    if (attempt(saved.work, ["merge-base", "--is-ancestor", saved.to, saved.head]) === null) throw new Error("作業本流が公開先の先端を含んでいません");
    save(markPath, { last_import: saved.to, work_head: saved.head } satisfies ImportMark);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; } finally { release?.(); }
}
/**
 * Whether the conflict the area's saved receive stopped on has been resolved in its recovery: the recovery is clean and
 * stands on a commit that took the public side in (the commit it merges is among its ancestors). A merge abandoned
 * and followed by an empty commit moves the head without taking anything in, so it is not a resolution. A receipt
 * from before the recovery's base and incoming commit were kept is never read as resolved. The review of the
 * resolution (`reviewImport`) still checks the recovery before anything is accepted.
 */
export function conflictResolved(given: string): boolean {
  try {
    const saved = read<Receipt>(receiptPath(areaKey(given), {}));
    if (!saved || saved.acceptedHead || !saved.recoveryBase || !saved.recoveryIncoming || !existsSync(saved.recovery)) return false;
    return sha(saved.recovery) !== saved.recoveryBase && clean(saved.recovery)
      && attempt(saved.recovery, ["merge-base", "--is-ancestor", saved.recoveryIncoming, "HEAD"]) !== null;
  } catch { return false; }
}
/**
 * Where the area's receive stands, as one line: the work branch (its name too, since a switch to another branch at the same commit clears a stop on the branch), the area's settings with
 * the checks' preparation (a person fixing a check's setting clears a stop on it) and the saved receipt's recovery.
 * A stopped receive is read again only when this line differs from the one written when it stopped (what a person
 * changed to clear the cause shows here; the public tip is not in it, since a commit there clears no cause); a git
 * that cannot answer a part leaves it marked unknown.
 * The work branch's tip is in it only when asked (`work`): a stop of the receive itself is cleared in the recovery, the
 * settings or the checkout's state, and a commit that only moves the tip (another lane's receive) clears none of them.
 */
export function importStand(given: string, options: { work?: boolean } = {}): string {
  const parts: string[] = [];
  const part = (label: string, f: () => string | boolean | null) => {
    try { parts.push(`${label}=${f()}`); } catch { parts.push(`${label}=?`); }
  };
  try {
    const area = areaKey(given);
    const areas = readAreas();
    const cfg = areas.areas[area];
    if (!cfg?.local_path || !cfg.upstream_path || !cfg.public_base) return "";
    if (options.work !== false) part("work", () => sha(cfg.local_path!));
    part("work-branch", () => git(cfg.local_path!, ["branch", "--show-current"]).trim());
    part("config", () => key({ area: cfg, prep: areas.checkPrep?.[area] ?? null }));
    part("work-clean", () => clean(cfg.local_path!));
    const saved = read<Receipt>(receiptPath(area, {}));
    if (!saved || saved.acceptedHead) parts.push("receipt=none");
    else if (!existsSync(saved.recovery)) parts.push(`receipt=${saved.to} recovery=gone`);
    else {
      parts.push(`receipt=${saved.to}`);
      part("recovery", () => sha(saved.recovery));
      part("recovery-clean", () => clean(saved.recovery));
    }
  } catch { /* an area that cannot be read has no stand */ }
  return parts.join(" ");
}
export function importedCurrent(area: string): boolean {
  const cfg = readAreas().areas[area];
  if (!cfg?.local_path || !cfg.upstream_path || !cfg.public_base || !cfg.work_base) return false;
  const mark = read<ImportMark>(recordPath("imports", `${cfg.local_path}:${cfg.work_base}`));
  if (!mark || git(cfg.local_path, ["branch", "--show-current"]).trim() !== cfg.work_base) return false;
  try { git(cfg.local_path, ["merge-base", "--is-ancestor", mark.work_head, "HEAD"]); return remoteTip(cfg.upstream_path, cfg.public_base) === mark.last_import; } catch { return false; }
}
