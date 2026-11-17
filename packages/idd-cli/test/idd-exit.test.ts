import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

/** the entry the wrapper `bin/idd` runs, started directly so no shell stands between it and the pipe */
const IDD_TS = join(import.meta.dir, "..", "bin", "idd.ts");

/** a fake door on a free port: it answers the next scripted reply and records what it got */
async function fakeServer(replies: { status: number; body: unknown }[]) {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      const reply = replies.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Piped {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** run the CLI with its stdout on a pipe, the way an agent or a shell pipeline reads it */
function runPiped(args: string[], env: NodeJS.ProcessEnv): Promise<Piped> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [IDD_TS, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

describe("idd's exit leaves the whole answer on the pipe", () => {
  test("AC-005: an answer over 64 KB reaches the reader whole", async () => {
    // wide enough that the answer cannot fit in one pipe buffer: the old outright exit cut it at 65,536 B
    const why = "w".repeat(400);
    const choices = Array.from({ length: 400 }, (_, i) => ({
      id: `C-9-${i + 1}`,
      purpose: "P-9",
      forms: { chosen: `形 ${i + 1}` },
      why,
      free: "f",
      status: "active",
      matched: [{ path: "a/b.ts", place: "a/", kind: "dir" }],
    }));
    const server = await fakeServer([{ status: 200, body: { ok: true, choices } }]);
    try {
      const env = { ...process.env, IDD_AGENT_BASE_URL: server.url, IDD_STATE_DIR: tmpDir("idd-exit-state-") };
      delete env.IDD_ID;
      delete env.IDD_SESSION_ID;
      const r = await runPiped(["intent", "lookup", "--json", "a/b.ts", "--repo", "me/app"], env);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(Buffer.byteLength(r.stdout, "utf8")).toBeGreaterThan(65536);
      // the whole JSON arrived: a cut body would not parse, and the count is what a reader of it uses
      const body = JSON.parse(r.stdout) as { choices: unknown[] };
      expect(body.choices.length).toBe(choices.length);
    } finally {
      await server.close();
    }
  }, 60000);

  test("AC-005: the exit status still reaches the caller on a failure", async () => {
    const server = await fakeServer([{ status: 400, body: { ok: false, error: "repo を決められません" } }]);
    try {
      const env = { ...process.env, IDD_AGENT_BASE_URL: server.url, IDD_STATE_DIR: tmpDir("idd-exit-state-") };
      delete env.IDD_ID;
      delete env.IDD_SESSION_ID;
      const r = await runPiped(["intent", "lookup", "a/b.ts", "--repo", "me/app"], env);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("repo を決められません");
    } finally {
      await server.close();
    }
  }, 60000);
});
