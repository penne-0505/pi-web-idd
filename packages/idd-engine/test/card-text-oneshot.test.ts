import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snoozeKey } from "../../../lib/idd-ui/snooze.ts";
import { cardTextOf, cardTextsIdle, readCardTextRecord, scheduleCardTexts } from "../src/server/card-text.ts";
import { setOneShotLimits } from "../src/server/conversation-title.ts";
import { holdPipes, IGNORE_SIGTERM_AND_STAY } from "../../idd-lane/test/helpers/oneshot-scripts.ts";

/**
 * The card-text writer as the engine really runs it: pi is a stand-in on `IDD_PI_BIN`, the agent dir is readied in
 * its child, and the one-shot is the lane package's. The writer's own wording and checks are in
 * `src/server/card-text.test.mjs`; this file is about how a run ends.
 */

let dir = "";
const ENV = ["IDD_STATE_DIR", "IDD_ROLES_FILE", "IDD_PI_BIN", "IDD_PI_USER_AGENT_DIR"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-card-oneshot-"));
  writeFileSync(join(dir, "roles.yaml"), "models:\n  m: { model: x/y }\nroles:\n  card-writer: { model: m, thinking: low }\npipeline:\n");
  Object.assign(process.env, { IDD_STATE_DIR: dir, IDD_ROLES_FILE: join(dir, "roles.yaml") });
});

afterEach(async () => {
  await cardTextsIdle();
  setOneShotLimits(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** the pi the real writer starts: `body` is its one-shot behaviour, and `--list-models` is answered so the agent dir can be readied */
function realPi(body: string): void {
  const home = join(dir, "pi-home");
  mkdirSync(join(home, "user-agent"), { recursive: true });
  const file = join(home, "pi");
  writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--list-models")) { console.log("x y"); process.exit(0); }
${body}
`);
  chmodSync(file, 0o755);
  Object.assign(process.env, { IDD_PI_BIN: file, IDD_PI_USER_AGENT_DIR: join(home, "user-agent") });
}

/** the go card the writer is asked about, read from JSON text; `extra` replaces fields */
const goItem = (extra: Record<string, unknown> = {}) => ({ ...JSON.parse(`{
  "kind": "go", "iddId": "IDD-7", "appearedAt": "2026-10-27T00:00:00Z", "title": "受信箱の card を読みやすくする",
  "depth": "shallow", "notAuto": "質問が 1 件あったので人に回した", "planPath": "_docs/plan/Demo/idd-7/plan.md",
  "source": { "kind": "github", "label": "#7", "url": "https://github.com/o/r/issues/7" },
  "summary": { "situation": "card が内部の語で書かれている", "action": "6 欄に揃える", "outcome": "開いてすぐ判断できる" },
  "decisions": [{ "id": "C-7-1", "text": "card の文を別の役が書く", "why": "導出が model を待たないため" }],
  "criteria": [{ "id": "AC-001", "text": "6 欄が空でない" }],
  "purposeProposals": [{ "id": "P-new", "statement": "判断が 1 画面で済むようにしたい", "origin": "計画役" }],
  "planReview": { "state": "reviewed", "must": 0, "should": 0, "nit": 0, "findings": [], "rounds": [], "history": [] }
}`), ...extra }) as never;

const goodAnswer = () => `{
  "decide": "この計画で実装を始めてよいか？",
  "recommend": { "pick": 1, "sources": ["plan-review"] },
  "outcomes": [{ "changes": "実装役が起動して実装が始まる" }, { "changes": "計画が出し直されるまで実装は始まらない" }],
  "facts": [{ "source": "plan-summary" }, { "source": "lane" }],
  "settled": [{ "source": "plan-review" }, { "source": "depth" }, { "source": "not-auto" }, { "source": "purposes" }]
}`;

/** the JSONL line pi writes for an assistant answer */
const answerLine = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } });

const written = async (...items: unknown[]) => {
  scheduleCardTexts(items as never);
  await cardTextsIdle();
};

/** a card still reads as six fields from the raw material */
function expectRawSix(item: never): void {
  const text = cardTextOf(item);
  expect(text.by).toBe("raw");
  expect(text.decide.trim()).not.toBe("");
  expect(text.recommend.text.trim()).not.toBe("");
  expect(text.outcomes.length).toBeGreaterThan(0);
  expect(text.facts.length).toBeGreaterThan(0);
  expect(text.settled.length).toBeGreaterThan(0);
  expect(text.links.length).toBeGreaterThan(0);
}

describe("the card-text writer's one-shot run", () => {
  test("a writer that ignores SIGTERM is stopped, the card stays six raw fields, and the slots are free for the cards after it", async () => {
    realPi(IGNORE_SIGTERM_AND_STAY);
    setOneShotLimits({ timeoutMs: 300, graceMs: 200 });
    // more stuck runs than the writer has slots: each has to give its slot back for the next to run
    const stuck = ["IDD-7", "IDD-8", "IDD-9"].map((iddId) => goItem({ iddId, title: `止まる依頼 ${iddId}` }));
    const started = Date.now();
    await written(...stuck);
    expect(Date.now() - started).toBeLessThan(15_000);
    for (const item of stuck) {
      expectRawSix(item);
      expect(readCardTextRecord(snoozeKey(item))?.reason).toMatch(/訳す役が失敗した.*時間切れ/);
    }
    realPi(`console.log(${JSON.stringify(answerLine(goodAnswer()))}); process.exit(0);`);
    const next = goItem({ iddId: "IDD-10", title: "止まらない依頼" });
    await written(next);
    expect(cardTextOf(next).by).toBe("translated");
  }, 30_000);

  test("a writer that answered and exited is read as answered while a grandchild holds its pipes open", async () => {
    realPi(`${holdPipes()}
console.log(${JSON.stringify(answerLine(goodAnswer()))}); process.exit(0);`);
    setOneShotLimits({ timeoutMs: 20_000, graceMs: 200, drainMs: 200 });
    const item = goItem();
    await written(item);
    expect(cardTextOf(item).by).toBe("translated");
  }, 30_000);

  test("a writer the clock ended after it had written an answer leaves the raw card, not the partial answer", async () => {
    realPi(`console.log(${JSON.stringify(answerLine(goodAnswer()))}); ${IGNORE_SIGTERM_AND_STAY}`);
    setOneShotLimits({ timeoutMs: 300, graceMs: 200 });
    const item = goItem();
    await written(item);
    expectRawSix(item);
    expect(readCardTextRecord(snoozeKey(item))?.reason).toMatch(/時間切れ/);
  }, 30_000);
});
