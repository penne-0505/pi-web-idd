import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pi side of a read-only run that must not read outside one directory. It blocks `read`, `grep`, `find` and `ls`
 * calls whose path names a place outside the root the harness puts in `READ_ROOT_ENV`, so a file outside the root
 * never reaches the model. A call it cannot place is blocked too: with the root missing, every call is.
 *
 * What it checks is the call's own arguments: the path, resolved through symlinks, and the glob or pattern, which may
 * not start from `/` or `~` or climb with `..`. A symlink inside the root that leads out is caught for the path given and for the spelling pi opens in its place (decomposed unicode, curly quotes);
 * a directory walk that meets such a link on its way is not followed by the tools it guards.
 */

/** the env var the harness sets for a run that must read only inside one directory */
export const READ_ROOT_ENV = "IDD_READ_ROOT";

const GUARDED = new Set(["read", "grep", "find", "ls"]);

const HERE = dirname(fileURLToPath(import.meta.url));

/** the extension's own path, named on top of pi's disabled extension discovery */
export function pathGuardExtensionPath(): string {
  return join(HERE, "path-guard.ts");
}

/** the path as the tool reads it: pi drops a leading `@` */
const stripAt = (p: string): string => (p.startsWith("@") ? p.slice(1) : p);

/** pi turns these spaces into a plain one before it opens a path, and does not trim */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** a URI (`file:///…` is one pi opens as a path) or a `//` start: not resolved here, refused */
const URI_OR_NETWORK = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/;

/** the path string pi's tools open, in pi's own order: unicode spaces, then the leading `@` */
const asToolReads = (p: string): string => stripAt(p.replace(UNICODE_SPACES, " "));

/** the real path of the nearest part of `p` that exists, with the rest put back: where a call would land */
function landing(p: string): string {
  let head = p;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(head.slice(up.length).replace(/^[\\/]+/, ""));
    head = up;
  }
  return resolve(realpathSync(head), ...rest);
}

/**
 * The path pi's `read` really opens. pi opens the path as given when it exists, and otherwise tries these spellings in
 * this order and opens the first that exists: the narrow no-break space before AM/PM, the decomposed (NFD) form, the
 * curly apostrophe, and the last two together. A guard that judged only the given spelling would pass a name that is
 * canonically equal to a symlink pointing out, because pi would open the symlink.
 */
function readTarget(resolved: string): string {
  const nfd = resolved.normalize("NFD");
  const curly = (p: string): string => p.replace(/'/g, "\u2019");
  const candidates = [resolved, resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(resolved), curly(nfd)];
  for (const c of candidates) {
    try {
      accessSync(c, constants.F_OK);
      return c;
    } catch {
      // not there: pi tries the next spelling
    }
  }
  return resolved;
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** a glob or pattern that starts outside the root, or climbs out of it */
function globEscapes(g: string): boolean {
  const t = stripAt(g.trim());
  return t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:[\\/]/.test(t) || t.split(/[\\/]/).includes("..");
}

/** why a call is refused, or null when it stays inside `root` */
export function guardReason(toolName: string, input: Record<string, unknown>, root: string | undefined): string | null {
  if (!GUARDED.has(toolName)) return null;
  if (!root) return "読める範囲（lane の worktree）が渡されていないので、読めない";
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return "読める範囲（lane の worktree）を確かめられないので、読めない";
  }
  const given = typeof input.path === "string" && input.path ? asToolReads(input.path) : ".";
  if (given.startsWith("~") || URI_OR_NETWORK.test(given)) return `${given} は worktree の外なので読めない`;
  try {
    // the path as given and the path pi opens (its other spellings) must both land inside the root
    const resolved = resolve(real, given);
    for (const target of new Set([resolved, readTarget(resolved)])) {
      if (!inside(real, landing(target))) return `${given} は worktree の外なので読めない`;
    }
  } catch {
    return `${given} を確かめられないので、読めない`;
  }
  for (const key of toolName === "grep" ? ["glob"] : toolName === "find" ? ["pattern"] : []) {
    const g = input[key];
    if (typeof g === "string" && globEscapes(g)) return `${key} ${g} は worktree の外に出るので使えない`;
  }
  return null;
}

/** the slice of pi's extension API this file uses, declared here so it does not import pi's SDK */
interface PiToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}
export interface PiGuardApi {
  on(event: "tool_call", handler: (event: PiToolCallEvent) => { block: true; reason: string } | undefined): unknown;
}

export default function registerPathGuard(pi: PiGuardApi): void {
  pi.on("tool_call", (event) => {
    const reason = guardReason(event.toolName, event.input ?? {}, process.env[READ_ROOT_ENV]);
    return reason ? { block: true, reason } : undefined;
  });
}
