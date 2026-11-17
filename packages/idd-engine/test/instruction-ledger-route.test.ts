/**
 * The engine's ledger read: a limit of 0 asks for nothing, and only a read that names no limit gets every entry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET } from "../src/routes/instruction.ts";

const saved = process.env.IDD_STATE_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (saved === undefined) delete process.env.IDD_STATE_DIR;
  else process.env.IDD_STATE_DIR = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledgerOf(count: number): void {
  const state = mkdtempSync(join(tmpdir(), "idd-ledger-route-"));
  dirs.push(state);
  process.env.IDD_STATE_DIR = state;
  const scope = { repos: "all", scenes: "all", places: "all" };
  const lines = Array.from({ length: count }, (_, n) => JSON.stringify({ at: `2026-10-25T0${n}:00:00.000Z`, instruction: "INS-1", text: "短く書く。", reason: "読まれないから", scope, via: "scope", to: { kind: "lane", stage: "blind", scene: "review", lane: "IDD-1" } }));
  writeFileSync(join(state, "instruction-ledger.jsonl"), `${lines.join("\n")}\n`);
}

async function read(query: string): Promise<{ entries: unknown[] }> {
  return (await GET(new Request(`http://engine/api/idd/instruction?op=ledger${query}`)).json()) as { entries: unknown[] };
}

describe("the engine's ledger read", () => {
  test("--limit 0 is empty, a limit is the newest N, and a read without one is every entry", async () => {
    ledgerOf(3);
    expect((await read("&limit=0")).entries).toHaveLength(0);
    expect((await read("&limit=2")).entries).toHaveLength(2);
    expect((await read("")).entries).toHaveLength(3);
    expect((await read("&lane=IDD-1")).entries).toHaveLength(3);
    expect((await read("&lane=IDD-1&limit=0")).entries).toHaveLength(0);
  });
});
