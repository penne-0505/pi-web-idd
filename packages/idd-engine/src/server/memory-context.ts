import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

/** the index's file name; the top level and every region dir carry their own under this name */
export const MEMORY_INDEX_NAME = "MEMORY.md";

/** whether a path names a file this process can read; the child runs as the same user */
export function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** the top-level index of a mode's memory dir */
export function memoryIndexPath(memoryDir: string): string {
  return join(memoryDir, MEMORY_INDEX_NAME);
}

/**
 * The system-prompt appendixes that carry a mode's memory: one text that names the memory dir and its
 * top-level index, then the index path itself, which pi reads as a file at start. The engine holds no copy of
 * the index, and only the top level rides here; a region's index and a fact's body are read by the agent from
 * the top-level index. A mode whose top-level index is absent adds nothing at all, so its agent never learns
 * of a memory dir to start writing in. An index that cannot be read is treated the same way: Claude Code
 * refuses a whole launch over an unreadable `--append-system-prompt-file`, so a broken file would keep every
 * conversation of the mode from opening.
 */
export function memorySystemPrompts(memoryDir: string): string[] {
  const index = memoryIndexPath(memoryDir);
  if (!isReadableFile(index)) return [];
  return [`# 記憶\n\n記憶の置き場: ${memoryDir}\n最上位の索引: ${index}`, index];
}
