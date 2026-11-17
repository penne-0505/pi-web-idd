import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readRoutedDecisions, routedUnconfirmedLine, stateDir } from "@idd/core";
import type { RoutedDecision } from "@idd/core";
import { pipelineAgentDir, resolveRole, type RolePreset } from "@idd/lane";

import { snoozeKey } from "../../../../lib/idd-ui/snooze.ts";
import type { CardText, GoItem, InboxItem } from "../../../../lib/idd-ui/types.ts";
import { prepareAgentDirAsync } from "./agent-dir-prep.ts";
import type { PiUsage } from "./conversation-events.ts";
import { buildOneShotArgs, parseTitleOutput, recordUsageCost, runPiOnce } from "./conversation-title.ts";

/*
 * The words a card is read by (`_docs/standards/human-facing.md`).
 *
 * A card's six fields are written once, when the card first comes to the inbox, by a separate role (`card-writer`)
 * in a one-shot `pi` run, and kept in a record under the state directory. The state derivation only reads that
 * record: it never waits for the run, so it answers the same to the same input, and a card with no record yet (or
 * whose run failed, or whose output broke the form) is shown with the six fields the engine puts together from the
 * raw material. Nothing the writer says reaches a card unless it passed the checks below.
 */

/** the role that writes the words; a roles.yaml without it still shows every card, with the raw fields */
export const CARD_TEXT_ROLE = "card-writer";

/** how many writer runs go at once */
const MAX_CONCURRENT = 2;

const MAX_FACTS = 3;
const MAX_RECOMMEND_SOURCES = 2;
const MAX_CHARS = { decide: 120, changes: 160 };

/** one thing the writer may rest a sentence on; `id` is the name it cites and the engine checks against */
export interface MaterialItem {
  id: string;
  /** what the card shows beside a fact taken from this item */
  label: string;
  /**
   * `record`: what the engine's records say (lifecycle events, the plan review's verdict, the engine's own
   * decisions). `self`: what an agent wrote about its own work (a plan's summary and contract); it is never shown
   * with the same face as a record
   */
  kind: "record" | "self";
  /** decided by the engine before the card was made: the only items the "もう決まっていること" field may cite */
  settled: boolean;
  text: string;
}

export interface MaterialOption {
  label: string;
  /** what the engine does when this option is chosen */
  effect: string;
  reaches: string;
  reversible: string;
}

export interface CardMaterial {
  kind: "go";
  title: string;
  question: string;
  items: MaterialItem[];
  options: MaterialOption[];
  links: { label: string; path: string }[];
}

// ---------------------------------------------------------------- material

const DEPTH_WORD = { shallow: "浅い", standard: "標準", deep: "深い" } as const;

const cut = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text);

type ReviewHistory = NonNullable<NonNullable<GoItem["planReview"]>["history"]>;

/**
 * what the ledger recorded of the reviews, in order: each round as it ended, and each send-back the review itself
 * recorded or penne asked for. Nothing is inferred from the number of rounds: a round whose record does not say
 * whether it sent the plan back, and a failed or skipped one, is told as that and says nothing of a send-back.
 */
function reviewRoundLines(history: ReviewHistory): string[] {
  const rounds = history.flatMap((h) => (h.kind === "round" ? [h] : []));
  const lines: string[] = [];
  if (rounds.length >= 2) {
    const each = rounds.map((r, i) =>
      r.state === "reviewed" ? `${i + 1} 巡目 must ${r.must} 件・should ${r.should} 件` : r.state === "failed" ? `${i + 1} 巡目 失敗` : `${i + 1} 巡目 走らなかった`,
    );
    lines.push(`査読は ${rounds.length} 巡: ${each.join("、")}`);
  }
  let n = 0;
  for (const h of history) {
    if (h.kind === "revise") {
      lines.push("penne が計画の出し直しを指示した");
      continue;
    }
    n += 1;
    if (h.state === "reviewed" && h.sentBack !== undefined) lines.push(h.sentBack ? `${n} 巡目は計画役に差し戻した` : `${n} 巡目は差し戻さなかった`);
  }
  return lines;
}

/** where a quote was found, as the card names it: the record, and for a Choice the field */
function basisPlace(b: RoutedDecision["basis"][number]): string {
  if (b.source === "choice") return `Choice ${b.ref} の ${b.field ?? "欄"}`;
  if (b.source === "norm") return `規範 ${b.ref}`;
  return "Issue の本文";
}

/**
 * The questions the mechanism answered in a person's place, one line each: the question, the answer, the record it
 * quoted and the quoted sentence. The sentences are the engine's, read from the answer's own row (the quote is one the
 * engine found in the material), so the translator names this material and never rewords an answer or a quote.
 */
function mechanismAnswerLines(decisions: RoutedDecision[]): string[] {
  // every answer gets its row, and the row is whole: a person confirms each one before the GO, so a count in place of
  // a row, or a question, an answer or a quote cut short, would hide the part the person has to check it against
  return decisions.map((d) => {
    const basis = d.basis.map((b) => `${basisPlace(b)}「${b.quote}」`).join("、");
    // the lines of a long question are joined, not cut: one answer stays one entry
    const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
    return `仕組みが代わりに答えた: 質問「${oneLine(d.question)}」の答えは「${oneLine(d.answer)}」（引いた記録と文: ${basis}）`;
  });
}

/** the material of a GO card: only what the card already carries, never another lane's or another card's */
export function goMaterial(item: GoItem): CardMaterial {
  const items: MaterialItem[] = [];
  const decided = (id: string, label: string, text: string) => items.push({ id, label, kind: "record", settled: true, text });
  const selfReport = (id: string, label: string, text: string) => items.push({ id, label, kind: "self", settled: false, text });
  const review = item.planReview;
  if (review) {
    const lines =
      review.state === "reviewed"
        ? [
          `計画の査読の結果: 指摘は must ${review.must} 件・should ${review.should} 件・nit ${review.nit} 件`,
          ...reviewRoundLines(review.history ?? []),
          ...(review.needsReason ? ["最後の査読でも指摘が残っているので、GO を押すには通す理由が要る"] : []),
          ...review.findings.slice(0, 3).map((f) => `指摘（${f.severity}）: ${cut(f.claim, 120)}`),
        ]
        : review.state === "failed"
          ? [`計画の査読は失敗して結果が無い${review.note ? `（${cut(review.note, 120)}）` : ""}`]
          : [`計画の査読は走らなかった${review.note ? `（${cut(review.note, 120)}）` : ""}`];
    decided("plan-review", "計画の査読の結果", lines.join("\n"));
  }
  if (item.depth) {
    decided("depth", "この lane の深さ", `この lane の深さ: ${DEPTH_WORD[item.depth]}`);
  }
  if (item.notAuto) {
    decided("not-auto", "自動 GO にしなかった理由", `自動 GO にしなかった理由: ${cut(item.notAuto, 200)}`);
  }
  // one reading says both what was answered and what could not be read: "none" and "could not read" are not the same
  // empty list, so a day the columns cannot be read does not make the card quieter
  const read = readRoutedDecisions(item.iddId);
  if (read.decisions.length) {
    decided("mechanism-answers", "仕組みが代わりに答えた計画役の質問", mechanismAnswerLines(read.decisions).join("\n"));
  }
  if (read.unreadable.length) {
    decided("mechanism-unconfirmed", "仕組みの答えの確認が済んでいないこと", routedUnconfirmedLine(read.unreadable));
  }
  if (item.purposeProposals?.length) {
    decided("purposes", "同じ GO で確かめる Purpose の案", `この GO を押すと、次の Purpose の案を同じ記録で確かめたことになる:\n${item.purposeProposals.map((p) => `- ${cut(p.statement, 160)}`).join("\n")}`);
  }
  items.push({ id: "lane", label: "この lane の依頼", kind: "record", settled: false, text: `依頼の題: ${item.title}${item.source ? `（${item.source.label}）` : ""}` });
  if (item.summary) {
    selfReport("plan-summary", "計画役の要約", `状況: ${cut(item.summary.situation, 200)}\nやること: ${cut(item.summary.action, 200)}\n結果: ${cut(item.summary.outcome, 200)}`);
  }
  if (item.decisions.length) {
    selfReport("plan-contract", "計画役が書いた守る契約", item.decisions.slice(0, 8).map((d) => `- ${d.id}: ${cut(d.text, 120)}${d.why ? `（理由: ${cut(d.why, 160)}）` : ""}`).join("\n"));
  }
  if (item.criteria.length) {
    selfReport("plan-criteria", "計画役が書いた受け入れ条件", item.criteria.slice(0, 10).map((c) => `- ${c.id}: ${cut(c.text, 140)}`).join("\n"));
  }
  if (item.riskTable?.length) {
    selfReport("plan-risk", "計画役が答えた Risk の表", item.riskTable.map((r) => `- ${r.label}: ${cut(r.reason, 120)}`).join("\n"));
  }
  const links: CardMaterial["links"] = [];
  if (item.source) links.push({ label: item.source.label, path: item.source.url ?? item.source.label });
  if (item.planPath) links.push({ label: "計画", path: item.planPath });
  // the sixth field is never empty: the panel beside the card always has the plan
  if (!links.length) links.push({ label: "右のパネル（スペースキーで計画を読む）", path: "右のパネル" });
  return {
    kind: "go",
    title: item.title,
    question: `「${item.title}」の計画で実装を始めてよいか？`,
    items,
    options: [
      {
        label: "GO",
        effect: `実装役が起動し、この lane の worktree で計画の通りに実装を始める。push と PR は、実装の後の提出前確認の署名まで起きない${item.purposeProposals?.length ? "。上に挙げた Purpose の案はこの押下で確かめた記録になる" : ""}`,
        reaches: "この lane だけ",
        reversible: "手間はかかるが戻せる",
      },
      {
        label: "計画を直させる",
        effect: "書いた指示を計画役に渡し、計画を出し直させる。実装は始まらず、出し直された計画の GO を改めて待つ",
        reaches: "この lane だけ",
        reversible: "戻せる",
      },
    ],
    links,
  };
}

/** a fingerprint of everything the writer is given: the same material is never written twice */
export function materialHash(material: CardMaterial): string {
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- the raw fields

const NOTHING_SETTLED = "この時点で、判断しなくてよいと決まっていることは記録に無い";

/** the recommendation when none can be made: the raw fields say it, and so does a writer that returns `pick: null` */
const NO_RECOMMEND: CardText["recommend"] = {
  text: "記録だけからは推奨を作れない（確かめていない）。計画の査読の結果と計画の内容を読んで決める",
  basis: "推測",
  selfReported: false,
};

/** the sentence a fact shows for a material: a record as it stands, an agent's own account by its first line without its id; the writer never words it */
function factTextOf(m: MaterialItem): string {
  return m.kind === "record" ? m.text : m.text.split("\n")[0].replace(/^- [^:]*: /, "");
}

/** every line of a settled material, one line to an entry (the screen draws one entry to a line) */
function settledEntriesOf(m: MaterialItem): { text: string; source: string }[] {
  return m.text.split("\n").filter((line) => line.trim()).map((line) => ({ text: line, source: m.label }));
}

/** the six fields put together from the raw material alone: no model, same answer for the same input. The fifth field carries every line of what was decided, not just its first */
export function rawCardText(material: CardMaterial): CardText {
  const facts: CardText["facts"] = [];
  // the records come first; what an agent wrote about its own work comes after, marked. What the engine had already
  // decided is the fifth field's, so it is not told twice
  for (const m of material.items.filter((x) => x.kind === "record" && !x.settled)) {
    facts.push({ text: factTextOf(m), source: m.label, selfReported: false });
  }
  for (const m of material.items.filter((x) => x.kind === "self")) {
    facts.push({ text: factTextOf(m), source: m.label, selfReported: true });
  }
  const settled = material.items.filter((m) => m.settled).flatMap(settledEntriesOf);
  return {
    decide: material.question,
    recommend: { ...NO_RECOMMEND },
    outcomes: material.options.map((o) => ({ option: o.label, changes: o.effect, reaches: o.reaches, reversible: o.reversible })),
    facts: facts.slice(0, MAX_FACTS),
    settled: settled.length ? settled : [{ text: NOTHING_SETTLED, source: "記録" }],
    links: material.links,
    by: "raw",
  };
}

// ---------------------------------------------------------------- the checks

export type CardTextCheck = { ok: true; text: CardText } | { ok: false; reason: string };

/** an internal id such as DEC-12-3, C-239-1, AC-002, P-15 or IDD-239 */
const ID_PATTERN = /\b(?:DEC|INV|AC|QA|IDD|[CFPQ])-[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g;

function plainString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} が文字列ではない`);
  const text = value.trim();
  if (!text) throw new Error(`${field} が空`);
  if (text.length > max) throw new Error(`${field} が ${max} 文字を超えている（${text.length}）`);
  return text;
}

/** an id may appear only with an explanation beside it, and only an id the material itself carries (the whole id) */
function checkIds(text: string, material: CardMaterial, field: string): void {
  const ids = text.match(ID_PATTERN) ?? [];
  if (!ids.length) return;
  const known = new Set(material.items.flatMap((m) => m.text.match(ID_PATTERN) ?? []));
  for (const id of ids) if (!known.has(id)) throw new Error(`${field} が材料に無い番号 ${id} を書いている`);
  const rest = text.replace(ID_PATTERN, "").replace(/[\s、。，．,.()（）「」『』・:：;；\-–—]/g, "");
  if (rest.length < 6 * ids.length) throw new Error(`${field} が番号だけで中身を表している`);
}

/** words that judge a result or a depth; a sentence that says one must stand on a material sentence that says it too */
const JUDGMENT_WORDS: { word: string; pattern: RegExp }[] = [
  ...["must", "should", "nit"].map((word) => ({ word, pattern: new RegExp(`\\b${word}\\b`, "i") })),
  ...["浅い", "標準", "深い", "失敗", "走らなかった", "通す理由", "差し戻"].map((word) => ({ word, pattern: new RegExp(word) })),
];

const numbersOf = (text: string): string[] => text.normalize("NFKC").replace(ID_PATTERN, " ").match(/\d+/g) ?? [];

/**
 * A sentence rests on the material sentence it cites: each number in it is one the basis has, and each judgment word
 * in it is one the basis says too. This stops a count or a verdict the material contradicts; it cannot tell a reversed
 * claim that uses the same numbers and words.
 */
function checkGrounded(text: string, basis: string, field: string): void {
  const have = new Set(numbersOf(basis));
  for (const n of numbersOf(text)) if (!have.has(n)) throw new Error(`${field} の数 ${n} が、根拠にした材料の文に無い`);
  const normalized = basis.normalize("NFKC");
  for (const { word, pattern } of JUDGMENT_WORDS) {
    if (pattern.test(text.normalize("NFKC")) && !pattern.test(normalized)) throw new Error(`${field} の「${word}」が、根拠にした材料の文に無い`);
  }
}

function sourcesOf(value: unknown, material: CardMaterial, field: string): MaterialItem[] {
  if (!Array.isArray(value)) throw new Error(`${field} の出典が配列ではない`);
  return value.map((id) => {
    const found = typeof id === "string" ? material.items.find((m) => m.id === id) : undefined;
    if (!found) throw new Error(`${field} の出典 ${JSON.stringify(id)} は渡した材料の名前に無い`);
    return found;
  });
}

/**
 * The recommendation is chosen, not written: the writer gives the number of the option it picks and the materials it
 * rests on, and the sentence shown is the option's name with the materials' own sentences. So no reason the material
 * does not give, or contradicts, can reach the card. The basis and the mark are the engine's: a pick that names no
 * material is a guess, and a pick resting only on what an agent wrote about itself is marked as that.
 */
function recommendOf(value: unknown, material: CardMaterial): CardText["recommend"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("推奨がオブジェクトでない");
  const rec = value as Record<string, unknown>;
  if (rec.pick === null) return { ...NO_RECOMMEND };
  const pick = rec.pick;
  if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 1 || pick > material.options.length) {
    throw new Error(`推奨の番号 ${JSON.stringify(pick)} が、選択肢の番号（1〜${material.options.length}）でも null でもない`);
  }
  const sources = sourcesOf(rec.sources ?? [], material, "推奨");
  if (sources.length > MAX_RECOMMEND_SOURCES) throw new Error(`推奨の出典が ${MAX_RECOMMEND_SOURCES} 件を超えている`);
  if (new Set(sources.map((m) => m.id)).size !== sources.length) throw new Error("推奨が、同じ材料を 2 度挙げている");
  const label = material.options[pick - 1].label;
  if (!sources.length) {
    return { text: `『${label}』を推すが、根拠にした材料を挙げていない推測で、確かめていない`, basis: "推測", selfReported: true };
  }
  const onRecord = sources.some((m) => m.kind === "record");
  return {
    text: [`『${label}』を推す。`, ...sources.map(factTextOf)].join("\n"),
    basis: onRecord ? "記録" : "推測",
    selfReported: sources.some((m) => m.kind === "self"),
  };
}

function parseJsonObject(raw: string): unknown {
  const fenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("JSON の object が無い");
  return JSON.parse(fenced.slice(start, end + 1));
}

/**
 * The writer's answer, checked against the form and against the material it was given. Anything outside the form
 * makes the whole answer unusable (no sentence of it reaches the card); the reason is what is kept.
 * What the checks decide, not the writer: which items are the agent's own words (the mark), the options and what
 * they reach and whether they can be undone, the order of the facts, and the links.
 */
export function checkCardText(raw: string, material: CardMaterial): CardTextCheck {
  try {
    const out = parseJsonObject(raw) as Record<string, unknown>;
    const decide = plainString(out.decide, "決めること", MAX_CHARS.decide);
    if (!/[？?]$/.test(decide)) throw new Error("決めることが問いの形（？で終わる）になっていない");
    checkIds(decide, material, "決めること");
    checkGrounded(decide, material.question, "決めること");

    const recommend = recommendOf(out.recommend, material);

    if (!Array.isArray(out.outcomes) || out.outcomes.length !== material.options.length) {
      throw new Error(`選ぶと何が起きるかが選択肢の数（${material.options.length}）と合わない`);
    }
    const outcomes = material.options.map((o, i) => {
      const changes = plainString((out.outcomes as Record<string, unknown>[])[i]?.changes, `選択肢「${o.label}」の何が変わるか`, MAX_CHARS.changes);
      checkIds(changes, material, `選択肢「${o.label}」`);
      checkGrounded(changes, [o.effect, o.reaches, o.reversible].join("\n"), `選択肢「${o.label}」`);
      return { option: o.label, changes, reaches: o.reaches, reversible: o.reversible };
    });

    // the facts and the settled field are chosen, not written: the writer names the materials, and the sentence shown is
    // the material's own, so no sentence of the writer's can state what the material does not
    if (!Array.isArray(out.facts) || out.facts.length < 1 || out.facts.length > MAX_FACTS) throw new Error(`判断に要る事実が 1〜${MAX_FACTS} 件でない`);
    const factSources = (out.facts as Record<string, unknown>[]).map((f, i) => sourcesOf([f?.source], material, `事実 ${i + 1}`)[0]);
    if (new Set(factSources.map((m) => m.id)).size !== factSources.length) throw new Error("判断に要る事実が、同じ材料を 2 度挙げている");
    const facts = factSources.map((m) => ({ text: factTextOf(m), source: m.label, selfReported: m.kind === "self" }));
    // the records first, what an agent wrote about itself after (the writer's own order within each)
    facts.sort((a, b) => Number(a.selfReported) - Number(b.selfReported));

    const settledMaterial = material.items.filter((m) => m.settled);
    let settled: CardText["settled"];
    if (!settledMaterial.length) {
      settled = [{ text: NOTHING_SETTLED, source: "記録" }];
    } else {
      if (!Array.isArray(out.settled) || out.settled.length < 1) throw new Error("もう決まっていることが空");
      const cited = (out.settled as Record<string, unknown>[]).map((s, i) => {
        const source = sourcesOf([s?.source], material, `もう決まっていること ${i + 1}`)[0];
        if (!source.settled) throw new Error(`もう決まっていること ${i + 1} の出典「${source.label}」は、card が生まれた時点で engine が決めたことではない`);
        return source;
      });
      if (new Set(cited.map((m) => m.id)).size !== cited.length) throw new Error("もう決まっていることが、同じ材料を 2 度挙げている");
      // everything the engine had decided reaches the field: leaving one out hides a part of what the person need not decide
      const left = settledMaterial.filter((m) => !cited.some((c) => c.id === m.id));
      if (left.length) throw new Error(`もう決まっていることが、決まったこと「${left.map((m) => m.label).join("」「")}」を挙げていない`);
      settled = cited.flatMap(settledEntriesOf);
    }

    return {
      ok: true,
      text: {
        decide,
        recommend,
        outcomes,
        facts,
        settled,
        links: material.links,
        by: "translated",
      },
    };
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

// ---------------------------------------------------------------- the record

/** what is kept for a card: the words, and why they are the raw ones when they are */
export interface CardTextRecord {
  key: string;
  material: string;
  at: string;
  by: "translated" | "raw";
  /** why the words are the raw ones: the run failed, or what in the output broke the form */
  reason?: string;
  model?: string;
  text: CardText;
}

export function cardTextDir(): string {
  return join(stateDir(), "card-text");
}

function recordPath(key: string): string {
  return join(cardTextDir(), `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);
}

export function readCardTextRecord(key: string): CardTextRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath(key), "utf8")) as CardTextRecord;
    return record && record.key === key && record.text ? record : null;
  } catch {
    return null;
  }
}

function writeCardTextRecord(record: CardTextRecord): void {
  mkdirSync(cardTextDir(), { recursive: true });
  const path = recordPath(record.key);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(tmp, path);
}

/** the material of a card of a kind that carries the six fields; null for the others */
export function cardMaterial(item: InboxItem): CardMaterial | null {
  return item.kind === "go" ? goMaterial(item) : null;
}

/**
 * The words a card is shown with: the kept ones when they were written for this very material, otherwise the raw
 * fields. A pure read of the record: no run, no wait. A card of a kind that does not carry the fields has none.
 */
export function cardTextOf(item: InboxItem): CardText | undefined {
  const material = cardMaterial(item);
  if (!material) return undefined;
  const record = readCardTextRecord(snoozeKey(item));
  if (record && record.material === materialHash(material)) return record.text;
  return rawCardText(material);
}

// ---------------------------------------------------------------- the writer

export interface WriterResult {
  text: string;
  usage?: PiUsage;
  model: string;
}

/** how the writer is run; a test swaps it so no model is called */
export type CardWriter = (prompt: string, role: RolePreset) => Promise<WriterResult>;

const INSTRUCTION = [
  "あなたは、判断する人 1 人に向けて、判断の札（card）の文を書く役です。次の材料の外は読まず、材料に無い事実を書かないでください。",
  "出力は JSON の object だけにしてください。前置き・後書き・コードフェンスは書きません。",
  "",
  "形:",
  '{"decide":"決めること。問いの形で 1 文。？で終える",',
  ' "recommend":{"pick":推す選択肢の番号 または null,"sources":["推す根拠にした材料の名前"]},',
  ' "outcomes":[{"changes":"1 つ目の選択肢で何が変わるか 1 文"},{"changes":"2 つ目の選択肢で何が変わるか 1 文"}],',
  ' "facts":[{"source":"判断に要る事実の材料の名前"}],',
  ' "settled":[{"source":"もう決まっていて判断しなくてよいことの材料の名前"}]}',
  "",
  "規則:",
  "- 読み手は判断する人 1 人。前提を知らない日に読んでも分かる文にする。結論を先に書く。",
  `- decide は ${MAX_CHARS.decide} 文字まで、outcomes の 1 文は ${MAX_CHARS.changes} 文字までにする。1 つでも超えると 6 欄すべてが訳文から外れ、材料から組んだ欄に戻る。短く書く。`,
  "- outcomes は選択肢と同じ数・同じ順で書く。誰に及ぶか・戻せるかは書かない（別に付く）。",
  "- recommend は文を書かない。pick に推す選択肢の番号（「選択肢」の節の番号）を、sources に推す根拠にした材料の名前を最大 2 件書く。理由の文は材料の文がそのまま出る。根拠にできる材料が無ければ sources は空にする（確かめていない推測として出る）。推奨を作れないときは pick を null にする。",
  "- facts は 1〜3 件。材料の名前（[ ] の中）を選ぶだけで、文は書かない。表示される文は材料の文がそのまま出る。同じ材料は 2 度選ばない。",
  "- settled は、「決まったこと」と印の付いた材料の名前を選ぶだけで、文は書かない。その材料は 1 つも省かず、1 度ずつ挙げる。",
  "- decide・outcomes の文では、材料の数と評価の語（must・浅い・失敗 など）は、根拠にした材料に書かれたものだけを使う。材料に無い数を足さない。",
  "- 内部の番号（DEC・C-・AC・P- など）は、中身の短い説明と一緒にだけ書く。番号だけで中身を表さない。",
  "- 内部の語は言い換える。事実と推測を分け、確かめていないことは「確かめていない」と書く。",
  "- 「自己申告」と印の付いた材料は、エージェントが自分の仕事について書いた文である。recommend の sources に選ぶと、推奨は自己申告の印を付けて出る。",
].join("\n");

export function cardPrompt(material: CardMaterial): string {
  const items = material.items
    .map((m) => `[${m.id}] ${m.label}（${m.kind === "self" ? "自己申告" : "記録"}${m.settled ? "・決まったこと" : ""}）\n${m.text}`)
    .join("\n\n");
  const options = material.options.map((o, i) => `${i + 1}. ${o.label}: ${o.effect}`).join("\n");
  return `${INSTRUCTION}\n\n## 決めること\n${material.question}\n\n## 選択肢（この順に outcomes を書く）\n${options}\n\n## 材料\n${items}`;
}

async function runPi(prompt: string, role: RolePreset): Promise<WriterResult> {
  await prepareAgentDirAsync(role.name);
  const stdout = await runPiOnce(role, buildOneShotArgs(role, prompt), pipelineAgentDir(role), "card の文の生成");
  const parsed = parseTitleOutput(stdout);
  return { text: parsed.text, usage: parsed.usage, model: role.model };
}

let writer: CardWriter = runPi;

/** swap how the writer is run (a test); null puts the real one back */
export function setCardWriter(next: CardWriter | null): void {
  writer = next ?? runPi;
}

function recordCost(iddId: string, role: RolePreset, usage: PiUsage | undefined): void {
  recordUsageCost(role, usage, { sessionId: `card-text:${iddId}`, mode: "card-text", iddId });
}

// ---------------------------------------------------------------- when it is written

/** the cards being written now, by key: one run per card at a time */
const inFlight = new Set<string>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;
const settledListeners = new Set<() => void>();

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length) {
    const task = waiting.shift()!;
    running += 1;
    task().finally(() => {
      running -= 1;
      pump();
      if (!running && !waiting.length) for (const fn of [...settledListeners]) fn();
    });
  }
}

/** resolves when no run is going or waiting (a test waits on it; the engine never does) */
export function cardTextsIdle(): Promise<void> {
  if (!running && !waiting.length) return Promise.resolve();
  return new Promise((resolve) => {
    const once = () => {
      settledListeners.delete(once);
      resolve();
    };
    settledListeners.add(once);
  });
}

async function writeOne(key: string, iddId: string, material: CardMaterial, role: RolePreset): Promise<void> {
  const hash = materialHash(material);
  const base = { key, material: hash, at: new Date().toISOString(), model: role.model };
  try {
    const result = await writer(cardPrompt(material), role);
    recordCost(iddId, role, result.usage);
    const checked = checkCardText(result.text, material);
    if (checked.ok) writeCardTextRecord({ ...base, model: result.model, by: "translated", text: checked.text });
    else writeCardTextRecord({ ...base, model: result.model, by: "raw", reason: `出力が型を外れた: ${checked.reason}`, text: rawCardText(material) });
  } catch (error) {
    try {
      writeCardTextRecord({ ...base, by: "raw", reason: `訳す役が失敗した: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`, text: rawCardText(material) });
    } catch (writeError) {
      console.warn(`[idd card-text] 記録を書けませんでした: ${String(writeError).slice(0, 300)}`);
    }
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Start the writer for every card that has no record for its present material. It returns at once: the runs go on
 * beside the derivation, which reads the record when it is there and shows the raw fields until then. A card that
 * already has a record for this material (written, or kept as raw with its reason) is never written again. Without
 * a `card-writer` role in roles.yaml nothing is started and every card keeps its raw fields.
 */
export function scheduleCardTexts(items: InboxItem[]): void {
  let role: RolePreset | null = null;
  let roleChecked = false;
  for (const item of items) {
    const material = cardMaterial(item);
    if (!material) continue;
    const key = snoozeKey(item);
    if (inFlight.has(key)) continue;
    const record = readCardTextRecord(key);
    if (record && record.material === materialHash(material)) continue;
    if (!roleChecked) {
      roleChecked = true;
      try {
        const resolved = resolveRole(CARD_TEXT_ROLE);
        role = resolved.harness === "pi" ? resolved : null;
      } catch {
        role = null;
      }
    }
    if (!role) return;
    const chosen = role;
    inFlight.add(key);
    waiting.push(() => writeOne(key, (item as GoItem).iddId, material, chosen));
  }
  pump();
}
