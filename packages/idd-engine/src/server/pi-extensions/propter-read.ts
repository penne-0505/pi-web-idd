/**
 * The conversation's read-only door onto propter's records. The range is not written here: it is the CLI's one
 * list of reads, imported and consulted before anything runs, so the terminal and the agent read the same
 * commands (C-167-1, C-167-2). A name that is not a read, a writing flag, and a shell character are refused by
 * that same gate; this tool adds no second list and starts no shell, so no other command can be reached.
 *
 * The tool is attached to a chat mode's own conversation and to nothing else: an ephemeral branch (a
 * consultation, a BTW branch) is started without it, and the engine's `--tools` list is what makes it visible.
 */
import { READ_COMMAND_NAMES, readCommandRefusal, runReadCommand, type ReadDeps } from "../../../../idd-cli/src/read-commands.ts";

/** the name pi's `--tools` must carry for the agent to see this tool (DEC-2010) */
export const PROPTER_READ_TOOL_NAME = "propter_read";

/** the slice of pi's registerTool this module uses, declared here so the engine's sources never read pi's SDK */
interface ToolPi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
  }): void;
}

export interface PropterReadResult {
  text: string;
  isError: boolean;
}

/**
 * Run one read from the CLI's list. The command and every argument come from the model, so the refusal gate
 * runs first and nothing is started on a bad call. The answer is the CLI's own point lines, captured rather
 * than printed.
 */
export async function runPropterRead(input: { command?: unknown; args?: unknown }, deps: ReadDeps = {}): Promise<PropterReadResult> {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const args = Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === "string") : [];
  if (!command) {
    return { text: `command を指定してください。読み取り: ${READ_COMMAND_NAMES.join(", ")}`, isError: true };
  }
  const refusal = readCommandRefusal([command, ...args]);
  if (refusal) return { text: refusal, isError: true };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runReadCommand([command, ...args], { ...deps, stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) });
  const text = stdout.join("") || stderr.join("");
  if (code !== 0) return { text: text || `読み取りに失敗しました (${code})`, isError: true };
  return { text: text || "(出力はありません)", isError: false };
}

export default function registerPropterRead(pi: ToolPi): void {
  pi.registerTool({
    name: PROPTER_READ_TOOL_NAME,
    label: "propter の記録を読む",
    description:
      "propter の記録を読む。command は lane の一覧（lanes）・1 本の lane の状態と段（lane IDD-xxx）・card の一覧（cards）・" +
      "台帳（ledger）・land の記録（land）・lane の plan/qa/reference（docs IDD-xxx）・レビューの report（reviews IDD-xxx）のどれか。" +
      "出力は要点の文で、--json を args に足すと元の答えを返す。読み取りだけなので、判断の書き込みはできない。" +
      "判断は人が card で署名する。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: [...READ_COMMAND_NAMES], description: "読み取りの command の名前" },
        args: { type: "array", items: { type: "string" }, description: "command への引数（例: [\"IDD-167\"] や [\"--lane\", \"IDD-167\"]）" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const result = await runPropterRead((params ?? {}) as { command?: unknown; args?: unknown });
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
    },
  });
}
