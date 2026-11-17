import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentRunner, laneHoldToken, readHolds } from "@idd/core";

import { routes } from "../src/routes.ts";
import { POST as holdPost } from "../src/routes/agent-hold.ts";
import { ensureAgentRunner } from "../src/server/agent-runner.ts";
import { commitAll, emptyRepo, pushToNewOrigin, writeFiles } from "../../idd-lane/test/helpers/git.ts";
import { withPointedRepo } from "../../idd-lane/test/helpers/repos.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

/**
 * The engine's two sides of a hold: the door a lane's `idd hold run` posts to (it writes the lane's records, so it
 * answers only the agent token), and the writer of the submit card's PR text, which hands out what the agent handed
 * over instead of asking a writer.
 */

const TOKEN = "lane-token";
const saved = { state: process.env.IDD_STATE_DIR, token: process.env.IDD_AGENT_TOKEN, kick: process.env.IDD_TICK_KICK };

function setup(events: string[] = ["lane_open", "s1_go", "s2_start"]): string {
  const state = tmpDir("idd-engine-hold-");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", area: "me/app", title: "T", context: "", created_at: "2026-10-26T00:00:00Z" })}\n`);
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(join(state, "lifecycle-me-app.jsonl"), events.map((event) => JSON.stringify({ idd_id: "IDD-1", event, at, attrs: {} })).join("\n") + "\n");
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_AGENT_TOKEN: TOKEN, IDD_TICK_KICK: "off" });
  return state;
}

afterEach(() => {
  for (const [key, value] of [["IDD_STATE_DIR", saved.state], ["IDD_AGENT_TOKEN", saved.token], ["IDD_TICK_KICK", saved.kick]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const laneToken = (lane: string): string => laneHoldToken(lane, TOKEN);
const post = (body: unknown, token: string | null = laneToken(String((body as { idd_id?: unknown }).idd_id ?? ""))) => holdPost(new Request("http://localhost/api/idd/agent/hold", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));

describe("the hold door", () => {
  test("is routed, and answers only the credential of the lane it names", async () => {
    expect(routes.some((r) => r.method === "POST" && r.pattern === "/api/idd/agent/hold" && r.handler === holdPost)).toBe(true);
    const state = setup();
    // the shared agent token names no lane, and another lane's credential is not this lane's
    for (const token of [null, "wrong", TOKEN, laneToken("IDD-2")]) {
      const res = await post({ idd_id: "IDD-1", kind: "push" }, token);
      expect(res.status).toBe(401);
    }
    expect(readFileSync(join(state, "lifecycle-me-app.jsonl"), "utf8")).not.toContain("s2_result");
    expect(readHolds("IDD-1")).toEqual([]);
    expect(readHolds("IDD-2")).toEqual([]);
    expect((await post({ idd_id: "", kind: "push" })).status).toBe(401);
  });

  test("takes a push as the executor's report, and a kind it does not know as a bad request", async () => {
    const state = setup();
    const res = await post({ idd_id: "IDD-1", kind: "push" });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(join(state, "lifecycle-me-app.jsonl"), "utf8")).toContain("s2_result");
    expect((await post({ idd_id: "IDD-1", kind: "merge" })).status).toBe(400);
  });

  test("refuses a lane that is not implementing, with the reason, and writes nothing", async () => {
    const state = setup(["lane_open", "s1_ready"]);
    const res = await post({ idd_id: "IDD-1", kind: "push" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("実装の段");
    expect(readFileSync(join(state, "lifecycle-me-app.jsonl"), "utf8")).not.toContain("s2_result");
  });
});

/** the PR text of `lane`, asked of the engine's writer */
const draft = (extra: Record<string, unknown> = {}, lane = "IDD-1") => {
  ensureAgentRunner();
  return getAgentRunner()!.draftPrText!({ repo: "me/app", material: "", lane, ...extra });
};
/** the lane hands a PR text over, and the writer is asked for it */
const held = async (title: string, body: string) => {
  await post({ idd_id: "IDD-1", kind: "pr-create", title, body });
  return draft();
};

describe("the PR text writer", () => {
  test("answers a lane's held PR text itself, and a rewrite of a PR already up is not that text", async () => {
    setup();
    // no repo is registered in this state: reaching the writer would fail, so an answer is the held text
    expect(await held("docs: keep the files", "Why and what.")).toEqual({ title: "docs: keep the files", body: "Why and what.", model: "agent" });
    await expect(draft({ revise: true })).rejects.toThrow();
    await expect(draft({}, "IDD-2")).rejects.toThrow();
  });

  test("the held text of a repo that points at its PR section meets that section's headings and loses the AI's mark lines", async () => {
    setup();
    const clone = emptyRepo("idd-hold-clone-");
    writeFiles(clone, { "docs/pr.md": "# PR\n\n## PR本文\n\n### 概要\n\n### 手順\n\n🤖 AIが作成したPR本文です。\n" });
    commitAll(clone, "base");
    pushToNewOrigin(clone);
    await withPointedRepo("me/app", clone, { pr: { file: "docs/pr.md", section: "## PR本文" } }, async () => {
      const text = await held("docs: 直す", "### 概要\n\n直した。\n\n### 手順\n\n手順。\n\n🤖 AIが作成したPR本文です。");
      expect(text).toMatchObject({ title: "docs: 直す", body: "### 概要\n\n直した。\n\n### 手順\n\n手順。", model: "agent" });
      // the section the text met is recorded with it, as a hash: the card's first check compares the base's section with it
      expect(text.conventions).toEqual([{ kind: "pr", file: "docs/pr.md", section: "## PR本文", hash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
      await expect(held("docs: 直す", "## Summary\n\nx")).rejects.toThrow("テンプレの節を欠いていました");
    }, { github: "me/app" });
  });
});
