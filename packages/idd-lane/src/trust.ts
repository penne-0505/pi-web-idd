import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * pi's own project trust record (`<agentDir>/trust.json`: canonical cwd → true / false), read the way pi
 * reads it. A headless `-p` with no trust flag decides from the record, the settings' default and the
 * extensions, so a lane that passes none can trust what the UI's server would not. The nearest ancestor
 * with a decision wins; nothing recorded (or no readable file) is not trusted.
 */
export function projectTrusted(agentDir: string, cwd: string): boolean {
  const file = join(agentDir, "trust.json");
  if (!existsSync(file)) return false;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    data = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  let dir = canonical(resolve(cwd));
  for (;;) {
    const decision = data[dir];
    if (decision === true) return true;
    if (decision === false) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** the flag a lane's pi is started with, so its trust matches what the UI's server would decide */
export function projectTrustFlag(agentDir: string, cwd: string): "--approve" | "--no-approve" {
  return projectTrusted(agentDir, cwd) ? "--approve" : "--no-approve";
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
