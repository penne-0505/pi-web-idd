import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runIgnoreCli, runIgnoreCommand } from "../src/ignore.ts";
import { tmpDir } from "../../idd-lane/test/helpers/tmp.ts";

const savedEnv = { IDD_STATE_DIR: process.env.IDD_STATE_DIR, IDD_REPOS_FILE: process.env.IDD_REPOS_FILE };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** a state with one GitHub lane and one Linear lane; no repo takes Issues in, so nothing is read from GitHub or Linear */
function setup(): string {
  const dir = tmpDir("idd-cli-ignore-");
  const repos = join(dir, "repos.yaml");
  writeFileSync(repos, JSON.stringify({ repos: {} }));
  process.env.IDD_STATE_DIR = dir;
  process.env.IDD_REPOS_FILE = repos;
  const lane = (id: string, gh: string | null, linear: string | null, title: string) => JSON.stringify({
    idd_id: id, parent_id: null, created_at: "2026-09-25T00:00:00Z", linear_issue_url: linear, gh_issue_url: gh, pull_req_url: null,
    source_type: gh ? "github" : "linear", context: "", title, area: gh ? "o/r" : "o/app",
  });
  writeFileSync(join(dir, "backlog.jsonl"), [
    lane("IDD-001", "https://github.com/o/r/issues/12", null, "gh twelve"),
    lane("IDD-002", null, "https://linear.app/org/issue/APP-7", "app seven"),
  ].join("\n") + "\n");
  return dir;
}

/** the lines a command writes, so two commands' words can be read apart */
async function capture(fn: () => Promise<{ code: number; stdout: string[]; stderr: string[] } | undefined>): Promise<string> {
  const res = await fn();
  return [...(res?.stdout ?? []), ...(res?.stderr ?? [])].join("\n");
}

describe("idd ignore / unignore / ignores", () => {
  test("puts an Issue on the list by its ref, closes the lane it belongs to, lists it, and takes it off", async () => {
    const dir = setup();
    const on = await runIgnoreCli("ignore", ["#12"], { tick: () => ({ outcome: "off" }) });
    expect(on).toBe(0);
    // the lane is closed with the Issue: the CLI prints both, and the same entry asks for the tick that stops its work
    const text = (await capture(() => runIgnoreCommand("ignore", ["APP-7"]))) ?? "";
    expect(text).toContain("APP-7 app seven");
    expect(text).toContain("GitHub・Linear には何も書いていません");
    expect(readFileSync(join(dir, "lifecycle-o-r.jsonl"), "utf8")).toContain('"lane_close"');
    expect(readFileSync(join(dir, "lifecycle-o-app.jsonl"), "utf8")).toContain('"outcome":"aborted"');

    const list = await runIgnoreCommand("ignores", []);
    expect(list?.stdout[0]).toContain("#12 gh twelve (o/r)");
    expect(list?.stdout[0]).toContain("IDD-001 を ignore して載った");
    expect(list?.stdout[1]).toContain("APP-7 app seven (o/app)");
    expect(list?.stdout.at(-1)).toBe("2 件");

    const off = await runIgnoreCommand("unignore", ["#12"]);
    expect(off?.code).toBe(0);
    expect(off?.stdout.join("\n")).toContain("外しました");
    const after = await runIgnoreCommand("ignores", []);
    expect(after?.stdout.length).toBe(2);
    expect(after?.stdout[0]).toContain("APP-7 app seven (o/app)");
    expect(after?.stdout[1]).toBe("1 件");

    // the lane is closed already: a ref of that Issue closes nothing and only puts the Issue on the list again
    const again = await runIgnoreCommand("ignore", ["#12"]);
    expect(again?.code).toBe(0);
    expect(again?.stdout.join("\n")).toContain("無視リストに載せました");
    expect((await runIgnoreCommand("ignores", []))?.stdout.at(-1)).toBe("2 件");
    // the lane's own ID is the form that closes that lane: refused once it is closed, and nothing is written
    const byId = await runIgnoreCommand("ignore", ["IDD-001"]);
    expect(byId?.code).toBe(1);
    expect(byId?.stderr.join("\n")).toContain("既に閉じています");
    expect((await runIgnoreCommand("ignores", []))?.stdout.at(-1)).toBe("2 件");
  });

  test("the CLI's ignore entry asks for a tick once the write went through, and not when it was refused", async () => {
    setup();
    const kicks: number[] = [];
    const tick = () => { kicks.push(1); return { outcome: "off" as const }; };
    expect(await runIgnoreCli("ignore", ["#12"], { tick })).toBe(0);
    expect(kicks.length).toBe(1);
    // reading the list records nothing
    expect(await runIgnoreCli("ignores", [], { tick })).toBe(0);
    expect(kicks.length).toBe(1);
    // a refused ignore (a closed lane's own ID) asks for no tick
    expect(await runIgnoreCli("ignore", ["IDD-001"], { tick })).toBe(1);
    expect(kicks.length).toBe(1);
    expect(await runIgnoreCli("intake", [])).toBeUndefined();
  });

  test("taking off a Linear Issue says it comes back only once it is updated on Linear after its lane closed", async () => {
    setup();
    expect((await runIgnoreCommand("ignore", ["APP-7"]))?.code).toBe(0);
    const off = await runIgnoreCommand("unignore", ["APP-7"]);
    expect(off?.code).toBe(0);
    expect(off?.stdout.join("\n")).toContain("Linear で更新されるまで");
    expect((await runIgnoreCommand("ignore", ["#12"]))?.code).toBe(0);
    const gh = await runIgnoreCommand("unignore", ["#12"]);
    expect(gh?.stdout.join("\n")).toContain("次の取り込みで取り込みます");
    expect(gh?.stdout.join("\n")).not.toContain("Linear で更新されるまで");
  });

  test("lists an Issue an ignore put on with the lane, and one an older record put there as a data row", async () => {
    setup();
    const { setIgnored } = await import("../../idd-core/src/intake/ignore.ts");
    await setIgnored("ignore", { source: "github", url: "https://github.com/o/r/issues/12", ref: "#12", title: "gh twelve", area: "o/r", lane: "IDD-001" }, "lane_abort");
    await setIgnored("ignore", { source: "linear", url: "https://linear.app/org/issue/APP-7", ref: "APP-7", title: "app seven", area: "o/app", lane: "IDD-002" }, "s1_defer");
    await setIgnored("ignore", { source: "linear", url: "https://linear.app/org/issue/APP-8", ref: "APP-8", title: "app eight", area: "o/app" });
    const list = await runIgnoreCommand("ignores", []);
    expect(list?.stdout[0]).toContain("IDD-001 の中止で載った");
    expect(list?.stdout[1]).toContain("IDD-002 の中止で載った");
    expect(list?.stdout[2]).toContain("penne が載せた");
  });

  test("refuses what it cannot name, and a command without a ref", async () => {
    setup();
    const unknown = await runIgnoreCommand("ignore", ["#99"]);
    expect(unknown?.code).toBe(1);
    expect(unknown?.stderr.join("\n")).toContain("#99");
    const off = await runIgnoreCommand("unignore", ["#12"]);
    expect(off?.code).toBe(1);
    expect(off?.stderr.join("\n")).toContain("無視リストにありません");
    expect((await runIgnoreCommand("ignore", []))?.code).toBe(2);
    expect((await runIgnoreCommand("ignores", []))?.stdout).toEqual(["無視リストは空です"]);
    expect(await runIgnoreCommand("intake", [])).toBeUndefined();
  });
});
