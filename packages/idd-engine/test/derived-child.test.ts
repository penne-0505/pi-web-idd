import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

import { derivedOverlay, derivationBusy, startDerivedService, stopDerivedService } from "../src/server/derived-service.ts";

/**
 * The engine runs under bun, so this is the path the derivation child really takes there: `bun` reads the
 * checkout's tsconfig aliases itself and starts the child directly (the engine's node runs go through
 * `derive-boot.mjs` instead, which is what `packages/idd-engine/src/server/derived.test.mjs` covers).
 */

const saved = { state: process.env.IDD_STATE_DIR, repos: process.env.IDD_REPOS_FILE };

afterEach(() => {
  for (const [k, v] of [["IDD_STATE_DIR", saved.state], ["IDD_REPOS_FILE", saved.repos]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stopDerivedService();
});

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

test("the derivation child starts under bun and lands a derivation", async () => {
  const root = tmpDir("idd-derived-child-");
  const state = join(root, "state");
  mkdirSync(state);
  const repos = join(root, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: { demo: { github: "test/project", upstream: join(root, "up"), work: join(root, "work"), work_base: "main", public_base: "main", lanes_root: join(root, "lanes"), checks: [] } } }));
  Object.assign(process.env, { IDD_STATE_DIR: state, IDD_REPOS_FILE: repos });
  writeFileSync(join(state, "backlog.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", parent_id: null, created_at: "2026-09-28T00:00:00Z", linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "demo" })}\n`);
  writeFileSync(join(state, "lifecycle-demo.jsonl"), `${JSON.stringify({ idd_id: "IDD-1", event: "lane_open", at: "2026-09-28T00:00:00Z", attrs: {} })}\n`);

  startDerivedService();
  const deadline = Date.now() + 90_000;
  while (!derivedOverlay().at && Date.now() < deadline) await sleep(250);
  expect(derivedOverlay().at).not.toBe("");
  expect(derivationBusy()).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
