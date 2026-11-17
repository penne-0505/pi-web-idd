import { readFileSync } from "node:fs";
import { join } from "node:path";

import { laneStateDir } from "./paths.ts";

/**
 * The callback token the engine wrote (`<state>/agent-token`), or the value it passed down in
 * IDD_AGENT_TOKEN. A lane's supervisor reads it per reply, from the file: the record it would otherwise
 * carry must never hold the token. A reader never creates the file (the engine writes it before any spawn).
 */
export function readAgentToken(): string | null {
  const fromEnv = process.env.IDD_AGENT_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const stored = readFileSync(join(laneStateDir(), "..", "agent-token"), "utf8").trim();
    return stored || null;
  } catch {
    return null;
  }
}
