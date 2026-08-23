// Agent lifecycle hook: Tier 2 の optional amplifier。規範は Tier 0 (AGENTS.md /
// _docs/standards/)、機械強制は Tier 1 (validator) にあり、この hook は想起と
// 安全ブロックの増幅のみを行う。docs を自動更新せず、Risk を確定しない。

const HOOK_EVENT_NAMES = new Set([
  "SessionStart",
  "Stop",
  "PreToolUse",
]);

type HookEventName =
  | "SessionStart"
  | "Stop"
  | "PreToolUse";

type ToolInput = {
  file_path?: unknown;
  path?: unknown;
  target_file?: unknown;
  command?: unknown;
  cmd?: unknown;
  [key: string]: unknown;
};

type HookInput = {
  hook_event_name?: unknown;
  hookEventName?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
  tool_input?: ToolInput;
  toolInput?: ToolInput;
  stop_hook_active?: unknown;
  [key: string]: unknown;
};

export type HookDecision =
  | { decision: "block"; reason: string }
  | { decision: "context"; context: string };

const SESSION_CONTEXT = [
  "Intent-driven workflow reminder:",
  "- Read AGENTS.md, TODO.md, and _docs/standards/workflow.md before implementation.",
  "- Every change runs the loop: TODO (AC) -> implement -> Intent Delta -> QA round. Only depth varies; presence does not.",
  "- Code comments are pointer-only (`// intent: DEC-xxx — <reason>`). Prose belongs in a DEC or nowhere.",
  "- Skills are not automatic: prep before work, close after work, docs-inventory for triage, docs-template-migration for template updates.",
  "- Hooks are optional amplifiers. The norms hold with or without them.",
].join("\n");

// 一度終えることを促し、勝手な監査列挙を防ぐ。強制はしない。
const STOP_REMINDER = [
  "ドキュメントは実態に追いついていますか？（Intent への記録・QA round・教訓候補の提示 — close skill の管轄）",
  "対応済み・該当なしなら、この通知は無視して終了してください。",
  "未対応があっても今は作業を始めないでください。一言だけ現状を伝え、本筋の次の指示が来たら close で処理してください。",
].join("\n");

const normalizePath = (path: unknown): string => {
  const segments: string[] = [];
  for (const segment of String(path ?? "").replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
};

const unique = (
  items: string[],
): string[] => [...new Set(items.filter(Boolean))];

export const parsePorcelainPaths = (statusOutput: unknown): string[] => {
  const paths: string[] = [];
  for (const rawLine of String(statusOutput ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const body = line.slice(3).trim();
    if (body.includes(" -> ")) {
      const [from, to] = body.split(" -> ").map((value) =>
        value.replace(/^"|"$/g, "")
      );
      paths.push(normalizePath(from), normalizePath(to));
    } else {
      paths.push(normalizePath(body.replace(/^"|"$/g, "")));
    }
  }
  return unique(paths);
};

const pathFromToolInput = (toolInput: ToolInput | null | undefined): string => {
  if (!toolInput || typeof toolInput !== "object") return "";
  return normalizePath(
    toolInput.file_path ?? toolInput.path ?? toolInput.target_file ?? "",
  );
};

export const isWorkflowSensitivePath = (path: unknown): boolean => {
  const normalized = normalizePath(path);
  return normalized === "AGENTS.md" ||
    normalized === "CLAUDE.md" ||
    normalized.startsWith(".codex/") ||
    normalized.startsWith(".claude/") ||
    normalized.startsWith(".agents/") ||
    normalized.startsWith(".github/") ||
    normalized.startsWith("_docs/standards/") ||
    normalized.startsWith("scripts/");
};

const commandFromToolInput = (
  toolInput: ToolInput | null | undefined,
): string => {
  if (!toolInput || typeof toolInput !== "object") return "";
  return String(toolInput.command ?? toolInput.cmd ?? "");
};

// .env.example は security 標準が参照を指示するファイルであり、対象から除く。
const includesSensitivePath = (value: unknown): boolean =>
  /(^|[\/\s'"`])(\.env(?!\.example)(\.|$|[\/\s'"`])|id_rsa\b|id_ed25519\b|\.pem\b|\.key\b)/i
    .test(String(value ?? ""));

const protectedArchiveMove = (command: string): boolean =>
  /\b(git\s+)?mv\b[\s\S]*_docs\/(intent|qa|guide|reference)\b[\s\S]*_docs\/archives\b/i
    .test(command) ||
  /\b(git\s+)?mv\b[\s\S]*_docs\/archives\/(intent|qa|guide|reference)\b/i
    .test(command);

const DELETION_WHY =
  "Why: permanent deletion is user-gated in this template — the intent-driven loop depends on an intact audit trail, and an agent cannot judge alone that history is safe to destroy. Next action: propose the deletion to the user and wait; for completed plans use `git mv` into _docs/archives/plan/.";

const destructiveCommandReason = (command: unknown): string | null => {
  const text = String(command ?? "");
  const checks: Array<{ re: RegExp; label: string }> = [
    { re: /(^|[;&|()\s])git\s+rm(\s|$)/, label: "git rm" },
    { re: /(^|[;&|()\s])(\/(usr\/)?bin\/)?rm\s+(-[^\s]+\s+)?/, label: "rm" },
    { re: /(^|[;&|()\s])command\s+rm(\s|$)/, label: "command rm" },
    { re: /(^|[;&|()\s])xargs\s+(-[^\s]+\s+)*rm(\s|$)/, label: "xargs rm" },
    { re: /(^|[;&|()\s])find\b[\s\S]*\s-delete(\s|$)/, label: "find -delete" },
    { re: /(^|[;&|()\s])shred(\s|$)/, label: "shred" },
    { re: /(^|[;&|()\s])unlink(\s|$)/, label: "unlink" },
    {
      re: /(^|[;&|()\s])git\s+reset\s+--hard(\s|$)/,
      label: "git reset --hard",
    },
    { re: /(^|[;&|()\s])git\s+clean(\s|$)/, label: "git clean" },
    { re: /(^|[;&|()\s])git\s+checkout\s+--(\s|$)/, label: "git checkout --" },
  ];
  for (const check of checks) {
    if (check.re.test(text)) {
      return `${check.label} is blocked because it can permanently destroy files or discard work. ${DELETION_WHY}`;
    }
  }
  if (protectedArchiveMove(text)) {
    return "Moving intent, QA, guide, or reference docs into archives is blocked. Why: these are permanent records the loop reads; only completed plans are archived. Next action: mark obsolete docs with status: superseded / obsolete instead.";
  }
  if (
    includesSensitivePath(text) &&
    /\b(cat|less|more|sed|awk|rg|grep|python|node|deno|cp|mv)\b/.test(text)
  ) {
    return "This command appears to touch credential-like files. Why: secrets must never enter agent context or the repo. Next action: use .env.example or a documented non-secret placeholder.";
  }
  return null;
};

const patchDeletionReason = (command: string): string | null => {
  if (!/\*\*\* Delete File:/.test(command)) return null;
  return `File deletion through apply_patch is blocked. ${DELETION_WHY}`;
};

export const analyzePreToolUse = (
  input: HookInput | null | undefined,
): HookDecision | null => {
  const toolName = String(input?.tool_name ?? input?.toolName ?? "");
  const toolInput = input?.tool_input ?? input?.toolInput ?? {};
  const command = commandFromToolInput(toolInput);
  const filePath = pathFromToolInput(toolInput);

  if (/bash|shell/i.test(toolName)) {
    const reason = destructiveCommandReason(command);
    if (reason) return { decision: "block", reason };
  }

  if (/apply_patch|edit|write|multiedit/i.test(toolName)) {
    const reason = patchDeletionReason(command);
    if (reason) return { decision: "block", reason };
    if (includesSensitivePath(filePath)) {
      return {
        decision: "block",
        reason:
          "Edits to credential-like files are blocked. Why: secrets must never enter the repo or agent context. Next action: use .env.example or a documented non-secret placeholder.",
      };
    }
  }

  return null;
};

type StopPathGroups = {
  relevant: string[];
};

const relevantStopPaths = (paths: string[]): StopPathGroups => {
  const normalized = unique(paths.map(normalizePath));
  return {
    relevant: normalized.filter((path) =>
      path === "TODO.md" ||
      path.startsWith("_docs/") ||
      isWorkflowSensitivePath(path) ||
      /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|sql|css|scss|vue|svelte)$/
        .test(path)
    ),
  };
};

export const analyzeStop = (
  { input = {}, dirtyPaths = [] }: {
    input?: HookInput;
    dirtyPaths?: string[];
  },
): HookDecision | null => {
  if (input.stop_hook_active === true) return null;
  const grouped = relevantStopPaths(dirtyPaths);
  if (grouped.relevant.length === 0) return null;
  return { decision: "block", reason: STOP_REMINDER };
};

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(8192);
  while (true) {
    const n = await Deno.stdin.read(buffer);
    if (n === null) break;
    chunks.push(buffer.slice(0, n));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
};

const parseHookInput = (raw: string): HookInput => {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
};

const runGitStatus = async (): Promise<string[]> => {
  let env: Record<string, string>;
  try {
    env = { ...Deno.env.toObject() };
  } catch (err) {
    throw new Error(
      `Stop hook requires --allow-env to sanitize git subprocess env (need --allow-read --allow-env --allow-run=git): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args: ["status", "--short"],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env,
    }).output();
  } catch (err) {
    throw new Error(
      `Stop hook could not run git status (need --allow-run=git): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!output.success) return [];
  return parsePorcelainPaths(new TextDecoder().decode(output.stdout));
};

const jsonOut = (value: unknown): void => {
  console.log(JSON.stringify(value));
};

const blockOut = (eventName: string, reason: string): void => {
  if (eventName === "PreToolUse") {
    jsonOut({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    return;
  }
  jsonOut({ decision: "block", reason });
};

const sessionStartOut = (): void => {
  jsonOut({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: SESSION_CONTEXT,
    },
  });
};

const inferEventName = (arg: string | undefined, input: HookInput): string => {
  const fromInput = input.hook_event_name ?? input.hookEventName;
  if (typeof fromInput === "string" && HOOK_EVENT_NAMES.has(fromInput)) {
    return fromInput as HookEventName;
  }
  if (arg === "session-start") return "SessionStart";
  if (arg === "stop") return "Stop";
  if (arg === "pre-tool-use") return "PreToolUse";
  return String(fromInput ?? arg ?? "");
};

const main = async (): Promise<void> => {
  const raw = await readStdin();
  const input = parseHookInput(raw);
  const eventName = inferEventName(Deno.args[0], input);

  if (eventName === "SessionStart") {
    sessionStartOut();
    return;
  }

  if (eventName === "PreToolUse") {
    const result = analyzePreToolUse(input);
    if (result?.decision === "block") blockOut("PreToolUse", result.reason);
    return;
  }

  if (eventName === "Stop") {
    const dirtyPaths = await runGitStatus();
    const result = analyzeStop({ input, dirtyPaths });
    if (result?.decision === "block") blockOut("Stop", result.reason);
  }
};

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(
      `agent-workflow-hook failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    Deno.exit(1);
  });
}
