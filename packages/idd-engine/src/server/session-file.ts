import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pipelineAgentDir, pipelineStateDir, readPipelineSession, resolveRole } from "@idd/lane";

const SESSION_ID = /^[A-Za-z0-9_.-]+$/;

/** 深さ優先で `sessions` の下から `<timestamp>_<id>.jsonl` を探す（pi は cwd ごとの dir を 1 段挟む） */
function findUnder(sessionsDir: string, suffix: string, maxDepth = 3): string | null {
  if (!existsSync(sessionsDir)) return null;
  const stack: { dir: string; depth: number }[] = [{ dir: sessionsDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) return path;
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
    }
  }
  return null;
}

/** pi の agent dir の一覧: その session の記録の role、ユーザの dir、state の下の全 role */
function agentDirs(sessionId: string): string[] {
  const dirs: string[] = [];
  try {
    const rec = readPipelineSession(sessionId);
    if (rec?.agent_dir) dirs.push(rec.agent_dir);
    else if (rec?.role) {
      try { dirs.push(pipelineAgentDir(resolveRole(rec.role))); } catch { /* role gone */ }
    }
  } catch { /* no record */ }
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) dirs.push(fromEnv);
  if (process.env.HOME) dirs.push(join(process.env.HOME, ".pi", "agent"));
  try {
    const base = join(pipelineStateDir(), "agent");
    for (const role of readdirSync(base)) dirs.push(join(base, role));
  } catch { /* none */ }
  return dirs;
}

/**
 * The pi session file of a session id, found without pi's SDK: the engine may read a session's record
 * (cost, stop reason) but must not pull the agent's package into its own process.
 */
export function resolveSessionFile(sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const suffix = `_${sessionId}.jsonl`;
  for (const agentDir of agentDirs(sessionId)) {
    const found = findUnder(join(agentDir, "sessions"), suffix);
    if (found) return found;
  }
  return null;
}
