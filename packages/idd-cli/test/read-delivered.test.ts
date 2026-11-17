/**
 * `idd read delivered`: the same answer for a person at a terminal and the conversation's tool (they share the
 * list), the default that cuts and says what it cut, and `--full` and `--json` that do not. The records are the lane package's fixtures.
 */
import { describe, expect, test } from "bun:test";

import {
  KEY_VALUE, REQUEST_1, REQUEST_2, claudeConversation, piConversation, restoreStateDir, stateRoot,
} from "../../idd-lane/test/helpers/delivered-fixture.ts";
import { SHOWN_CHARS } from "../src/read-delivered.ts";
import { READ_COMMAND_NAMES, readCommandRefusal, runReadCommand } from "../src/read-commands.ts";

restoreStateDir();

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReadCommand(["delivered", ...argv], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, out: out.join(""), err: err.join("") };
}

/** what a reader of the output must find, one by one */
const mustHave = (out: string, wanted: string[]) => expect(wanted.filter((w) => !out.includes(w))).toEqual([]);

const LONG = `${REQUEST_1}\n${"長い依頼の行。".repeat(400)}\n終わりの目印`;
const kindOf = (l: { kind: string }) => l.kind;

describe("idd read delivered", () => {
  test("the command is in the shared list, so the conversation's tool runs it too, and its flags pass the gate", () => {
    const refusals = [
      readCommandRefusal(["delivered", "IDD-9/planner-x", "--diff", "run-b", "--full", "--line", "3", "--json"]),
      readCommandRefusal(["delivered", "run-a", "--approve"]),
      readCommandRefusal(["delivered", "run-a", "--diff"]),
    ];
    expect(READ_COMMAND_NAMES).toContain("delivered");
    expect([refusals[0], refusals[1]?.includes("知らない flag"), refusals[2]?.includes("値が必要")]).toEqual([null, true, true]);
  });

  test("a run's id and a lane with a role name the same run, and the request comes out as it was sent", async () => {
    piConversation(stateRoot(), "20261111-010000-planner-x", { second: REQUEST_2 });
    const byId = await run("20261111-010000-planner-x", "--full");
    expect([byId.code, (await run("IDD-9/planner-x", "--full")).out]).toEqual([0, byId.out]);
    mustHave(byId.out, ["turn 1 依頼文 s1_prep_start", "turn 2 依頼文 plan_review_findings", "2 回目の封筒。", "道具の定義と pi の固定の前置き"]);
  });

  test("the default cuts a long text and says what is left, and --full and --line read it whole", async () => {
    piConversation(stateRoot(), "run-pi", { request: LONG });
    const cut = await run("run-pi");
    mustHave(cut.out, [`切りました: ${SHOWN_CHARS} 文字まで`, "--full か --line"]);
    expect(cut.out).not.toContain("終わりの目印");
    expect((await run("run-pi", "--full")).out).toContain("終わりの目印");
    const at = cut.out.split("\n").find((l) => l.includes("依頼文"))!.match(/^\[(\d+)\]/)![1];
    const one = (await run("run-pi", "--line", at)).out;
    expect([one.includes("終わりの目印"), one.includes("道具の結果")]).toEqual([true, false]);
    expect((await run("run-pi", "--line", "99")).out).toContain("99 行目はありません");
  });

  test("--json is not cut, and names the kind of every line", async () => {
    piConversation(stateRoot(), "run-pi", { request: LONG });
    const json = JSON.parse((await run("run-pi", "--json")).out);
    expect(json.lines.find((l: { kind: string }) => l.kind === "request").text).toContain("終わりの目印");
    expect(new Set(json.lines.map(kindOf))).toEqual(new Set(["context-file", "addendum", "request", "tool-result", "inject"]));
  });

  test("what a tool returned is shown as it was, a `.env` body included: the default, --full and --json carry it whole", async () => {
    const root = stateRoot();
    piConversation(root, "run-pi");
    claudeConversation(root, "run-claude");
    for (const id of ["run-pi", "run-claude"]) {
      for (const flags of [[], ["--full"], ["--json"], ["--full", "--json"]]) {
        const out = (await run(id, ...flags)).out;
        expect([id, flags, out.includes(KEY_VALUE), out.includes("伏せた")]).toEqual([id, flags, true, false]);
      }
    }
  });

  test("--diff reads the same record as all the same, and a changed line with its difference", async () => {
    const root = stateRoot();
    piConversation(root, "run-a", { idd: "IDD-1", request: `${REQUEST_1}\nA の 1 行` });
    piConversation(root, "run-b", { idd: "IDD-2", request: `${REQUEST_1}\nB の 1 行` });
    expect((await run("run-a", "--diff", "run-a")).out).toContain("変わった 0 / A だけ 0 / B だけ 0");
    mustHave((await run("IDD-1/planner-x", "--diff", "IDD-2/planner-x")).out, ["変わった 1", "- A の 1 行", "+ B の 1 行"]);
    const json = JSON.parse((await run("run-a", "--diff", "run-b", "--json")).out);
    expect(json.rows.filter((r: { mark: string }) => r.mark === "changed")).toHaveLength(1);
  });

  test("a run that is not there, and a missing argument, end with a line of reason", async () => {
    stateRoot();
    const none = await run("IDD-9/planner-x");
    expect([none.code, none.err]).toEqual([1, "run が見つかりません: IDD-9/planner-x\n"]);
    mustHave((await run()).err, ["run の id か IDD-xxx/役 を指定してください"]);
    mustHave((await run("run-a", "--line", "x")).err, ["--line には 1 以上の行の番号"]);
  });
});
