import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runLaneCommand } from "../src/lane-commands.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const savedCwd = process.cwd();
afterEach(() => process.chdir(savedCwd));

function repo() {
  const root = tmpDir("idd-intent-cli-");
  const doc = join(root, "_docs/intent/app/one/decision.md");
  mkdirSync(dirname(doc), { recursive: true });
  writeFileSync(doc, "# one\n\n## Decisions\n\n### DEC-701: 保存の前に確認を挟む\n\n- **Why**: 取り消せない削除を防ぐため。\n- **Anchors**: `src/save.ts`\n");
  return root;
}

async function capture(fn: () => Promise<number | undefined>): Promise<{ code: number | undefined; out: string; err: string }> {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    return { code: await fn(), out, err };
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
  }
}

describe("idd intent decisions", () => {
  test("pulls the DECs whose Anchors hold the given paths, without a lane token", async () => {
    const root = repo();
    process.chdir(root);
    delete process.env.IDD_ID;
    delete process.env.IDD_AGENT_TOKEN;
    const r = await capture(() => runLaneCommand("intent", ["decisions", "src/save.ts"]));
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.count).toBe(1);
    expect(body.candidates[0].id).toBe("DEC-701");
    expect(body.candidates[0].title).toBe("保存の前に確認を挟む");
    expect(body.candidates[0].doc).toBe("_docs/intent/app/one/decision.md");
    expect(body.candidates[0].files).toEqual(["src/save.ts"]);
    expect(body.candidates[0].why).toBe("取り消せない削除を防ぐため。");
    expect(body.dropped).toBe(0);
  });

  test("a path no Anchors names comes back as an empty list", async () => {
    const root = repo();
    process.chdir(root);
    const r = await capture(() => runLaneCommand("intent", ["decisions", "src/none.ts"]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ count: 0, dropped: 0, candidates: [] });
  });

  test("no path prints the usage and fails", async () => {
    const root = repo();
    process.chdir(root);
    const r = await capture(() => runLaneCommand("intent", ["decisions"]));
    expect(r.code).toBe(2);
    expect(r.err).toContain("idd intent decisions");
  });

  test("an unknown verb prints the usage and fails", async () => {
    const r = await capture(() => runLaneCommand("intent", ["list"]));
    expect(r.code).toBe(2);
    expect(r.err).toContain("idd intent decisions");
  });

  test("lists the three kinds of Anchors the index cannot reach (AC-010)", async () => {
    const root = tmpDir("idd-intent-anchors-");
    const doc = join(root, "_docs/intent/app/one/decision.md");
    mkdirSync(dirname(doc), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/present.ts"), "export const x = 1;\n");
    writeFileSync(doc, [
      "### DEC-801: Anchors の欄が無い",
      "",
      "- **What**: a",
      "- **Why**: b",
      "- **Change freedom**: c",
      "",
      "### DEC-802: パスを 1 つも読めない",
      "",
      "- **What**: a",
      "- **Why**: b",
      "- **Change freedom**: c",
      "- **Anchors**: components/Foo.tsx:1-52",
      "",
      "### DEC-803: None と書いた DEC",
      "",
      "- **What**: a",
      "- **Why**: b",
      "- **Change freedom**: c",
      "- **Anchors**: None（運用の決まりで、統治するファイルが無い）",
      "",
      "### DEC-804: repo に無いパス",
      "",
      "- **What**: a",
      "- **Why**: b",
      "- **Change freedom**: c",
      "- **Anchors**: `src/absent.ts`",
      "",
      "### DEC-805: 実在するパス",
      "",
      "- **What**: a",
      "- **Why**: b",
      "- **Change freedom**: c",
      "- **Anchors**: `src/present.ts`",
    ].join("\n"));
    process.chdir(root);
    const r = await capture(() => runLaneCommand("intent", ["anchors"]));
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.missing.map((x: { id: string }) => x.id)).toEqual(["DEC-801"]);
    expect(body.unreadable.map((x: { id: string }) => x.id)).toEqual(["DEC-802"]);
    expect(body.missing_paths).toEqual([{ id: "DEC-804", doc: "_docs/intent/app/one/decision.md", path: "src/absent.ts" }]);
    expect(body.counts).toEqual({ missing: 1, unreadable: 1, missing_paths: 1 });
  });
});
