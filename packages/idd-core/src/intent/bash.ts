/**
 * The file paths a Bash command line opens and the paths it writes, read from the command text alone. Bash is
 * the one path into a file that the Read and Edit hooks never see, so a Choice's why would otherwise never reach
 * an agent that reads and writes through a shell. This reads the command; it never runs it, and it holds no rule
 * about which paths matter — the verb decides that from the record and the repo root.
 *
 * A path it cannot pin down is left out rather than guessed (a variable, a glob, a command substitution, a `cd`
 * to a place that is itself undecidable). Getting it wrong here would either inject into the wrong file or, worse,
 * block a write outside the tree, so the miss is the safer side. Nothing here throws: any shape it does not
 * understand comes back as "nothing found".
 *
 * Paths come back as written, with a `cd` already applied: relative to the command's own working directory, or
 * absolute. The verb resolves them against the repo root.
 */

import { posix } from "node:path";

export interface BashPaths {
  reads: string[];
  writes: string[];
  /**
   * The directory the last `cd` moved to, relative to the command's starting cwd (or absolute). Every path is
   * relative to that starting cwd, so a caller that only knows where the command ended can step back to where it
   * began by removing this much. Empty when the command never moved, null when a `cd` could not be pinned down.
   */
  base: string | null;
}

/** commands that open exactly the files they name */
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "nl", "bat"]);

/** words carrying these cannot be pinned to one path: a variable, a substitution, a glob, or a home shortcut */
const UNDETERMINABLE = /[$`*?[\]{}~]/;

/** the operators that separate one command from the next */
const SEPARATORS = new Set(["|", "||", "&&", ";", "&", "\n", "(", ")"]);

/** redirects that write their target */
const WRITE_REDIRECTS = new Set([">", ">>", "&>", "&>>"]);

interface Token {
  value: string;
  quoted: boolean;
  op: boolean;
}

function op(value: string): Token {
  return { value, quoted: false, op: true };
}

/** split a line of shell into words and operators, keeping quoted text together and marking what was quoted */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      if (c === "\n") tokens.push(op("\n"));
      i += 1;
      continue;
    }
    if (c === "&" && text[i + 1] === "&") { tokens.push(op("&&")); i += 2; continue; }
    if (c === "|" && text[i + 1] === "|") { tokens.push(op("||")); i += 2; continue; }
    if (c === "&" && text[i + 1] === ">") {
      if (text[i + 2] === ">") { tokens.push(op("&>>")); i += 3; } else { tokens.push(op("&>")); i += 2; }
      continue;
    }
    // `>&1` / `2>&1`: the `&N` belongs to the redirect just before it, not to a background command
    if (c === "&" && i > 0 && text[i - 1] === ">") {
      let value = "&";
      i += 1;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") { value += text[i]; i += 1; }
      tokens.push({ value, quoted: false, op: false });
      continue;
    }
    if (c === "|" || c === ";" || c === "&") { tokens.push(op(c)); i += 1; continue; }
    if (c === ">") {
      if (text[i + 1] === ">") { tokens.push(op(">>")); i += 2; } else { tokens.push(op(">")); i += 1; }
      continue;
    }
    if (c === "<") {
      if (text[i + 1] === "<") {
        if (text[i + 2] === "<") { tokens.push(op("<<<")); i += 3; }
        else if (text[i + 2] === "-") { tokens.push(op("<<-")); i += 3; }
        else { tokens.push(op("<<")); i += 2; }
      } else { tokens.push(op("<")); i += 1; }
      continue;
    }
    if (c === "(" || c === ")") { tokens.push(op(c)); i += 1; continue; }

    let value = "";
    let quoted = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") break;
      if (ch === "|" || ch === ";" || ch === "&" || ch === "<" || ch === ">" || ch === "(" || ch === ")") break;
      if (ch === "'") {
        quoted = true;
        i += 1;
        while (i < text.length && text[i] !== "'") { value += text[i]; i += 1; }
        i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i += 1;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\" || text[i + 1] === "$" || text[i + 1] === "`")) {
            value += text[i + 1];
            i += 2;
            continue;
          }
          value += text[i];
          i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === "\\") {
        quoted = true;
        if (i + 1 < text.length) { value += text[i + 1]; i += 2; } else { i += 1; }
        continue;
      }
      value += ch;
      i += 1;
    }
    tokens.push({ value, quoted, op: false });
  }
  return tokens;
}

/** the delimiters a line opens with `<<` / `<<-`, in the order their bodies follow the line */
function heredocDelimiters(line: string): string[] {
  const tokens = tokenize(line);
  const delims: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].op && (tokens[i].value === "<<" || tokens[i].value === "<<-")) {
      const next = tokens[i + 1];
      if (next && !next.op && next.value) delims.push(next.value);
      i += 1;
    }
  }
  return delims;
}

function undeterminable(word: string): boolean {
  return !word || word === "-" || UNDETERMINABLE.test(word);
}

function isAbsolute(word: string): boolean {
  return word.startsWith("/");
}

/** a word turned into a path relative to the command's own cwd, or null when it cannot be pinned down */
function resolveWord(base: string | null, word: string): string | null {
  if (undeterminable(word)) return null;
  if (isAbsolute(word)) return word;
  if (base === null) return null;
  return posix.join(base, word);
}

function commandName(word: string): string {
  return word.split("/").pop() ?? word;
}

/** the arguments a segment names, with each redirect and heredoc target taken out of the plain words */
function argsOf(tokens: Token[]): { args: Token[]; hasHeredoc: boolean } {
  const args: Token[] = [];
  let hasHeredoc = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.op) {
      args.push(t);
      continue;
    }
    if (WRITE_REDIRECTS.has(t.value)) {
      // `2>` leaves its file descriptor as a plain word just before the operator: it is not an argument
      const before = i > 0 ? tokens[i - 1] : undefined;
      if (before && !before.op && /^\d+$/.test(before.value) && args.length && args[args.length - 1].value === before.value) args.pop();
      const next = tokens[i + 1];
      if (next && !next.op) i += 1;
      continue;
    }
    if (t.value === "<<" || t.value === "<<-") {
      hasHeredoc = true;
      if (tokens[i + 1] && !tokens[i + 1].op) i += 1;
      continue;
    }
    if (t.value === "<" || t.value === "<<<") {
      if (tokens[i + 1] && !tokens[i + 1].op) i += 1;
      continue;
    }
  }
  return { args, hasHeredoc };
}

/** the write targets a segment names through redirects, in order */
function redirectWrites(tokens: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.op || !WRITE_REDIRECTS.has(t.value)) continue;
    const next = tokens[i + 1];
    if (!next || next.op) continue;
    i += 1;
    // `&1` / `&2`: a file descriptor, not a file
    if (next.value.startsWith("&")) continue;
    out.push(next.value);
  }
  return out;
}

/** the paths and write/read split of a `sed` argument list */
function sedOf(args: Token[]): { inPlace: boolean; paths: string[] } {
  let inPlace = false;
  let scriptSeen = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i].value;
    if (t.startsWith("--in-place")) { inPlace = true; continue; }
    if (t.startsWith("-i")) { inPlace = true; continue; }
    if (t.startsWith("-e") || t === "--expression") { i += 1; scriptSeen = true; continue; }
    if (t.startsWith("-f") || t === "--file") { i += 1; scriptSeen = true; continue; }
    if (t.startsWith("-") && t !== "-") continue;
    if (!scriptSeen) { scriptSeen = true; continue; }
    paths.push(t);
  }
  return { inPlace, paths };
}

/** the `open(...)` calls in Python source: the path and whether the mode writes */
function pythonOpens(code: string): { path: string; write: boolean }[] {
  const out: { path: string; write: boolean }[] = [];
  const re = /\bopen\s*\(\s*(['"])([^'"]*)\1\s*(?:,\s*(['"])([^'"]*)\3\s*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const path = m[2];
    const mode = m[4] ?? "";
    if (!path) continue;
    out.push({ path, write: /^[wax]/.test(mode) });
  }
  return out;
}

function isPython(name: string): boolean {
  return name === "python" || name.startsWith("python");
}

/**
 * The read and write paths of one command line. The base starts at `cwd` (the empty relative path) and follows
 * `cd`; once a `cd` cannot be pinned down, relative paths after it are skipped until the next `cd`.
 */
export function parseBashCommand(command: string): BashPaths {
  const reads: string[] = [];
  const writes: string[] = [];
  if (typeof command !== "string" || !command.trim()) return { reads, writes, base: "" };

  const lines = command.split("\n");
  const cleaned: string[] = [];
  const bodiesByLine: string[][] = [];
  let li = 0;
  while (li < lines.length) {
    const line = lines[li];
    li += 1;
    cleaned.push(line);
    bodiesByLine.push([]);
    const owner = cleaned.length - 1;
    for (const delim of heredocDelimiters(line)) {
      const body: string[] = [];
      while (li < lines.length && lines[li] !== delim) { body.push(lines[li]); li += 1; }
      if (li < lines.length) li += 1;
      bodiesByLine[owner].push(body.join("\n"));
    }
  }

  let base: string | null = "";
  if (!quotesBalanced(cleaned.join("\n"))) return { reads, writes, base: "" };
  for (let l = 0; l < cleaned.length; l += 1) {
    const tokens = tokenize(cleaned[l]);
    const bodies = bodiesByLine[l] ?? [];
    let segment: Token[] = [];
    const flush = (): void => {
      if (segment.length) base = handleSegment(segment, base, reads, writes, bodies);
      segment = [];
    };
    for (const t of tokens) {
      if (t.op && SEPARATORS.has(t.value)) flush();
      else segment.push(t);
    }
    flush();
  }
  return { reads, writes, base: base };
}

/**
 * Whether every quote the command opens is closed. An unbalanced command is one the shell itself would reject,
 * so nothing is read from it: a half-quoted word is as likely to be a fragment as a path.
 */
function quotesBalanced(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      i += 1;
      while (i < text.length && text[i] !== "'") i += 1;
      if (i >= text.length) return false;
      i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      if (i >= text.length) return false;
      i += 1;
      continue;
    }
    i += 1;
  }
  return true;
}

function handleSegment(tokens: Token[], base: string | null, reads: string[], writes: string[], bodies: string[]): string | null {
  for (const target of redirectWrites(tokens)) {
    const p = resolveWord(base, target);
    if (p) writes.push(p);
  }
  const { args, hasHeredoc } = argsOf(tokens);
  // an environment assignment before the command is not the command
  let at = 0;
  while (at < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[at].value)) at += 1;
  const name = args[at] ? commandName(args[at].value) : "";
  const rest = args.slice(at + 1);

  if (name === "cd") {
    const target = rest[0]?.value;
    if (target === undefined || target === "-") return null;
    if (undeterminable(target)) return null;
    if (isAbsolute(target)) return target;
    if (base === null) return null;
    return posix.join(base, target);
  }

  if (READ_COMMANDS.has(name)) {
    const paths = name === "head" || name === "tail" ? headTailArgs(rest) : plainPaths(rest);
    for (const p of paths) {
      const resolved = resolveWord(base, p);
      if (resolved) reads.push(resolved);
    }
    return base;
  }

  if (name === "sed") {
    const sed = sedOf(rest);
    for (const p of sed.paths) {
      const resolved = resolveWord(base, p);
      if (!resolved) continue;
      if (sed.inPlace) writes.push(resolved);
      else reads.push(resolved);
    }
    return base;
  }

  if (isPython(name)) {
    const code: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i].value === "-c" && rest[i + 1]) { code.push(rest[i + 1].value); i += 1; }
    }
    if (hasHeredoc) code.push(...bodies);
    for (const source of code) {
      for (const call of pythonOpens(source)) {
        const resolved = resolveWord(base, call.path);
        if (!resolved) continue;
        if (call.write) writes.push(resolved);
        else reads.push(resolved);
      }
    }
    return base;
  }

  if (name === "tee") {
    for (const p of plainPaths(rest)) {
      const resolved = resolveWord(base, p);
      if (resolved) writes.push(resolved);
    }
    return base;
  }

  return base;
}

/** the non-option words of an argument list */
function plainPaths(args: Token[]): string[] {
  return args.filter((t) => !t.value.startsWith("-") || t.value === "-").map((t) => t.value);
}

/** head and tail take a count after `-n` / `-c`, so those values are not file names */
function headTailArgs(args: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i].value;
    if (v === "-n" || v === "-c" || v === "--lines" || v === "--bytes") { i += 1; continue; }
    if (v.startsWith("-") && v !== "-") continue;
    out.push(v);
  }
  return out;
}
