import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ConversationRefused } from "./refusal.ts";

/** a path with links resolved, for comparing and containing; a path that does not exist yet is resolved as written */
export function comparablePath(path: string): string {
  try {
    return realpathSync(path).replace(/[/\\]+$/, "");
  } catch {
    return resolve(path).replace(/[/\\]+$/, "");
  }
}

export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/** whether `child` is `root` itself or inside it, by the resolved paths on both sides */
export function isWithin(root: string, child: string): boolean {
  const r = comparablePath(root);
  const c = comparablePath(child);
  if (r === c) return true;
  const rel = relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A workdir as written by a caller: a relative path under the workspace, with no `.` / `..` segment and no
 * segment starting with `.`. Returns it slash-normalized. The checks are here, not in a route, so every door
 * that takes a workdir (the create door today, others later) refuses the same shapes.
 */
export function parseWorkdir(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ConversationRefused("作業場所が空です", 400);
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]?/.test(trimmed)) throw new ConversationRefused("作業場所は workspace からの相対パスにしてください", 400);
  const segments = trimmed.split(/[\\/]/);
  for (const segment of segments) {
    if (!segment) throw new ConversationRefused("作業場所のパスが空の要素を含みます", 400);
    if (segment === "." || segment === "..") throw new ConversationRefused("作業場所に . や .. は使えません", 400);
    if (segment.startsWith(".")) throw new ConversationRefused("作業場所の名前を . で始めることはできません", 400);
  }
  return segments.join("/");
}

/**
 * The deepest existing ancestor of `target`, with the not-yet-existing tail put back. Used to decide
 * containment before a dir is created: a link on the way must not carry the new dir outside the workspace,
 * and a link whose real path cannot be read (a dangling one) is refused rather than guessed at.
 */
function resolvedTarget(target: string, label = "作業場所"): string {
  const tail: string[] = [];
  let probe = target;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch { /* keep walking up */ }
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  let base: string;
  try {
    base = realpathSync(probe);
  } catch {
    throw new ConversationRefused(`${label}の実体を確かめられません`, 400);
  }
  return tail.length ? join(base, ...tail) : base;
}

/**
 * A path's real destination, links resolved, with any not-yet-existing tail put back. The deepest existing
 * ancestor decides, so a link on the way (a declared place pointing at home/state, a link inside a place) is
 * resolved before anything is compared or written.
 */
export function resolveRealPath(target: string, label = "パス"): string {
  return resolvedTarget(target, label);
}

/** refuse a workdir whose real path would fall outside the workspace; a link pointing out is caught here */
export function assertWithinWorkspace(workspace: string, target: string): void {
  assertWithinRoot(workspace, target, "作業場所");
}

/**
 * The same containment check against any root, for the doors that write outside the workspace on purpose (an
 * idea's declared place): the deepest existing ancestor's real path decides, so a link on the way cannot carry
 * the target outside the root. `label` names what the root is, for the refusal's words.
 */
export function assertWithinRoot(root: string, target: string, label: string): void {
  const r = comparablePath(root);
  const full = resolvedTarget(target, label);
  const rel = relative(r, full);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ConversationRefused(`${label}の外を指しています`, 400);
}

/**
 * Turn a caller's workdir into a dir under the workspace: validate, create it when missing, and return the
 * absolute cwd and the slash-normalized relative path the responses carry. A file in the way is refused
 * before anything is created.
 */
export function resolveWorkdir(workspace: string, raw: string): { cwd: string; workdir: string } {
  const workdir = parseWorkdir(raw);
  if (!existsSync(workspace)) throw new ConversationRefused(`workspace がありません: ${workspace}`, 400);
  const target = join(workspace, ...workdir.split("/"));
  assertWithinWorkspace(workspace, target);
  if (existsSync(target) && !statSync(target).isDirectory()) throw new ConversationRefused(`作業場所がファイルです: ${workdir}`, 409);
  mkdirSync(target, { recursive: true });
  return { cwd: comparablePath(target), workdir };
}

/** a conversation cwd as a path relative to the workspace; the workspace itself is the empty string */
export function workdirOf(workspace: string, cwd: string): string {
  if (samePath(workspace, cwd)) return "";
  const rel = relative(comparablePath(workspace), comparablePath(cwd));
  return rel.split(sep).join("/");
}
