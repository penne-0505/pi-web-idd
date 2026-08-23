import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { resolveLocalFilePath } from "./file-links";
import { isEditToolName, isWriteToolName } from "./tool-names";

export interface WrittenFile {
  filePath: string;
}

function isFileWritingToolName(toolName: string): boolean {
  return isWriteToolName(toolName) || isEditToolName(toolName);
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// intent: DEC-236 — 書き込みの真実は write/edit ツール結果のみ、reply text の言及は無視
export function extractTurnWrittenFiles(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): WrittenFile[] {
  const seen = new Set<string>();
  const writtenFiles: WrittenFile[] = [];

  for (const block of content) {
    if (block.type !== "toolCall") continue;
    if (!isFileWritingToolName(block.toolName)) continue;

    // intent: DEC-236 — 結果未着 or error なら書き込みは発生していないので除外
    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;

    const rawPath = readToolPath(block.input);
    if (!rawPath) continue;

    // intent: DEC-236 — ツール引数はファイルパスであり href ではない、# ? :digits を保存する
    const filePath = resolveLocalFilePath(rawPath, cwd);
    if (!filePath) continue;

    if (seen.has(filePath)) continue;
    seen.add(filePath);
    writtenFiles.push({ filePath });
  }

  return writtenFiles;
}
