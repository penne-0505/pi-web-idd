import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

register("./idd-core-alias.loader.mjs", import.meta.url);

const { buildState } = await import("./state.ts");
const { cardPrompt, cardTextDir, cardTextOf, cardTextsIdle, checkCardText, scheduleCardTexts, goMaterial, rawCardText, readCardTextRecord, setCardWriter } = await import("./card-text.ts");
const { snoozeKey } = await import("../../../../lib/idd-ui/snooze.ts");


let dir;

/** a review round as the count holds it, and as the ledger recorded it */
const round = (state, must, should, nit = 0, findings = []) => ({ state, must, should, nit, findings });
const recorded = (state, must, should, sentBack) => ({ kind: "round", state, must, should, ...(sentBack === undefined ? {} : { sentBack }) });

const planned = {
  summary: { situation: "card が内部の語で書かれている", action: "6 欄に揃える", outcome: "開いてすぐ判断できる" },
  decisions: [{ id: "C-7-1", text: "card の文を別の役が書く", why: "導出が model を待たないため" }],
  criteria: [{ id: "AC-001", text: "6 欄が空でない" }],
  purposeProposals: [{ id: "P-new", statement: "判断が 1 画面で済むようにしたい", origin: "計画役" }],
};

const reviewed = {
  state: "reviewed",
  must: 1,
  should: 0,
  nit: 2,
  findings: [{ severity: "must", claim: "購読が残る", path: "a.ts" }],
  rounds: [round("reviewed", 1, 0), round("reviewed", 0, 0, 2)],
  history: [recorded("reviewed", 1, 0, true), recorded("reviewed", 0, 0, false)],
};

const goItem = (extra = {}) => ({
  kind: "go",
  iddId: "IDD-7",
  appearedAt: "2026-10-27T00:00:00Z",
  title: "受信箱の card を読みやすくする",
  depth: "shallow",
  notAuto: "質問が 1 件あったので人に回した",
  planPath: "_docs/plan/Demo/idd-7/plan.md",
  source: { kind: "github", label: "#7", url: "https://github.com/o/r/issues/7" },
  ...planned,
  planReview: reviewed,
  ...extra,
});

/** an answer in the form, citing material names that exist */
const goodAnswer = (over = {}) => JSON.stringify({
  decide: "この計画で実装を始めてよいか？",
  recommend: { pick: 1, sources: ["plan-review"] },
  outcomes: [{ changes: "実装役が起動して実装が始まる" }, { changes: "計画が出し直されるまで実装は始まらない" }],
  facts: [{ source: "plan-summary" }, { source: "lane" }],
  settled: [{ source: "plan-review" }, { source: "depth" }, { source: "not-auto" }, { source: "purposes" }],
  ...over,
});

const AT = "2026-10-27T00:00:00Z";
const lifecycleOf = (events, id = "IDD-1") => events.map(([event, attrs = {}]) => JSON.stringify({ idd_id: id, event, at: AT, attrs })).join("\n");
/** the events of one plan review: ready, started, and done with this verdict */
const reviewRound = (run, verdict) => [["s1_ready", { depth: "deep" }], ["s1_plan_review_started", { run_ids: [run] }], ["s1_plan_review_done", verdict]];
const goLifecycle = (id = "IDD-1") => lifecycleOf([["lane_open"], ...reviewRound("A", { must: 0, should: 0, nit: 0, findings: [] })], id);

/** a writer that answers `answer` and counts its runs */
const countingWriter = (answer = goodAnswer()) => {
  const writer = { calls: 0 };
  setCardWriter(async () => { writer.calls += 1; return { text: answer, model: "x/y" }; });
  return writer;
};

/** schedule the cards and wait for the runs to end */
const written = async (...items) => {
  scheduleCardTexts(items);
  await cardTextsIdle();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idd-card-text-"));
  writeFileSync(join(dir, "roles.yaml"), "models:\n  m: { model: x/y }\nroles:\n  card-writer: { model: m, thinking: low }\npipeline:\n");
  Object.assign(process.env, { IDD_STATE_DIR: dir, IDD_ROLES_FILE: join(dir, "roles.yaml") });
});

afterEach(async () => {
  await cardTextsIdle();
  setCardWriter(null);
  for (const name of ["IDD_STATE_DIR", "IDD_ROLES_FILE"]) delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

describe("the six fields of a GO card", () => {
  it("AC-001: the engine's GO card carries the six fields in order, none empty", () => {
    const card = stateGoCard();
    assert.ok(card?.text);
    assertSix(card.text);
    assert.equal(card.text.by, "raw");
    assert.equal(card.planPath, "_docs/plan/Demo/idd-1/plan.md");
  });

  it("AC-001: a card with the least material still has six non-empty fields", () => {
    assertSix(rawCardText(goMaterial({ kind: "go", iddId: "IDD-1", title: "", decisions: [], criteria: [] })));
  });

  it("AC-005: the settled field carries only what the engine had decided, never a judgment not yet made", () => {
    const material = goMaterial(goItem());
    const text = rawCardText(material);
    const settled = text.settled.map((s) => s.text).join("\n");
    for (const pattern of [/must 1 件/, /浅い/, /質問が 1 件/, /Purpose/]) assert.match(settled, pattern);
    assert.doesNotMatch(settled, /提出の検査|triage|後で直す/);
    assert.deepEqual(material.items.filter((m) => m.settled).map((m) => m.id).sort(), ["depth", "not-auto", "plan-review", "purposes"]);
    // what an agent wrote about itself is never in the settled field
    assert.ok(material.items.filter((m) => m.kind === "self").every((m) => !m.settled));
  });

  it("AC-005: a settled line that cites what is not settled, or a judgment not yet made, is refused", () => {
    const material = goMaterial(goItem());
    const notSettled = checkCardText(goodAnswer({ settled: [{ source: "plan-summary" }, { source: "plan-review" }, { source: "depth" }, { source: "not-auto" }, { source: "purposes" }] }), material);
    assert.equal(notSettled.ok, false);
    assert.match(notSettled.reason, /決めたことではない/);
    // the writer words nothing of the field: a sentence it adds about a judgment not yet made never reaches the card
    const early = checkCardText(goodAnswer({ settled: JSON.parse(goodAnswer()).settled.map((s) => ({ ...s, text: "提出の検査は通る見込みである" })) }), material);
    assert.equal(early.ok, true);
    assert.doesNotMatch(early.text.settled.map((s) => s.text).join("\n"), /提出の検査|triage|後で直す/);
  });

  it("F-3: the review rounds are told as the ledger recorded them; a failed, skipped or unrecorded round is never said to have sent anything back", () => {
    const text = (history) => goMaterial(goItem({ planReview: { state: "reviewed", must: 0, should: 0, nit: 0, findings: [], history } })).items.find((m) => m.id === "plan-review").text;
    const ok = (must, should, sentBack) => recorded("reviewed", must, should, sentBack);
    const failed = recorded("failed", 0, 0);
    const skipped = recorded("skipped", 0, 0);
    const withBack = text([ok(1, 0, true), ok(0, 0, false)]);
    for (const pattern of [/1 巡目 must 1 件・should 0 件、2 巡目 must 0 件・should 0 件/, /1 巡目は計画役に差し戻した/, /2 巡目は差し戻さなかった/]) assert.match(withBack, pattern);
    // nothing is said of a send-back when none was recorded, and a lane with none is never told "none were"
    for (const [history, told] of [
      [[failed, ok(0, 0)], /1 巡目 失敗、2 巡目 must 0 件/],
      [[skipped, failed, ok(0, 1)], /1 巡目 走らなかった、2 巡目 失敗/],
      [[ok(0, 0)], /./],
      [[ok(1, 0), ok(0, 0)], /./],
    ]) {
      const said = text(history);
      assert.match(said, told);
      assert.doesNotMatch(said, /差し戻/);
    }
  });

  it("F-1: a send-back the ledger recorded reaches the GO after it, with the review rounds from before penne's own send-back", () => {
    const verdict = (must, extra = {}) => ({ must, should: 0, nit: 0, findings: [], ...extra });
    const lines = lifecycleOf([
      ["lane_open"],
      ...reviewRound("A", verdict(1, { sent_back: true, findings: [{ severity: "must", claim: "購読が残る", path: "a.ts" }] })),
      ...reviewRound("B", verdict(0)),
      ["s1_revise_requested", {}],
      ...reviewRound("C", verdict(0, { sent_back: false })),
    ]);
    const card = stateGoCard(lines);
    assert.ok(card?.planReview);
    // the rounds the count holds begin at penne's send-back; the history keeps the ones before it
    assert.equal(card.planReview.rounds.length, 1);
    assert.equal(card.planReview.history.length, 4);
    const raw = rawCardText(goMaterial(card)).settled.map((s) => s.text);
    for (const line of [
      "査読は 3 巡: 1 巡目 must 1 件・should 0 件、2 巡目 must 0 件・should 0 件、3 巡目 must 0 件・should 0 件",
      "1 巡目は計画役に差し戻した", "penne が計画の出し直しを指示した", "3 巡目は差し戻さなかった",
    ]) assert.ok(raw.includes(line), line);
    // the second round's record does not say, so nothing is said of it
    assert.ok(!raw.some((l) => l.startsWith("2 巡目は")));
  });

  it("AC-005: the raw settled field carries every line of the review rounds and of the Purpose proposals, not only the first", () => {
    const finding = { severity: "must", claim: "リスクの表が欠けている", path: "plan.md" };
    const rounds = [round("reviewed", 1, 0, 0, [finding]), round("reviewed", 0, 1), { ...round("failed", 0, 0), note: "timeout" }];
    const history = [recorded("reviewed", 1, 0, true), recorded("reviewed", 0, 1, true), recorded("failed", 0, 0)];
    const material = goMaterial(goItem({
      planReview: { state: "reviewed", must: 0, should: 1, nit: 0, findings: [finding], needsReason: true, rounds, history },
      purposeProposals: [
        { id: "P-a", statement: "一つ目の案の文", origin: "計画役" },
        { id: "P-b", statement: "二つ目の案の文", origin: "計画役" },
      ],
    }));
    const raw = rawCardText(material);
    const lines = raw.settled.map((s) => s.text);
    const joined = lines.join("\n");
    for (const pattern of [
      /1 巡目 must 1 件・should 0 件、2 巡目 must 0 件・should 1 件、3 巡目 失敗/, /1 巡目は計画役に差し戻した/, /2 巡目は計画役に差し戻した/,
      /通す理由が要る/, /指摘（must）: リスクの表が欠けている/, /一つ目の案の文/, /二つ目の案の文/,
    ]) assert.match(joined, pattern);
    assert.ok(lines.every((l) => !l.includes("\n") && l.trim()), "one line to an entry");
    assert.ok(raw.settled.every((s) => s.source), "every entry names its material");
    assert.doesNotMatch(joined, /計画役が要約|提出の検査|triage/);
  });

  it("AC-006: words resting on an agent's own account are marked, words from the records are not", () => {
    const material = goMaterial(goItem());
    const raw = rawCardText(material);
    assert.ok(raw.facts.some((f) => f.selfReported), "a fact from the plan's summary is marked");
    assert.ok(raw.facts.some((f) => !f.selfReported), "a fact from the records is not");
    const firstSelf = raw.facts.findIndex((f) => f.selfReported);
    assert.ok(raw.facts.slice(0, firstSelf).every((f) => !f.selfReported), "the records come first");
    const checked = checkCardText(goodAnswer(), material);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.text.facts.map((f) => f.selfReported), [false, true], "the engine puts the records first and decides the mark, not the writer");
    assert.equal(checked.text.recommend.selfReported, false);
    for (const [sources, marked, why] of [
      [["plan-summary"], true, "resting on the plan's summary"],
      [[], true, "a pick with no source is marked, not shown with the records' look"],
      [["plan-summary", "plan-review"], true, "a self-reported source among the records marks it"],
      [["lane"], false, "resting on the records"],
    ]) {
      const r = checkCardText(goodAnswer({ recommend: { pick: 1, sources } }), material);
      assert.equal(r.ok, true);
      assert.equal(r.text.recommend.selfReported, marked, why);
    }
    assert.ok(checked.text.settled.every((s) => !("selfReported" in s)));
  });

  it("keeps every other kind of card as it was", () => {
    assert.equal(cardTextOf({ kind: "storage" }), undefined);
    assert.equal(cardTextOf({ kind: "stuck", iddId: "IDD-1" }), undefined);
  });
});

describe("the form the writer's output must keep", () => {
  const material = () => goMaterial(goItem());
  const refused = (answer, pattern) => {
    const r = checkCardText(typeof answer === "string" ? answer : goodAnswer(answer), material());
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
  };

  it("accepts an answer in the form, wrapped in a code fence too", () => {
    assert.equal(checkCardText(goodAnswer(), material()).ok, true);
    assert.equal(checkCardText(`\`\`\`json\n${goodAnswer()}\n\`\`\``, material()).ok, true);
  });

  it("refuses what is not JSON, an empty field, a question without the question form and too long a sentence", () => {
    refused("申し訳ありません", /JSON/);
    refused({ decide: "実装を始める" }, /問いの形/);
    refused({ decide: `${"あ".repeat(130)}？` }, /超えている/);
  });

  it("refuses a source that is not a name of the material, and a fact with none", () => {
    refused({ facts: [{ source: "web" }] }, /材料の名前に無い/);
    refused({ facts: [] }, /1〜3 件/);
    refused({ facts: ["lane", "plan-summary", "plan-contract", "plan-risk"].map((source) => ({ source })) }, /1〜3 件/);
    refused({ facts: [{ source: "lane" }, { source: "lane" }] }, /同じ材料を 2 度/);
    refused({ recommend: { pick: 1, sources: ["web"] } }, /材料の名前に無い/);
  });

  it("refuses an id with nothing explained beside it, and an id the material does not carry", () => {
    refused({ decide: "C-7-1 でよいか？" }, /番号だけ/);
    refused({ decide: "DEC-99-1 に沿って始めてよいか？" }, /材料に無い番号/);
  });

  it("F-4: an id is accepted only as a whole id the material carries, never as the front of a longer one", () => {
    const withDecide = (decide, item = goItem()) => checkCardText(goodAnswer({ decide }), goMaterial(item));
    const prefix = withDecide("守る契約 C-7（card の文を別の役が書く）に沿って始めてよいか？");
    assert.equal(prefix.ok, false);
    assert.match(prefix.reason, /材料に無い番号 C-7/);
    const longer = withDecide("守る契約 DEC-1（card の文を別の役が書く）に沿って始めてよいか？", goItem({ decisions: [{ id: "DEC-12", text: "card の文を別の役が書く", why: "導出が model を待たないため" }] }));
    assert.equal(longer.ok, false);
    assert.match(longer.reason, /材料に無い番号 DEC-1/);
  });

  it("F-2: the settled field must cite every settled item the card has", () => {
    const only = (...ids) => ids.map((id) => ({ source: id }));
    const check = (item, settled) => checkCardText(goodAnswer({ settled }), goMaterial(item));
    const all = ["plan-review", "depth", "not-auto", "purposes"];
    assert.equal(check(goItem(), only(...all)).ok, true);
    for (const id of all) {
      const r = check(goItem(), only(...all.filter((x) => x !== id)));
      assert.equal(r.ok, false, `without ${id}`);
      assert.match(r.reason, /挙げていない/);
    }
    // a card with only a depth owes only the depth; a card with nothing settled has the plain line
    const recommend = { pick: 1, sources: ["lane"] };
    const lean = (settled, extra) => checkCardText(goodAnswer({ settled, recommend }), goMaterial(goItem({ planReview: undefined, notAuto: undefined, purposeProposals: undefined, ...extra })));
    assert.equal(lean(only("depth")).ok, true);
    const none = lean([], { depth: undefined });
    assert.equal(none.ok, true);
    assert.equal(none.text.settled.length, 1);
    // a material named twice is refused
    const twice = check(goItem(), [...only(...all), ...only("depth")]);
    assert.equal(twice.ok, false);
    assert.match(twice.reason, /同じ材料を 2 度/);
  });

  it("F-2: a fact or a settled entry shows the material's own sentence, whatever the writer adds beside the name", () => {
    const m = goMaterial(goItem());
    const review = m.items.find((x) => x.id === "plan-review");
    const lie = "査読の指摘は無く、問題なし";
    const answer = goodAnswer({ facts: [{ source: "plan-review", text: lie }], settled: JSON.parse(goodAnswer()).settled.map((s) => ({ ...s, text: lie })) });
    const r = checkCardText(answer, m);
    assert.equal(r.ok, true);
    assert.equal(r.text.facts[0].text, review.text);
    assert.match(r.text.facts[0].text, /must 1 件/);
    assert.doesNotMatch(JSON.stringify(r.text), /問題なし/);
    assert.equal(r.text.facts[0].selfReported, false);
    // a settled entry is a line of the material, as the raw field draws it
    assert.deepEqual(r.text.settled.map((s) => s.text), rawCardText(m).settled.map((s) => s.text));
    // a fact drawn from an agent's own account keeps the mark, and its text is the account's first line
    const self = checkCardText(goodAnswer({ facts: [{ source: "plan-contract" }] }), m);
    assert.equal(self.text.facts[0].selfReported, true);
    assert.equal(self.text.facts[0].text, "card の文を別の役が書く（理由: 導出が model を待たないため）");
  });

  it("F-3: a number or a judgment word the question or the option's words do not carry is refused", () => {
    const m = goMaterial(goItem());
    for (const [over, pattern] of [
      [{ decide: "指摘が 3 件残っているが、実装を始めてよいか？" }, /数 3/],
      [{ decide: "深い lane だが、実装を始めてよいか？" }, /「深い」/],
      [{ outcomes: [{ changes: "5 つの実装役が起動する" }, { changes: "計画が出し直される" }] }, /数 5/],
      [{ outcomes: [{ changes: "査読が失敗しても実装が始まる" }, { changes: "計画が出し直される" }] }, /「失敗」/],
    ]) {
      const r = checkCardText(goodAnswer(over), m);
      assert.equal(r.ok, false);
      assert.match(r.reason, pattern);
    }
  });

  it("F-7: the recommendation is a pick and its sources; the reason shown is the materials' own sentence, never the writer's", () => {
    const m = goMaterial(goItem());
    const review = m.items.find((x) => x.id === "plan-review");
    const lane = m.items.find((x) => x.id === "lane");
    const recommend = (over, item = goItem()) => checkCardText(goodAnswer({ recommend: over }), goMaterial(item));
    // a writer that adds its own sentence and basis changes nothing that is shown
    const added = recommend({ pick: 1, sources: ["plan-review"], text: "指摘なし・作業完了なので GO を推す", basis: "実測" });
    assert.equal(added.ok, true);
    assert.equal(added.text.recommend.text, `『GO』を推す。\n${review.text}`);
    assert.equal(added.text.recommend.basis, "記録");
    assert.doesNotMatch(JSON.stringify(added.text), /作業完了/);
    // a material that has must findings is shown with them, whatever the writer would have said
    assert.match(added.text.recommend.text, /must 1 件/);
    // two sources at most, the second option by its number
    const two = recommend({ pick: 2, sources: ["plan-review", "lane"] });
    assert.equal(two.text.recommend.text, `『計画を直させる』を推す。\n${review.text}\n${lane.text}`);
    assert.equal(recommend({ pick: 1, sources: ["plan-review", "lane", "depth"] }).ok, false);
    assert.match(recommend({ pick: 1, sources: ["lane", "lane"] }).reason, /同じ材料を 2 度/);
    // no source: a guess the engine words and marks
    const guess = recommend({ pick: 1, sources: [] });
    assert.equal(guess.text.recommend.text, "『GO』を推すが、根拠にした材料を挙げていない推測で、確かめていない");
    assert.deepEqual([guess.text.recommend.basis, guess.text.recommend.selfReported], ["推測", true]);
    // an agent's own account alone is a guess, and marked
    const self = recommend({ pick: 1, sources: ["plan-summary"] });
    assert.deepEqual([self.text.recommend.basis, self.text.recommend.selfReported], ["推測", true]);
    assert.equal(self.text.recommend.text, `『GO』を推す。\n${m.items.find((x) => x.id === "plan-summary").text.split("\n")[0]}`);
    // no pick: the same words as the raw fields
    const none = recommend({ pick: null, sources: ["plan-review"] });
    assert.equal(none.ok, true);
    assert.deepEqual(none.text.recommend, rawCardText(m).recommend);
    // a pick outside the options, not a number, or a source that is no material is refused
    for (const [over, pattern] of [
      [{ pick: 0, sources: [] }, /推奨の番号/],
      [{ pick: 3, sources: [] }, /推奨の番号/],
      [{ pick: 1.5, sources: [] }, /推奨の番号/],
      [{ pick: "1", sources: [] }, /推奨の番号/],
      [{ sources: ["lane"] }, /推奨の番号/],
      [{ pick: 1, sources: ["web"] }, /材料の名前に無い/],
      [{ pick: 1, sources: "lane" }, /配列ではない/],
      ["GO を推す", /推奨/],
    ]) {
      const r = recommend(over);
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.match(r.reason, pattern);
    }
  });

  it("refuses an answer that does not give a sentence for every option", () => {
    refused({ outcomes: [{ changes: "始まる" }] }, /選択肢の数/);
  });

  it("takes the reach and reversibility of each option from the engine, not from the writer", () => {
    const ok = checkCardText(goodAnswer({ outcomes: [{ changes: "始まる", reaches: "全世界", reversible: "戻せない" }, { changes: "戻る" }] }), material());
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.text.outcomes.map((o) => [o.reaches, o.reversible]), [["この lane だけ", "手間はかかるが戻せる"], ["この lane だけ", "戻せる"]]);
  });

  it("F-6: the prompt states the limits the check holds the writer to", () => {
    const p = cardPrompt(material());
    assert.match(p, /decide は 120 文字まで/);
    assert.match(p, /160 文字まで/);
    const fits = (decide, changes) => checkCardText(goodAnswer({ decide, outcomes: [{ changes }, { changes: "計画が出し直される" }] }), material());
    assert.equal(fits(`${"あ".repeat(119)}？`, "あ".repeat(160)).ok, true);
    assert.match(fits(`${"あ".repeat(120)}？`, "あ").reason, /120 文字を超えている/);
    assert.match(fits("この計画で実装を始めてよいか？", "あ".repeat(161)).reason, /160 文字を超えている/);
  });

  it("the prompt names every source and marks the self-reported ones", () => {
    const p = cardPrompt(material());
    assert.match(p, /\[plan-summary\] 計画役の要約（自己申告）/);
    assert.match(p, /\[plan-review\] 計画の査読の結果（記録・決まったこと）/);
  });
});

describe("when the words are written", () => {
  const key = () => snoozeKey(goItem());

  it("AC-002: the answer does not wait for the writer, and the card is read from the record once it is written", async () => {
    let release;
    let calls = 0;
    setCardWriter(() => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve({ text: goodAnswer(), model: "x/y" }); });
    });
    scheduleCardTexts([goItem()]);
    // the writer is running and has not answered: the card is read at once, from the raw material
    assert.equal(cardTextOf(goItem()).by, "raw");
    assert.equal(readCardTextRecord(key()), null);
    assert.equal(calls, 1);
    release();
    await cardTextsIdle();
    assert.equal(cardTextOf(goItem()).by, "translated");
    assert.equal(cardTextOf(goItem()).decide, "この計画で実装を始めてよいか？");
  });

  it("AC-002: building the state never runs the writer", () => {
    const writer = countingWriter();
    mkdirSyncBacklog();
    buildState();
    assert.equal(writer.calls, 0);
  });

  it("AC-004: the same card is written once, and reading it again gives the same words", async () => {
    const writer = countingWriter();
    scheduleCardTexts([goItem()]);
    await written(goItem());
    await written(goItem());
    assert.equal(writer.calls, 1);
    assert.deepEqual(cardTextOf(goItem()), cardTextOf(goItem()));
    assert.equal(readdirSync(cardTextDir()).length, 1);
  });

  it("AC-004: a card whose material changed is written again, and one whose material did not is not", async () => {
    const writer = countingWriter();
    await written(goItem());
    // the base moved under the card: not part of what the writer is given
    await written(goItem({ baseAdvance: { to: "abc", files: [], more: 0, known: true }, snoozedUntil: "2026-10-28T00:00:00Z" }));
    assert.equal(writer.calls, 1);
    await written(goItem({ title: "題が変わった" }));
    assert.equal(writer.calls, 2);
  });

  it("AC-003: a writer that fails leaves the card with the raw six fields and the reason on record", async () => {
    setCardWriter(async () => { throw new Error("provider 429"); });
    await written(goItem());
    const text = cardTextOf(goItem());
    assertSix(text);
    assert.equal(text.by, "raw");
    const record = readCardTextRecord(key());
    assert.equal(record.by, "raw");
    assert.match(record.reason, /訳す役が失敗した.*provider 429/);
  });

  it("AC-003: an output outside the form leaves no sentence of it on the card, and the reason on record", async () => {
    const sentence = "これは型を外れた文";
    countingWriter(goodAnswer({ decide: sentence }));
    await written(goItem());
    const text = cardTextOf(goItem());
    assertSix(text);
    assert.equal(text.by, "raw");
    assert.doesNotMatch(JSON.stringify(text), new RegExp(sentence));
    assert.doesNotMatch(JSON.stringify(text), /この計画で実装を始めてよいか？/);
    assert.match(readCardTextRecord(key()).reason, /出力が型を外れた.*問いの形/);
    // not written again for the same material
    const again = countingWriter();
    await written(goItem());
    assert.equal(again.calls, 0);
  });

  it("AC-003: without a card-writer role no run starts, nothing is recorded and the card still has six fields", async () => {
    writeFileSync(join(dir, "roles.yaml"), "models:\n  m: { model: x/y }\nroles:\n  r: { model: m }\npipeline:\n");
    const writer = countingWriter();
    await written(goItem());
    assert.equal(writer.calls, 0);
    assert.equal(existsSync(cardTextDir()), false);
    assertSix(cardTextOf(goItem()));
  });

  it("the writer is given only this card's material, and no more than two run at once", async () => {
    const prompts = [];
    let live = 0;
    let most = 0;
    setCardWriter(async (prompt) => {
      prompts.push(prompt);
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return { text: goodAnswer(), model: "x/y" };
    });
    await written(goItem({ iddId: "IDD-7", title: "一つ目の依頼" }), goItem({ iddId: "IDD-8", title: "二つ目の依頼" }), goItem({ iddId: "IDD-9", title: "三つ目の依頼" }));
    assert.equal(prompts.length, 3);
    assert.ok(most <= 2);
    const first = prompts.find((p) => p.includes("一つ目の依頼"));
    assert.doesNotMatch(first, /二つ目の依頼|三つ目の依頼/);
    assert.ok(readFileSync(join(dir, "roles.yaml"), "utf8").includes("card-writer"));
  });
});

function assertSix(text) {
  assert.ok(text.decide.trim());
  assert.ok(text.recommend.text.trim());
  assert.ok(text.outcomes.length > 0 && text.outcomes.every((o) => o.option && o.changes.trim() && o.reaches && o.reversible));
  assert.ok(text.facts.length >= 1 && text.facts.length <= 3 && text.facts.every((f) => f.text.trim() && f.source));
  assert.ok(text.settled.length >= 1 && text.settled.every((s) => s.text.trim()));
  assert.ok(text.links.length >= 1 && text.links.every((l) => l.label && l.path));
}

/** one lane in the state directory: its backlog row and the lifecycle events given */
function mkdirSyncBacklog(lifecycle = goLifecycle()) {
  const row = { idd_id: "IDD-1", parent_id: null, created_at: AT, linear_issue_url: null, gh_issue_url: null, pull_req_url: null, source_type: "github", context: "", title: "T", area: "Demo" };
  for (const [name, body] of [["backlog.jsonl", JSON.stringify(row)], ["lifecycle-Demo.jsonl", lifecycle]]) writeFileSync(join(dir, name), `${body}\n`);
}

/** the GO card the engine derives for that lane */
function stateGoCard(lifecycle) {
  mkdirSyncBacklog(lifecycle);
  return buildState().items.find((i) => i.kind === "go");
}

const routedRow = (over = {}) => ({
  idd_id: "IDD-7", batch_id: "B-1", question_id: "q1", answered_at: AT, selection: { index: 1, label: "type(scope) の形" },
  reason: "規範で決まる", notes: null, answered_by: "router", router: { role: "question-router", model: "x/y" },
  basis: [{ source: "choice", ref: "C-1-1", field: "anchored", quote: "件名は type(scope): 一文 の形で書く" }], ...over,
});

/** a translator's settled lines that cite the material `source` among the usual ones */
const citing = (source) => ["plan-review", "depth", "not-auto", source, "purposes"].map((s) => ({ source: s }));
/** the translator that cites the material is taken, and the one that leaves it out is refused with `why` */
function assertLeftOutRefused(material, source, why) {
  const cited = citing(source);
  assert.equal(checkCardText(goodAnswer({ settled: cited }), material).ok, true);
  const left = checkCardText(goodAnswer({ settled: cited.filter((s) => s.source !== source) }), material);
  assert.equal(left.ok, false);
  assert.match(left.reason, why);
}

describe("what the mechanism answered, on the GO card", () => {
  const put = (answers) => {
    writeFileSync(join(dir, "pending-questions.jsonl"), `${JSON.stringify({ idd_id: "IDD-7", batch_id: "B-1", asked_at: AT, questions: [
      { question_id: "q1", question: "件名の形はどうしますか", context: "", options: [{ index: 1, label: "type(scope) の形" }, { index: 2, label: "自由" }] },
      { question_id: "q2", question: "範囲を広げますか", context: "", options: [{ index: 1, label: "広げる" }, { index: 2, label: "広げない" }] },
    ] })}\n`);
    writeFileSync(join(dir, "pending-answers.jsonl"), answers.map((a) => JSON.stringify(a)).join("\n") + "\n");
  };

  it("AC-002: each answer is a settled line with the question, the answer, the record it quoted and the quoted sentence", () => {
    put([routedRow(), routedRow({ question_id: "q2", selection: { index: 2, label: "広げない" }, basis: [{ source: "issue", ref: "", quote: "範囲は計画役の質問だけにする" }] })]);
    const material = goMaterial(goItem());
    const item = material.items.find((m) => m.id === "mechanism-answers");
    assert.ok(item?.settled, "the answers are material the engine had decided");
    const lines = rawCardText(material).settled.map((s) => s.text).filter((t) => t.startsWith("仕組みが代わりに答えた"));
    assert.equal(lines.length, 2);
    for (const word of ["件名の形はどうしますか", "type\\(scope\\) の形", "Choice C-1-1 の anchored", "件名は type\\(scope\\): 一文 の形で書く"]) assert.match(lines[0], new RegExp(word));
    for (const word of ["範囲を広げますか", "広げない", "Issue の本文", "範囲は計画役の質問だけにする"]) assert.match(lines[1], new RegExp(word));
  });

  it("AC-002: a long question, answer and quote are shown whole, not cut short", () => {
    const long = (w) => `${w}の文`.repeat(60);
    const quote = long("引用");
    const answer = long("答え");
    put([routedRow({ selection: { index: 1, label: answer }, basis: [{ source: "choice", ref: "C-1-1", field: "why", quote }] })]);
    const batch = JSON.parse(readFileSync(join(dir, "pending-questions.jsonl"), "utf8"));
    const question = long("質問");
    batch.questions[0].question = question;
    writeFileSync(join(dir, "pending-questions.jsonl"), `${JSON.stringify(batch)}\n`);
    const line = rawCardText(goMaterial(goItem())).settled.map((s) => s.text).find((t) => t.startsWith("仕組みが代わりに答えた"));
    for (const whole of [question, answer, quote]) assert.ok(line.includes(whole), "the whole text is on the line");
    assert.doesNotMatch(line, /…/);
  });

  it("AC-002: a person's answer is not listed as the mechanism's, and a lane with none has no such material", () => {
    put([routedRow({ answered_by: undefined, router: undefined, basis: undefined })]);
    assert.equal(goMaterial(goItem()).items.some((m) => m.id === "mechanism-answers"), false);
  });

  it("AC-002: the translator names the material and the quoted sentence reaches the card unchanged; leaving it out is refused", () => {
    put([routedRow()]);
    const material = goMaterial(goItem());
    const cited = citing("mechanism-answers");
    const ok = checkCardText(goodAnswer({ settled: cited }), material);
    assert.equal(ok.ok, true, ok.reason);
    assert.ok(ok.text.settled.some((s) => s.text.includes("件名は type(scope): 一文 の形で書く") && s.source === "仕組みが代わりに答えた計画役の質問"));
    // a sentence the translator adds about an answer is never read
    const added = checkCardText(goodAnswer({ settled: cited.map((s) => ({ ...s, text: "仕組みが任意の答えを決めた" })) }), material);
    assert.doesNotMatch(added.text.settled.map((s) => s.text).join("\n"), /任意の答え/);
    assertLeftOutRefused(material, "mechanism-answers", /仕組みが代わりに答えた計画役の質問/);
  });

  it("AC-002: the answers reach the prompt, so the translator can name them", () => {
    put([routedRow()]);
    assert.match(cardPrompt(goMaterial(goItem())), /\[mechanism-answers\] 仕組みが代わりに答えた計画役の質問（記録・決まったこと）/);
  });

  it("AC-002: every answer the mechanism gave is listed with its question, answer and quote", () => {
    const many = Array.from({ length: 10 }, (_, i) => routedRow({ question_id: `q${i}` }));
    const asked = many.map((a) => ({ question_id: a.question_id, question: `質問 ${a.question_id}`, context: "", options: [{ index: 1, label: "案" }] }));
    writeFileSync(join(dir, "pending-questions.jsonl"), `${JSON.stringify({ idd_id: "IDD-7", batch_id: "B-1", asked_at: AT, questions: asked })}\n`);
    writeFileSync(join(dir, "pending-answers.jsonl"), many.map((a) => JSON.stringify(a)).join("\n") + "\n");
    const lines = goMaterial(goItem()).items.find((m) => m.id === "mechanism-answers").text.split("\n");
    assert.equal(lines.length, 10);
    for (const [i, line] of lines.entries()) assert.match(line, /質問「.*」の答えは「.*」（引いた記録と文: .*件名は type\(scope\): 一文 の形で書く/, `row ${i}`);
  });
});

describe("what could not be read of the mechanism's answers, on the GO card", () => {
  const unconfirmed = () => goMaterial(goItem()).items.find((m) => m.id === "mechanism-unconfirmed");

  it("AC-001: a column that cannot be opened puts 'not confirmed' among the settled lines, and no column at all does not", () => {
    // no column is there yet: nothing was answered, and that is not a fault
    assert.equal(unconfirmed(), undefined);
    // the answers' column is a directory: it cannot be opened as the column it is
    mkdirSync(join(dir, "pending-answers.jsonl"));
    const material = goMaterial(goItem());
    const item = unconfirmed();
    assert.ok(item?.settled, "it is material the engine decided");
    assert.match(item.text, /確認が済んでいない/);
    assert.match(item.text, /答えの列/);
    assert.doesNotMatch(item.text, /質問の列/);
    assert.ok(rawCardText(material).settled.some((s) => /確認が済んでいない/.test(s.text)), "and the card says it");
    // the translator may not leave it out
    assertLeftOutRefused(material, "mechanism-unconfirmed", /仕組みの答えの確認が済んでいないこと/);
  });

  it("AC-001: the questions' column that cannot be read is named, a row of the mechanism that cannot be shaped is named and does not stop the card, and a readable column brings the card back", () => {
    mkdirSync(join(dir, "pending-questions.jsonl"));
    assert.match(unconfirmed().text, /質問の列/);
    rmSync(join(dir, "pending-questions.jsonl"), { recursive: true, force: true });
    writeFileSync(join(dir, "pending-answers.jsonl"), JSON.stringify(routedRow({ selection: undefined })) + "\n");
    assert.match(unconfirmed().text, /形が不正/);
    writeFileSync(join(dir, "pending-answers.jsonl"), "");
    assert.equal(unconfirmed(), undefined);
  });
});
