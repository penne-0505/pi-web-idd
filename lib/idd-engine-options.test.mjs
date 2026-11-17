import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

/** a `bun` that only says what the wrapper exported, so the destination the CLI would use can be read */
function stubBun() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-engine-options-"));
  writeFileSync(join(dir, "bun"), '#!/bin/sh\necho "AGENT=$IDD_AGENT_BASE_URL"\necho "INBOX=$IDD_INBOX_BASE_URL"\necho "PORT=$IDD_ENGINE_PORT"\necho "TAILNET=$IDD_TAILNET_ADDRESSES"\necho "ORIGINS=$IDD_TAILNET_ORIGINS"\n');
  chmodSync(join(dir, "bun"), 0o755);
  return dir;
}

/** the environment a wrapper is run in: no inherited destination, and no gateway file to read */
function cleanEnv(dir, extra) {
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, IDD_GATEWAY_ENV: "/nonexistent" };
  for (const key of ["IDD_AGENT_BASE_URL", "IDD_INBOX_BASE_URL", "IDD_ENGINE_PORT", "IDD_TAILNET_ADDRESSES", "IDD_TAILNET_ORIGINS"]) delete env[key];
  return { ...env, ...extra };
}

function run(script, dir, extra) {
  return execFileSync(join(ROOT, "bin", script), [], { env: cleanEnv(dir, extra), encoding: "utf8" });
}

test("the engine's CLI points at the port the engine actually listens on when only IDD_ENGINE_PORT changes", () => {
  const dir = stubBun();
  const out = run("idd-engine", dir, { IDD_ENGINE_PORT: "39999" });
  assert.match(out, /^AGENT=http:\/\/127\.0\.0\.1:39999$/m);
  assert.match(out, /^PORT=39999$/m);
  // the wrapper keeps no copy of the inbox's address: the CLI derives it from the port (inboxBaseUrl)
  assert.match(out, /^INBOX=$/m);
});

test("the plain CLI follows the same port", () => {
  const dir = stubBun();
  const out = run("idd", dir, { IDD_ENGINE_PORT: "39999" });
  assert.match(out, /^AGENT=http:\/\/127\.0\.0\.1:39999$/m);
  assert.match(out, /^INBOX=$/m);
});

test("an explicit IDD_AGENT_BASE_URL wins over the port (the unit's setting is not changed)", () => {
  const dir = stubBun();
  const out = run("idd-engine", dir, { IDD_ENGINE_PORT: "39999", IDD_AGENT_BASE_URL: "http://127.0.0.1:1234" });
  assert.match(out, /^AGENT=http:\/\/127\.0\.0\.1:1234$/m);
});

test("without either, the destination is the engine's default port", () => {
  const dir = stubBun();
  const out = run("idd-engine", dir, {});
  assert.match(out, /^AGENT=http:\/\/127\.0\.0\.1:30144$/m);
  assert.match(out, /^PORT=30144$/m);
});

test("the engine's entry passes the tailnet settings from the user's env file to the engine", () => {
  const dir = stubBun();
  const envFile = join(dir, "gateway.env");
  writeFileSync(envFile, "IDD_TAILNET_ADDRESSES=100.64.0.5,100.64.0.6\nIDD_TAILNET_ORIGINS=https://pc.example.ts.net:8443\n");
  const out = run("idd-engine", dir, { IDD_GATEWAY_ENV: envFile });
  assert.match(out, /^TAILNET=100\.64\.0\.5,100\.64\.0\.6$/m);
  assert.match(out, /^ORIGINS=https:\/\/pc\.example\.ts\.net:8443$/m);
});

test("without the env file, or without its tailnet lines, the engine gets none", () => {
  const dir = stubBun();
  const none = run("idd-engine", dir, {});
  assert.match(none, /^TAILNET=$/m);
  assert.match(none, /^ORIGINS=$/m);
  // a file that exists but names no tailnet value passes none either
  const envFile = join(dir, "gateway.env");
  writeFileSync(envFile, "AI_GATEWAY_API_KEY=not-read-here\n");
  const empty = run("idd-engine", dir, { IDD_GATEWAY_ENV: envFile });
  assert.match(empty, /^TAILNET=$/m);
  assert.match(empty, /^ORIGINS=$/m);
});
