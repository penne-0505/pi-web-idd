import type { SessionStatus } from "./port.ts";

interface SessionEntry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string; timestamp?: number };
}

/**
 * How a stopped session's last turn ended, read from its jsonl record: an error reply, a turn cut
 * off mid-way (the last message is a tool call or its result), or a finished reply.
 */
export function sessionStopFrom(jsonl: string): SessionStatus {
  const lines = jsonl.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(lines[i]) as SessionEntry;
    } catch {
      continue;
    }
    const m = entry.message;
    if (entry.type !== "message" || !m) continue;
    const at = entry.timestamp ?? new Date(typeof m.timestamp === "number" ? m.timestamp : 0).toISOString();
    if (m.role !== "assistant") return { state: "stopped", cause: "interrupted", at };
    if (m.stopReason === "error") return { state: "stopped", cause: "error", error: (m.errorMessage ?? "").slice(0, 300), at };
    if (m.stopReason === "aborted" || m.stopReason === "toolUse") return { state: "stopped", cause: "interrupted", at };
    return { state: "stopped", cause: "finished", at };
  }
  return { state: "unknown" };
}
