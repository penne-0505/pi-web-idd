/**
 * The one table of what a lane's agent may hand over at the boundary, and how an argv is read into it.
 *
 * The shim routes a boundary command to `idd hold run`, and the answer comes from here: an operation in the table is
 * taken in hand (nothing is written outside), and anything the table does not name is refused. The table decides
 * from the argv alone, never from what the agent might have meant: a draft the human cannot read from the card is
 * worse than a refusal, because a refusal writes nothing outside.
 */

/** the sentence every taken-in-hand answer carries; an answer that does not take anything in hand never says it */
export const HOLD_SENTENCE = "預かりました。まだ実行していません。人の署名のあと propter が行います";

/** what the status door says to a follow-up check that is not run */
export const WAIT_SENTENCE = "後追いの確認は実行しません。結果は次の巡で届くので、待ってください";

export type HoldPlan =
  | { op: "push" }
  | { op: "pr-create"; title?: string; body?: string; ignored: string[] }
  | { op: "pr-edit"; repo?: string; pr?: string; title?: string; body?: string }
  | { op: "issue-create"; repo?: string; title: string; body: string; labels: string[]; ignored: string[] }
  | { op: "thread-reply"; repo: string; pr: number; commentId: string; body: string }
  | { op: "thread-act"; threadId: string; body?: string; resolve: boolean }
  /** a check that looks at what the hold has not made yet: answered with the wait, not run */
  | { op: "follow-up" }
  /** not the table's to answer: the real command runs (a read) */
  | { op: "pass" }
  | { op: "refuse"; reason: string };

const refuse = (reason: string): HoldPlan => ({ op: "refuse", reason });

interface Args {
  positional: string[];
  /** each flag by its long name, with the values it was given in order; a flag without a value holds "" */
  flags: Map<string, string[]>;
}

/**
 * Read gh's argv. `valued` maps every flag the command takes a value for (long and short) to its long name; any other
 * flag is a switch. `--flag=value` and `--flag value` read the same, a short flag takes the next word.
 */
function readArgs(args: string[], valued: Record<string, string>, switches: Record<string, string> = {}): Args {
  const out: Args = { positional: [], flags: new Map() };
  const put = (name: string, value: string) => out.flags.set(name, [...(out.flags.get(name) ?? []), value]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.positional.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq < 0 ? a : a.slice(0, eq);
      const name = valued[key];
      if (name) {
        if (eq >= 0) put(name, a.slice(eq + 1));
        else if (i + 1 < args.length) put(name, args[++i]);
        else put(name, "");
      } else put(switches[key] ?? key.slice(2), "");
      continue;
    }
    if (a.length > 1 && a.startsWith("-")) {
      const name = valued[a];
      if (name) put(name, i + 1 < args.length ? args[++i] : "");
      else put(switches[a] ?? a.slice(1), "");
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

const one = (a: Args, name: string): string | undefined => a.flags.get(name)?.at(-1);

/** a `--body-file` is read by the caller; `-` means standard input */
export interface BodySource { body?: string; file?: string }

function bodyOf(a: Args): BodySource {
  const body = one(a, "body");
  const file = one(a, "body-file");
  return { ...(body !== undefined ? { body } : {}), ...(file !== undefined ? { file } : {}) };
}

const COMMON_VALUED: Record<string, string> = {
  "--title": "title", "-t": "title",
  "--body": "body", "-b": "body",
  "--body-file": "body-file", "-F": "body-file",
  "--repo": "repo", "-R": "repo",
};

const PR_CREATE_VALUED: Record<string, string> = {
  ...COMMON_VALUED,
  "--base": "base", "-B": "base", "--head": "head", "-H": "head", "--label": "label", "-l": "label",
  "--assignee": "assignee", "-a": "assignee", "--reviewer": "reviewer", "-r": "reviewer",
  "--milestone": "milestone", "-m": "milestone", "--project": "project", "-p": "project", "--template": "template", "-T": "template",
  "--recover": "recover",
};

const ISSUE_CREATE_VALUED: Record<string, string> = {
  ...COMMON_VALUED,
  "--label": "label", "-l": "label", "--assignee": "assignee", "-a": "assignee",
  "--milestone": "milestone", "-m": "milestone", "--project": "project", "-p": "project", "--template": "template", "-T": "template",
  "--recover": "recover",
};

const PR_EDIT_VALUED: Record<string, string> = {
  ...COMMON_VALUED,
  "--base": "base", "-B": "base", "--add-label": "add-label", "--remove-label": "remove-label",
  "--add-assignee": "add-assignee", "--remove-assignee": "remove-assignee", "--add-reviewer": "add-reviewer",
  "--remove-reviewer": "remove-reviewer", "--add-project": "add-project", "--remove-project": "remove-project", "--milestone": "milestone", "-m": "milestone",
};

/** a flag the hold does not carry: said back, so the agent does not think it was handed over */
function leftOver(a: Args, taken: string[]): string[] {
  return [...a.flags.keys()].filter((k) => !taken.includes(k)).map((k) => `--${k}`);
}

/** the pushes the harness does not make for a lane: whatever is not "this lane's branch, as it is" */
const PUSH_REFUSED = /^(--force|-f|--force-with-lease(=.*)?|--force-if-includes|--delete|-d|--mirror|--prune|--tags|--follow-tags|--all|--branches)$/;

/** the options of `git push` that take the next word as their value: that word is not an option of the push */
const PUSH_VALUED = /^(-o|--push-option|--receive-pack|--exec|--repo)$/;

/** git takes a long option by any unambiguous start of it; `min` is the shortest start that is only this option */
const isLong = (word: string, name: string, min: number): boolean => word.length >= min && `--${name}`.startsWith(word);

/**
 * A push that writes nothing: help, or a dry run that is not undone by a later `--no-dry-run`. The real git answers it,
 * so an agent that checks where a push would go is not turned into a request that a person is later asked to sign.
 */
function pushWritesNothing(rest: string[]): boolean {
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") break;
    if (PUSH_VALUED.test(a)) { i++; continue; }
    if (a === "-h" || isLong(a, "help", 3)) return true;
    if (isLong(a, "no-dry-run", 7)) dry = false;
    else if (isLong(a, "dry-run", 4)) dry = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      // a cluster of short options: `-o` takes the rest of the word as its value
      for (const ch of a.slice(1)) {
        if (ch === "o") break;
        if (ch === "n") dry = true;
      }
    }
  }
  return dry;
}

function planGit(args: string[]): HoldPlan {
  // the subcommand is the first word that is not an option or an option's value
  let sub = "";
  let rest: string[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i++; continue; }
    if (a === "-h" || a === "--help") help = true;
    if (a.startsWith("-")) continue;
    sub = a;
    rest = args.slice(i + 1);
    break;
  }
  if (sub !== "push" || help || pushWritesNothing(rest)) return { op: "pass" };
  for (const a of rest) {
    if (PUSH_REFUSED.test(a)) return refuse(`git push ${a} は預かれません。push は、lane の branch をそのまま出す 1 回だけを預かります`);
    if (!a.startsWith("-") && (a.startsWith("+") || a.includes(":"))) return refuse(`git push ${a} は預かれません。push は、lane の branch をそのまま出す 1 回だけを預かります`);
  }
  return { op: "push" };
}

const REPO_PATH = /^\/?repos\/([\w.-]+\/[\w.-]+)(\/.*)?$/;

/**
 * the `gh api` shapes in the table; each is a write shape, so a flag that makes it one has to be there.
 * `-F` is a typed field and `-f` a raw one: the value of a typed field that starts with `@` is a file (`@-` is standard
 * input) and gh sends what is in it, so that is what the card holds; a raw field is the text as it was typed.
 */
function planApi(args: string[], readFile: (path: string) => string): HoldPlan {
  const valued = { "--method": "method", "-X": "method", "--field": "typed", "-F": "typed", "--raw-field": "field", "-f": "field", "--input": "input", "--header": "header", "-H": "header", "--jq": "jq", "-q": "jq", "--template": "template", "-t": "template", "--hostname": "hostname", "--cache": "cache", "--preview": "preview", "-p": "preview" };
  const a = readArgs(args, valued);
  const endpoint = a.positional[0];
  const method = (one(a, "method") ?? ((a.flags.has("field") || a.flags.has("typed") || a.flags.has("input")) ? "POST" : "GET")).toUpperCase();
  if (!endpoint || method === "GET" || a.flags.has("input")) return refuse("gh api の書き込みは、表にある形だけを預かります");
  const pairs: [string, string][] = [];
  for (const [flag, typed] of [["field", false], ["typed", true]] as const) {
    for (const f of a.flags.get(flag) ?? []) {
      const eq = f.indexOf("=");
      if (eq <= 0) continue;
      const key = f.slice(0, eq);
      const value = f.slice(eq + 1);
      if (!typed || !value.startsWith("@")) { pairs.push([key, value]); continue; }
      // a file that cannot be read is refused: the path as text would be signed as if it were what the file says
      try { pairs.push([key, readFile(value.slice(1))]); } catch (e) { return refuse(`-F ${key}=${value} のファイルを読めません: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  const fields = new Map<string, string>(pairs);
  // a field the shape does not carry is said back, so the agent does not think the whole request was handed over
  const notCarried = (carried: string[]) => [...fields.keys()].filter((k) => !carried.includes(k));
  const path = endpoint.replace(/^\/+/, "");
  if (path === "graphql") return planGraphql(fields);
  const m = REPO_PATH.exec(`/${path}`);
  if (!m) return refuse("gh api の書き込みは、表にある形だけを預かります");
  const [, repo, tail = ""] = m;
  const reply = /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(tail);
  if (reply && method === "POST") {
    const body = fields.get("body");
    const other = notCarried(["body"]);
    if (other.length) return refuse(`返信は本文だけを預かります（${other.join(", ")} は預かれません）`);
    return body?.trim() ? { op: "thread-reply", repo, pr: Number(reply[1]), commentId: reply[2], body } : refuse("返信の本文（-f body=...）が要ります");
  }
  if (tail === "/issues" && method === "POST") {
    const title = fields.get("title");
    if (!title?.trim()) return refuse("起票の題名（-f title=...）が要ります");
    const labels = pairs.filter(([k]) => k === "labels[]" || k === "labels").map(([, v]) => v).filter(Boolean);
    return { op: "issue-create", repo, title, body: fields.get("body") ?? "", labels, ignored: notCarried(["title", "body", "labels", "labels[]"]) };
  }
  if (tail === "/pulls" && method === "POST") {
    const title = fields.get("title");
    return title?.trim() ? { op: "pr-create", title, body: fields.get("body") ?? "", ignored: notCarried(["title", "body"]) } : refuse("PR の題名（-f title=...）が要ります");
  }
  const edit = /^\/pulls\/(\d+)$/.exec(tail);
  if (edit && (method === "PATCH" || method === "PUT")) {
    const title = fields.get("title");
    const body = fields.get("body");
    const other = [...fields.keys()].filter((k) => k !== "title" && k !== "body");
    if (other.length) return refuse(`PR の更新は題名と本文だけを預かります（${other.join(", ")} は預かれません）`);
    return title === undefined && body === undefined ? refuse("PR の更新は題名か本文が要ります") : { op: "pr-edit", repo, pr: edit[1], ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
  }
  return refuse("gh api の書き込みは、表にある形だけを預かります");
}

/** unescape the literal a GraphQL string holds */
function gqlString(raw: string): string {
  return raw.replace(/\\(["\\nrt])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[c] ?? c);
}

function planGraphql(fields: Map<string, string>): HoldPlan {
  const query = fields.get("query") ?? "";
  if (!/\bmutation\b/.test(query)) return refuse("gh api graphql の書き込みは、スレッドへの返信と解決だけを預かります");
  const resolves = /\bresolveReviewThread\b/.test(query);
  const replies = /\baddPullRequestReviewThreadReply\b/.test(query);
  if (resolves === replies) return refuse("gh api graphql の書き込みは、スレッドへの返信と解決だけを預かります");
  const literal = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(query);
    return m ? gqlString(m[1]) : undefined;
  };
  // a review thread's id is a GitHub node id that starts with PRRT_, under whatever name the query gives its variable
  const threadField = [...fields].find(([k, v]) => k !== "query" && /^PRRT_/.test(v))?.[0];
  const threadId = (threadField ? fields.get(threadField) : undefined) ?? literal("threadId") ?? literal("pullRequestReviewThreadId");
  if (!threadId) return refuse("スレッドの id が読めません（PRRT_ で始まる id を -f か -F で渡すか、query に書いてください）");
  if (resolves) return { op: "thread-act", threadId, resolve: true };
  // the reply's text is the field called body, or else the one field left once the query and the thread are taken out
  const rest = [...fields].filter(([k]) => k !== "query" && k !== threadField);
  const body = fields.get("body") ?? (rest.length === 1 ? rest[0][1] : undefined) ?? literal("body");
  return body?.trim() ? { op: "thread-act", threadId, body, resolve: false } : refuse("返信の本文が読めません（body を -f で渡してください）");
}

/** what `gh run` and `gh pr checks` look at: the run of a check that the harness, not the agent, waits for */
const FOLLOW_UP = (args: string[]): boolean => {
  const [a, b] = args;
  return (a === "pr" && (b === "checks" || b === "status")) || (a === "run" && (b === "list" || b === "view" || b === "watch"));
};

/**
 * Read one boundary command into the table's answer. `tool` is the command the shim stood in for; `args` are the
 * words after it. Pure: it reads nothing and runs nothing, so every shape the table has is tested from the argv.
 */
export function planHold(tool: "gh" | "git", args: string[], readFile: (path: string) => string = () => { throw new Error("no reader"); }): HoldPlan {
  if (tool === "git") return planGit(args);
  if (FOLLOW_UP(args)) return { op: "follow-up" };
  const [group, verb] = args;
  const tail = args.slice(2);
  const withFile = (b: BodySource): { body?: string } | { error: string } => {
    if (b.file === undefined) return b.body !== undefined ? { body: b.body } : {};
    try { return { body: readFile(b.file) }; } catch (e) { return { error: `--body-file を読めません: ${e instanceof Error ? e.message : String(e)}` }; }
  };
  if (group === "api") return planApi(args.slice(1), readFile);
  if (group === "pr" && verb === "create") {
    const a = readArgs(tail, PR_CREATE_VALUED);
    const read = withFile(bodyOf(a));
    if ("error" in read) return refuse(read.error);
    const title = one(a, "title");
    if (title === undefined && read.body !== undefined) return refuse("gh pr create の本文は、題名（--title）と一緒に渡してください");
    return { op: "pr-create", ...(title !== undefined ? { title } : {}), ...(read.body !== undefined ? { body: read.body } : {}), ignored: leftOver(a, ["title", "body", "body-file"]) };
  }
  if (group === "pr" && verb === "edit") {
    const a = readArgs(tail, PR_EDIT_VALUED);
    const extra = leftOver(a, ["title", "body", "body-file", "repo"]);
    if (extra.length) return refuse(`gh pr edit は題名と本文だけを預かります（${extra.join(" ")} は預かれません）`);
    const read = withFile(bodyOf(a));
    if ("error" in read) return refuse(read.error);
    const title = one(a, "title");
    if (title === undefined && read.body === undefined) return refuse("gh pr edit は題名か本文が要ります");
    return { op: "pr-edit", ...(one(a, "repo") ? { repo: one(a, "repo") } : {}), ...(a.positional[0] ? { pr: a.positional[0] } : {}), ...(title !== undefined ? { title } : {}), ...(read.body !== undefined ? { body: read.body } : {}) };
  }
  if (group === "issue" && verb === "create") {
    const a = readArgs(tail, ISSUE_CREATE_VALUED);
    const read = withFile(bodyOf(a));
    if ("error" in read) return refuse(read.error);
    const title = one(a, "title");
    if (!title?.trim()) return refuse("gh issue create の題名（--title）が要ります");
    const labels = (a.flags.get("label") ?? []).flatMap((l) => l.split(",")).map((l) => l.trim()).filter(Boolean);
    return { op: "issue-create", ...(one(a, "repo") ? { repo: one(a, "repo") } : {}), title, body: read.body ?? "", labels, ignored: leftOver(a, ["title", "body", "body-file", "repo", "label"]) };
  }
  return refuse("この操作は表にありません");
}

/** the commands the shim routes here: every operation the table can take in hand, as the words after the tool */
export const ROUTED: readonly { tool: "gh" | "git"; words: string[] }[] = [
  { tool: "git", words: ["push"] },
  { tool: "gh", words: ["pr", "create"] },
  { tool: "gh", words: ["pr", "edit"] },
  { tool: "gh", words: ["issue", "create"] },
  { tool: "gh", words: ["api"] },
  { tool: "gh", words: ["pr", "checks"] },
  { tool: "gh", words: ["pr", "status"] },
  { tool: "gh", words: ["run", "list"] },
  { tool: "gh", words: ["run", "view"] },
  { tool: "gh", words: ["run", "watch"] },
];
