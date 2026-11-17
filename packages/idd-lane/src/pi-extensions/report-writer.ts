import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pi side of the deliverable. A role whose tools hold neither `write` nor `bash` cannot leave the run's
 * `report.md` and `report.json`; the tool this file registers writes exactly those two files, and nothing else.
 *
 * The write target is not a tool argument: it is the path the harness puts in `REPORT_PATH_ENV` for the run. So
 * the agent has no way to name another file, and the run cannot touch the lane's worktree. Both files
 * are written in one call, and a call whose JSON does not parse writes nothing and comes back with the reason,
 * so the agent can fix it in the same session.
 *
 * Whether a run gets this tool is read from the role's own tools (`needsReportTool`), never from its name or the
 * stage: a role that already has a writing tool writes the two files itself and its tool list is unchanged.
 * The pi harness is the only one that can load this extension, so a Claude Code role of the same shape
 * is refused before it starts (`assertReportWriter`).
 */

/** the env var the harness sets for a run that gets the tool: the report path, without extension */
export const REPORT_PATH_ENV = "IDD_LANE_REPORT";

/** the tool's name; the harness also adds it to the run's `--tools` allow-list */
export const REPORT_TOOL_NAME = "write_report";

/** the pi tools that let a role write the run's two files without this extension */
const WRITING_TOOLS = new Set(["write", "bash"]);

/** enough of a role to decide the tool's need: its name, harness and tool list */
export interface DeliverableRole {
  name: string;
  harness: string;
  tools: readonly string[];
}

/** whether a role needs the deliverable tool: it has neither of the tools that write the files */
export function needsReportTool(role: Pick<DeliverableRole, "tools">): boolean {
  return !role.tools.some((t) => WRITING_TOOLS.has(t));
}

/** the env a run that gets the tool carries: only those runs carry the report path */
export function reportEnv(role: Pick<DeliverableRole, "tools">, report: string): Record<string, string> {
  return needsReportTool(role) ? { [REPORT_PATH_ENV]: report } : {};
}

/** the report path this run writes, or null when the harness handed none */
export function reportPathOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = env[REPORT_PATH_ENV];
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/**
 * A Claude Code role cannot be given the pi extension, so a role of this shape is refused before its run starts.
 * Running it would spend the whole budget and end with no deliverable, and the fix-planner's failure is noted but
 * never raises a card.
 */
export function assertReportWriter(role: DeliverableRole): void {
  if (role.harness === "claude" && needsReportTool(role)) {
    throw new Error(`role "${role.name}" は write も bash も持たないので、成果物（report.md と report.json）を書けません。tools に write か bash を足すか、harness: pi にしてください`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** the extension's own path, named on top of pi's disabled extension discovery */
export function reportWriterExtensionPath(): string {
  return join(HERE, "report-writer.ts");
}

/** the slice of pi's extension API this file uses, declared here so it does not import pi's SDK */
interface PiReportTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute(toolCallId: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface PiReportApi {
  registerTool(tool: PiReportTool): void;
}

function textResult(text: string): unknown {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * Write the run's two files. The JSON is checked before anything is written, so a call the harness cannot read
 * back never leaves a completed deliverable. The returned text is what the agent sees.
 */
export function writeDeliverable(report: string, markdown: string, jsonText: string): string {
  try {
    JSON.parse(jsonText);
  } catch (err) {
    return `report.json として読めません: ${err instanceof Error ? err.message : String(err)}。2 ファイルは書いていない。直して、もう一度 ${REPORT_TOOL_NAME} を呼ぶこと。`;
  }
  mkdirSync(dirname(report), { recursive: true });
  const md = `${report}.md`;
  const json = `${report}.json`;
  writeFileSync(md, markdown);
  writeFileSync(json, jsonText.endsWith("\n") ? jsonText : `${jsonText}\n`);
  return `${md} と ${json} を書いた。応答を終えること。`;
}

export default function registerReportWriter(pi: PiReportApi): void {
  pi.registerTool({
    name: REPORT_TOOL_NAME,
    label: REPORT_TOOL_NAME,
    description:
      "run の成果物（report.md と report.json）を 1 回で書く。書き先は引数に取らず、harness が決めたこの run の 2 ファイルだけに書く。json が読めない呼び出しは何も書かずに理由を返すので、直して呼び直すこと。",
    promptSnippet: "成果物は write_report で report.md と report.json を 1 回に書く",
    promptGuidelines: [
      `成果物を書くときは ${REPORT_TOOL_NAME} を 1 回呼び、markdown と json を渡す。書き先は引数に取らない。`,
      `json が読めない呼び出しは何も書かない。結果に返る理由を見て直し、もう一度 ${REPORT_TOOL_NAME} を呼ぶ。`,
    ],
    // a plain JSON Schema: the provider reads the same shape a TypeBox schema serializes to
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "report.md に書く本文" },
        json: { type: "string", description: "report.json に書く JSON 1 オブジェクト（文字列として）" },
      },
      required: ["markdown", "json"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: Record<string, unknown>) {
      const report = reportPathOf();
      if (!report) return textResult("report の path が渡されていないので、この run の成果物は書けない");
      const markdown = typeof args.markdown === "string" ? args.markdown : "";
      const json = typeof args.json === "string" ? args.json : "";
      try {
        return textResult(writeDeliverable(report, markdown, json));
      } catch (err) {
        return textResult(`成果物を書けませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
