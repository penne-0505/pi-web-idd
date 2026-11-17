import { describe, expect, test, beforeEach } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { approveOutbound, createOutbound, readOutbound, type Rewriter } from "../src/outbound.ts";
import { approveSigned } from "./passkey-approval.ts";
import { tmpDir } from "./helpers/tmp.ts";

beforeEach(() => {
  process.env.IDD_STATE_DIR = tmpDir("idd-prbody-");
});

/** a gh that keeps one PR's title and body in a file, logs its arguments, and applies `pr edit` to the file */
function fakePrGh(initial: { title: string; body: string }) {
  const dir = tmpDir("idd-fakegh-prbody-");
  const logFile = join(dir, "calls.jsonl");
  const stateFile = join(dir, "pr.json");
  const save = (pr: { title: string; body: string }) => writeFileSync(stateFile, JSON.stringify({ ...pr, headRefOid: "abc1234ffff", state: "OPEN", url: "https://github.com/o/r/pull/7" }));
  save(initial);
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
const pr = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (args[0] === "pr" && args[1] === "view") { console.log(JSON.stringify(pr)); process.exit(0); }
if (args[0] === "pr" && args[1] === "edit") {
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (at("--body-file") !== undefined) pr.body = fs.readFileSync(at("--body-file"), "utf8");
  if (at("--title") !== undefined) pr.title = at("--title");
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(pr));
  console.log(pr.url);
  process.exit(0);
}
console.error("unexpected: " + args.join(" "));
process.exit(1);
`);
  chmodSync(bin, 0o755);
  process.env.IDD_GH_BIN = bin;
  return {
    log: (): string[][] => { try { return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]); } catch { return []; } },
    edits(): string[][] { return this.log().filter((a) => a[0] === "pr" && a[1] === "edit"); },
    current: () => JSON.parse(readFileSync(stateFile, "utf8")) as { title: string; body: string },
    /** someone edits the PR on GitHub */
    setBody: (body: string) => save({ ...(JSON.parse(readFileSync(stateFile, "utf8")) as { title: string }), body }),
  };
}

const rewriter: Rewriter = async (_kind, text) => ({ text: `清書: ${text}`, role: "rewriter", model: "m" });

describe("updating the body of an existing PR", () => {
  test("the card keeps the body it was made against, and approval writes exactly the approved text", async () => {
    const gh = fakePrGh({ title: "feat: 変更", body: "古い行\n残す行\n" });
    const rec = await createOutbound({ kind: "gh-pr-body", target: { repo: "o/r", pr: 7 }, title: "feat: 変更", body: "新しい行\n残す行\n" }, rewriter);
    expect(rec.target.baseBody).toBe("古い行\n残す行\n");
    expect(rec.target.baseTitle).toBe("feat: 変更");
    // the body is the text penne compares line by line: it is not rewritten
    expect(rec.rewritten).toBeUndefined();
    expect(gh.edits()).toEqual([]);

    const done = await approveSigned(rec.id, { title: "feat: 変更", body: "penne が直した行\n残す行\n" });
    expect(done.status).toBe("posted");
    expect(gh.edits().length).toBe(1);
    // an unchanged title is not sent along
    expect(gh.edits()[0]).not.toContain("--title");
    expect(gh.current().body).toBe("penne が直した行\n残す行\n");
  });

  test("a body changed on GitHub after the card was made is not overwritten, and the card is redone against it", async () => {
    const gh = fakePrGh({ title: "feat: 変更", body: "古い行\n" });
    const rec = await createOutbound({ kind: "gh-pr-body", target: { repo: "o/r", pr: 7 }, title: "feat: 変更", body: "新しい行\n" });
    gh.setBody("誰かが GitHub で直した行\n");

    const stale = await approveSigned(rec.id, { title: "feat: 変更", body: "新しい行\n" });
    expect(stale.status).toBe("failed");
    expect(stale.error).toMatch(/変わっていました/);
    expect(gh.edits()).toEqual([]);
    expect(gh.current().body).toBe("誰かが GitHub で直した行\n");
    // the card now shows the difference against what GitHub has
    expect(readOutbound(rec.id)?.target.baseBody).toBe("誰かが GitHub で直した行\n");

    const again = await approveSigned(rec.id, { title: "feat: 変更", body: "新しい行\n" });
    expect(again.status).toBe("posted");
    expect(gh.current().body).toBe("新しい行\n");
  });

  test("a changed title goes with the body, and a text that changes nothing is refused", async () => {
    const gh = fakePrGh({ title: "feat: 変更", body: "本文\n" });
    const rec = await createOutbound({ kind: "gh-pr-body", target: { repo: "o/r", pr: 7 }, title: "feat: 変更", body: "本文\n" });
    await expect(approveSigned(rec.id, { title: "feat: 変更", body: "本文\r\n" })).rejects.toThrow(/変わりません/);
    expect(gh.edits()).toEqual([]);

    const done = await approveSigned(rec.id, { title: "feat: 新しい題", body: "本文\n" });
    expect(done.status).toBe("posted");
    expect(gh.current()).toMatchObject({ title: "feat: 新しい題", body: "本文\n" });
  });

  test("a title changed on GitHub after the card was made stops the write too", async () => {
    const gh = fakePrGh({ title: "feat: 変更", body: "本文\n" });
    const rec = await createOutbound({ kind: "gh-pr-body", target: { repo: "o/r", pr: 7 }, title: "feat: 変更", body: "新しい本文\n" });
    writeFileSync(join(process.env.IDD_GH_BIN!, "..", "pr.json"), JSON.stringify({ ...gh.current(), title: "feat: 誰かの題", headRefOid: "abc", state: "OPEN", url: "u" }));
    const stale = await approveSigned(rec.id, { title: "feat: 変更", body: "新しい本文\n" });
    expect(stale.status).toBe("failed");
    expect(gh.edits()).toEqual([]);
    expect(readOutbound(rec.id)?.target.baseTitle).toBe("feat: 誰かの題");
  });

  test("the card needs the repo and the PR", async () => {
    fakePrGh({ title: "t", body: "b" });
    await expect(createOutbound({ kind: "gh-pr-body", target: { repo: "o/r" }, title: "t", body: "b" })).rejects.toThrow(/pr/);
  });
});
