import { afterEach, describe, expect, test } from "bun:test";

import { postJsonWithRetry, postReport } from "../src/lane-commands.ts";

const ENV_KEYS = ["IDD_REPORT_RETRY_MS", "IDD_REPORT_RETRY_INTERVAL_MS"] as const;
let saved: Record<string, string | undefined> = {};

function save(): void {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}

function fastRetry(): void {
  process.env.IDD_REPORT_RETRY_MS = "3000";
  process.env.IDD_REPORT_RETRY_INTERVAL_MS = "50";
}

/** a fake engine that answers what a test tells it to, and counts what it received */
function fakeEngine(handler: (n: number) => Response) {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(await req.text());
      return handler(seen.length);
    },
  });
  return { server, seen, base: `http://127.0.0.1:${server.port}` };
}

/** a port nothing listens on: a connection that never reaches an engine */
async function deadPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("retrying a report while the engine is replaced", () => {
  test("keeps trying a connection that never landed until the engine answers, and delivers once", async () => {
    save();
    fastRetry();
    const port = await deadPort();
    const seen: string[] = [];
    let server: ReturnType<typeof Bun.serve> | null = null;
    // the engine comes up a moment later: the first tries are refused, then one lands
    const timer = setTimeout(() => {
      server = Bun.serve({
        port,
        fetch: async (req) => {
          seen.push(await req.text());
          return Response.json({ ok: true });
        },
      });
    }, 120);
    try {
      const res = await postReport({ baseUrl: `http://127.0.0.1:${port}`, laneId: "IDD-1", token: "t" }, "/api/idd/agent/progress", { current_step: "x" });
      expect(res.ok).toBe(true);
      expect(seen.length).toBe(1);
    } finally {
      clearTimeout(timer);
      server?.stop(true);
    }
  });

  test("tries again after the engine refuses with the reloading mark", async () => {
    save();
    fastRetry();
    const engine = fakeEngine((n) => n < 3
      ? Response.json({ ok: false, error: "入れ替え中", reloading: true }, { status: 503 })
      : Response.json({ ok: true }));
    try {
      const res = await postReport({ baseUrl: engine.base, laneId: "IDD-1", token: "t" }, "/api/idd/agent/result", { outcome: "success" });
      expect(res.ok).toBe(true);
      expect(engine.seen.length).toBe(3);
    } finally {
      engine.server.stop(true);
    }
  });

  test("does not try again a refusal that is not the reloading window", async () => {
    save();
    fastRetry();
    const engine = fakeEngine(() => Response.json({ ok: false, error: "token が違います" }, { status: 401 }));
    try {
      const res = await postReport({ baseUrl: engine.base, laneId: "IDD-1", token: "t" }, "/api/idd/agent/result", { outcome: "success" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("token");
      expect(engine.seen.length).toBe(1);
    } finally {
      engine.server.stop(true);
    }
  });

  test("gives up once the window has passed", async () => {
    save();
    process.env.IDD_REPORT_RETRY_MS = "150";
    process.env.IDD_REPORT_RETRY_INTERVAL_MS = "40";
    const port = await deadPort();
    const started = Date.now();
    const res = await postReport({ baseUrl: `http://127.0.0.1:${port}`, laneId: "IDD-1", token: "t" }, "/api/idd/agent/result", { outcome: "success" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("報告を送れませんでした");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  test("a 200 whose body cannot be read is still a success", async () => {
    save();
    fastRetry();
    const engine = fakeEngine(() => new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    try {
      const posted = await postJsonWithRetry(`${engine.base}/api/idd/agent/result`, { method: "POST", body: "{}" });
      expect(posted.error).toBeUndefined();
      expect(posted.response?.ok).toBe(true);
      expect(posted.data).toEqual({});
      const res = await postReport({ baseUrl: engine.base, laneId: "IDD-1", token: "t" }, "/api/idd/agent/result", { outcome: "success" });
      expect(res.ok).toBe(true);
      expect(engine.seen.length).toBe(2);
    } finally {
      engine.server.stop(true);
    }
  });
});
