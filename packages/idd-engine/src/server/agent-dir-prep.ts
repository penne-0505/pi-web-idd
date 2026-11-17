import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Prepare a role's agent dir in a child, never in the engine's own process: the preparation runs pi's
 * catalog synchronously (and can fetch a gateway's price list) and would freeze the engine's event loop
 * and every other conversation while it does.
 */
export function prepareAgentDirAsync(roleName: string, modelName?: string): Promise<void> {
  const script = fileURLToPath(new URL("./prepare-agent-dir.ts", import.meta.url));
  return new Promise<void>((resolveReady, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, roleName, ...(modelName ? [modelName] : [])], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500); });
    child.on("error", (err) => reject(new Error(`agent dir を用意できません: ${String(err)}`)));
    child.on("close", (code) => {
      if (code === 0) resolveReady();
      else reject(new Error(`agent dir を用意できません (exit ${code}): ${stderr.trim()}`));
    });
  });
}
