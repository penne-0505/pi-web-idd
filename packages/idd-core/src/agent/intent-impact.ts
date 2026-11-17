import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { DecisionSource } from "../intent/decisions.ts";
import { decisionIndex, decisionRecord, readDecisionDocs } from "../intent/decisions.ts";
import { normalizeChoiceBody, normalizePlaces, type ChoiceForms, type Place } from "../intent/records.ts";
import { lookupChoices, raisedByLane, showRecord, type ChoiceView, type IntentRow, type PurposeView } from "../intent/store.ts";

/** the three judgements a planner can reach about a candidate DEC */
export const IMPACT_EFFECTS = ["keep", "within_freedom", "change_why"] as const;
export type ImpactEffect = (typeof IMPACT_EFFECTS)[number];

/** one existing DEC the planner judged: what it decided about it, and one line of why */
export interface IntentImpactRow {
  id: string;
  effect: ImpactEffect;
  reason: string;
  /** set by the engine: the DEC was not among the candidates the paths pulled */
  outside_candidates?: boolean;
}

/** the planner's report of how the change stands to the existing intent, with the engine's candidate count added */
export interface IntentImpactReport {
  paths: string[];
  candidate_count: number;
  rows: IntentImpactRow[];
}

/** the shape the planner sends, before the engine adds the candidate count */
export interface IntentImpactInput {
  paths: string[];
  rows: IntentImpactRow[];
}

const EFFECT_TEXT = IMPACT_EFFECTS.join("|");

export const INTENT_IMPACT_SHAPE = `{"paths":["触る見込みのファイル", ...],"decisions":[{"id":"DEC-xxx","effect":"${EFFECT_TEXT}","reason":"根拠 1 文"}, ...]}`;

/** the words every refusal and every send-back uses to name the field and how to fill it */
export const INTENT_IMPACT_RULE = `報告には既存の意図への影響（\`--intent-impact\`）を付ける。形と引き方は \`idd report plan\` が断る文に出る。`;

/**
 * The refusal for a missing or malformed report. It carries both the way to pull the candidates and the shape to
 * send, because a planner started before this field existed never saw either.
 */
export function intentImpactRefusal(detail: string): string {
  return `${detail} 触る見込みのファイルを \`idd intent decisions <path>...\` に渡すと、そのパスを Anchors に持つ既存の DEC（番号・題・Why の先頭の文・文書・当たったファイル）が引けます。\`idd report plan ... --intent-impact FILE\` で、${INTENT_IMPACT_SHAPE} の形で送ってください。関係する DEC が無いときは "decisions": [] と明示してください。`;
}

/**
 * The planner's report as the engine reads it: the shape checked, the candidate count counted, and each row marked
 * when it names a DEC the paths did not pull. A DEC that is not in the records at all is refused, unless the records
 * could not be read: then the count is 0 and the existence of no id can be checked, so none is.
 */
export function normalizeIntentImpact(
  raw: unknown,
  opts: { source?: DecisionSource; root?: string; excludeDocs?: string[] } = {},
): { report: IntentImpactReport } | { error: string } {
  if (raw === undefined || raw === null) return { error: intentImpactRefusal("既存の意図への影響の報告がありません。") };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: intentImpactRefusal("既存の意図への影響の報告はオブジェクトで送ってください。") };
  const body = raw as Record<string, unknown>;

  const paths: string[] = [];
  if (body.paths !== undefined && body.paths !== null) {
    if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== "string")) {
      return { error: intentImpactRefusal("`paths` は触る見込みのファイルの一覧（文字列の配列）で送ってください。") };
    }
    paths.push(...(body.paths as string[]).filter((p) => p.trim()).map((p) => p.trim()));
  }

  if (!Array.isArray(body.decisions)) {
    return { error: intentImpactRefusal("`decisions` は関係する DEC の一覧（配列）で送ってください。関係する DEC が無いときは空の一覧にします。") };
  }
  const rows: IntentImpactRow[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (body.decisions as unknown[]).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: intentImpactRefusal(`decisions[${i}] は {"id","effect","reason"} の行で送ってください。`) };
    }
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) return { error: intentImpactRefusal(`decisions[${i}].id に DEC の番号を書いてください。`) };
    if (seen.has(id)) return { error: intentImpactRefusal(`decisions に ${id} が 2 回あります。DEC ごとに 1 行にしてください。`) };
    seen.add(id);
    const effect = typeof r.effect === "string" ? r.effect.trim() : "";
    if (!(IMPACT_EFFECTS as readonly string[]).includes(effect)) {
      return { error: intentImpactRefusal(`decisions[${i}].effect は ${EFFECT_TEXT} のいずれかにしてください（keep = Why を保つ、within_freedom = Change freedom の範囲で変える、change_why = Why を変える）。`) };
    }
    if (typeof r.reason !== "string" || !r.reason.trim()) {
      return { error: intentImpactRefusal(`decisions[${i}].reason に根拠を 1 文で書いてください（${id}）。`) };
    }
    rows.push({ id, effect: effect as ImpactEffect, reason: r.reason.trim().replace(/\s+/g, " ") });
  }

  let candidateCount = 0;
  if (opts.source && recordsReadable(opts.source)) {
    const index = decisionIndex({ source: opts.source, paths, root: opts.root, ...(opts.excludeDocs ? { excludeDocs: opts.excludeDocs } : {}) });
    candidateCount = index.count;
    const candidateIds = new Set(index.candidates.map((c) => c.id));
    for (const row of rows) {
      if (candidateIds.has(row.id)) continue;
      if (!decisionRecord(opts.source, row.id, opts.root)) {
        return { error: intentImpactRefusal(`${row.id} は repo の記録に見つかりません。番号を確かめるか、\`idd intent decisions <path>...\` で引いた番号を使ってください。`) };
      }
      row.outside_candidates = true;
    }
  }

  return { report: { paths, candidate_count: candidateCount, rows } };
}

/** whether the record set can be read at all: a missing directory or an unknown rev is not an empty record set */
export function recordsReadable(source: DecisionSource): boolean {
  if ("root" in source) return readDecisionDocs(source).length > 0 || hasIntentDir(source.root);
  return readDecisionDocs(source).length > 0 || gitKnows(source.repo, source.ref);
}

function hasIntentDir(root: string): boolean {
  return existsSync(join(root, "_docs", "intent"));
}

function gitKnows(repo: string, ref: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** the last ready's report, or undefined when that ready came without one (an older ready must not read as no impact) */
export function readyIntentImpactOf(events: { event: string; attrs?: Record<string, unknown> }[]): IntentImpactReport | undefined {
  const last = [...events].reverse().find((e) => e.event === "s1_ready");
  const raw = last?.attrs?.intent_impact;
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const rows = Array.isArray(body.rows)
    ? (body.rows as Record<string, unknown>[]).flatMap((r) => (r && typeof r.id === "string" && typeof r.reason === "string" && typeof r.effect === "string"
      ? [{ id: r.id, effect: r.effect as ImpactEffect, reason: r.reason, ...(r.outside_candidates === true ? { outside_candidates: true } : {}) }]
      : []))
    : [];
  return {
    paths: Array.isArray(body.paths) ? body.paths.map(String) : [],
    candidate_count: Number(body.candidate_count ?? 0) || 0,
    rows,
  };
}

/**
 * The v2 report: the planner's Choice drafts and its disposal of the Choices already standing on the paths it
 * will touch. It is not written to the column here; the engine holds it on the ready and writes it after the GO.
 */
export const PLAN_CHOICE_EFFECTS = ["confirm", "drop", "supersede", "keep", "within_freedom", "reanchor"] as const;
export type PlanChoiceEffect = (typeof PLAN_CHOICE_EFFECTS)[number];

export interface PlanDraftChoice {
  purpose: string;
  forms: ChoiceForms;
  place: Place[];
  why: string;
  anchored: string;
  free?: string;
  revisit?: string;
  no_why_not?: string;
  question?: string;
  /** the test names (or an AC id) that would go red if this draft's behaviour broke: they ride into the raised Choice */
  verification?: string[];
  supersedes?: { ids: string[]; grounds: string };
}

export interface PlanExistingRow {
  id: string;
  effect: PlanChoiceEffect;
  reason?: string;
  grounds?: string;
  place?: Place[];
  anchored?: string;
  /** set by the engine: the Choice was not among the candidates the paths pulled */
  outside_candidates?: boolean;
}

export interface PlanRecordsInput {
  paths: string[];
  choices: PlanDraftChoice[];
  existing: PlanExistingRow[];
}

export interface PlanRecordsReport extends PlanRecordsInput {
  candidate_count: number;
}

export const PLAN_RECORDS_SHAPE = `{"paths":["触る見込みのファイル", ...],"choices":[{"purpose":"P-12","forms":{"chosen":"...","rejected":[{"form":"...","fails_because":"..."}]},"place":[{"path":"...","kind":"file","symbols":["..."]}],"why":"...","anchored":"...","free":"...","revisit":"...","no_why_not":"...","question":"Q-1","verification":["tests/x.test.mjs"],"supersedes":{"ids":["DEC-850"],"grounds":"..."}}, ...],"existing":[{"id":"DEC-105-6","effect":"confirm|drop|supersede|keep|within_freedom|reanchor","reason":"...",...}, ...]}`;

/** the refusal for a missing or malformed v2 report: the pull and the shape, because a planner never saw them */
export function planRecordsRefusal(detail: string): string {
  return `${detail} 触る見込みのファイルを \`idd intent lookup <path>...\` に渡すと、そのパスに当たる Choice が引けます。\`idd report plan ... --intent-impact FILE\` で、${PLAN_RECORDS_SHAPE} の形で送ってください。`;
}

/** one draft's supersedes, checked as a shape (the target's existence is the engine's business) */
function normalizeSupersedes(raw: unknown, index: number): { ok: true; value: { ids: string[]; grounds: string } | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: planRecordsRefusal(`choices[${index}].supersedes は {"ids","grounds"} の表で送ってください。`) };
  const o = raw as Record<string, unknown>;
  const grounds = typeof o.grounds === "string" ? o.grounds.trim() : "";
  if (!grounds) return { error: planRecordsRefusal(`choices[${index}].supersedes.grounds に理由を 1 文で書いてください。`) };
  if (!Array.isArray(o.ids) || !o.ids.length || o.ids.some((v) => typeof v !== "string" || !v.trim())) {
    return { error: planRecordsRefusal(`choices[${index}].supersedes.ids は置き換える Choice の ID の一覧で送ってください。`) };
  }
  return { ok: true, value: { ids: (o.ids as string[]).map((v) => v.trim()), grounds } };
}

/**
 * The v2 report's shape, checked before it is sent (the CLI cannot read the state, so the target is the engine's
 * business). Each draft runs the same checks a raise does; each `existing` row carries an effect this shape knows;
 * and a `supersede` row names exactly the targets of some draft's `supersedes`, in both directions.
 */
export function normalizePlanRecords(raw: unknown): { report: PlanRecordsInput } | { error: string } {
  if (raw === undefined || raw === null) return { error: planRecordsRefusal("意図の記録の報告がありません。") };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: planRecordsRefusal("意図の記録の報告はオブジェクトで送ってください。") };
  const body = raw as Record<string, unknown>;

  const paths: string[] = [];
  if (body.paths !== undefined && body.paths !== null) {
    if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== "string")) {
      return { error: planRecordsRefusal("`paths` は触る見込みのファイルの一覧（文字列の配列）で送ってください。") };
    }
    paths.push(...(body.paths as string[]).filter((p) => p.trim()).map((p) => p.trim()));
  }

  if (!Array.isArray(body.choices)) return { error: planRecordsRefusal("`choices` は Choice の草案の一覧（配列）で送ってください。草案が無いときは空の一覧にします。") };
  const choices: PlanDraftChoice[] = [];
  for (const [i, item] of (body.choices as unknown[]).entries()) {
    const normalized = normalizeChoiceBody(item);
    if (!normalized.ok) return { error: planRecordsRefusal(`choices[${i}]: ${normalized.error}`) };
    const supersedes = normalizeSupersedes((item as Record<string, unknown>).supersedes, i);
    if ("error" in supersedes) return { error: supersedes.error };
    const b = normalized.value;
    choices.push({
      purpose: b.purpose, forms: b.forms, place: b.place, why: b.why, anchored: b.anchored,
      ...(b.free ? { free: b.free } : {}),
      ...(b.revisit ? { revisit: b.revisit } : {}),
      ...(b.no_why_not ? { no_why_not: b.no_why_not } : {}),
      ...(b.question ? { question: b.question } : {}),
      ...(b.verification ? { verification: b.verification } : {}),
      ...(supersedes.value ? { supersedes: supersedes.value } : {}),
    });
  }

  if (!Array.isArray(body.existing)) return { error: planRecordsRefusal("`existing` は触る Place の既存の Choice の処置の一覧（配列）で送ってください。当たる Choice が無いときは空の一覧にします。") };
  const existing: PlanExistingRow[] = [];
  const seen = new Set<string>();
  for (const [i, item] of (body.existing as unknown[]).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: planRecordsRefusal(`existing[${i}] は {"id","effect",...} の表で送ってください。`) };
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) return { error: planRecordsRefusal(`existing[${i}].id に Choice の ID を書いてください。`) };
    if (seen.has(id)) return { error: planRecordsRefusal(`existing に ${id} が 2 回あります。Choice ごとに 1 行にしてください。`) };
    seen.add(id);
    const effect = typeof o.effect === "string" ? o.effect.trim() : "";
    if (!(PLAN_CHOICE_EFFECTS as readonly string[]).includes(effect)) {
      return { error: planRecordsRefusal(`existing[${i}].effect は ${PLAN_CHOICE_EFFECTS.join("|")} のいずれかにしてください。`) };
    }
    const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim().replace(/\s+/g, " ") : undefined;
    const grounds = typeof o.grounds === "string" && o.grounds.trim() ? o.grounds.trim().replace(/\s+/g, " ") : undefined;
    if (effect === "drop" && !grounds) return { error: planRecordsRefusal(`existing[${i}]（${id}）の drop には grounds が要ります。`) };
    // the Place's own shape is checked here: a `[null]` or a pathless item must not reach the state check, where
    // reading it would stop the whole report (F-119-7)
    let place: Place[] | undefined;
    if (o.place !== undefined && o.place !== null) {
      const normalizedPlace = normalizePlaces(o.place);
      if (!normalizedPlace.ok) return { error: planRecordsRefusal(`existing[${i}]（${id}）の place: ${normalizedPlace.error}`) };
      place = normalizedPlace.value;
    }
    const anchored = typeof o.anchored === "string" && o.anchored.trim() ? o.anchored.trim() : undefined;
    if (effect === "reanchor" && !place && !anchored) {
      return { error: planRecordsRefusal(`existing[${i}]（${id}）の reanchor には place か anchored が要ります。`) };
    }
    existing.push({
      id, effect: effect as PlanChoiceEffect,
      ...(reason ? { reason } : {}),
      ...(grounds ? { grounds } : {}),
      ...(place ? { place } : {}),
      ...(anchored ? { anchored } : {}),
    });
  }

  // a Supersede's target must be named by a draft, and a draft's target must have a Supersede row
  const supersededByRows = new Set(existing.filter((e) => e.effect === "supersede").map((e) => e.id));
  const supersededByDrafts = new Set(choices.flatMap((c) => c.supersedes?.ids ?? []));
  for (const id of supersededByRows) if (!supersededByDrafts.has(id)) return { error: planRecordsRefusal(`existing の ${id} が supersede ですが、どの草案の supersedes.ids にも入っていません。`) };
  for (const id of supersededByDrafts) if (!supersededByRows.has(id)) return { error: planRecordsRefusal(`草案の supersedes.ids にある ${id} が existing に supersede の行としてありません。`) };

  return { report: { paths, choices, existing } };
}

export interface PlanRecordsCheck {
  /** the lane the report belongs to */
  lane: string;
  repo: string;
  paths: string[];
  choices: PlanDraftChoice[];
  existing: PlanExistingRow[];
}

/** the Choices the paths pull that sit on a file mark or on a dir's own Place (a module-only hit is not the lane's) */
export function planTargets(repo: string, lane: string, paths: string[]): { id: string; title: string }[] {
  return lookupChoices({ repo, actor: { lane }, paths })
    .filter((c) => c.matched.some((m) => m.kind === "file" || m.kind === "dir"))
    .map((c) => ({ id: c.id, title: c.forms?.chosen ?? "" }));
}

/** whether a path meets a Choice as its own subject: a file mark or a dir's own Place, never another file of its module */
export function disposesOf(choice: { matched: { kind: string }[] }): boolean {
  return choice.matched.some((m) => m.kind === "file" || m.kind === "dir");
}

/**
 * How many marks a Choice carries: the files it was written against and the symbols it names in them. A Choice with
 * many is one whose Places have had the most chances to go stale, so the planner's list flags it as a Re-anchor
 * candidate: it sits where the Places are read, and re-anchoring is the disposal only it can decide (C-179-10).
 */
export function placeMarkCount(choice: { place: Place[] }): number {
  return choice.place.reduce((n, p) => n + (p.file ? 1 : 0) + (p.symbols?.length ?? 0), 0);
}

/** the mark count from which a Choice is shown as a Re-anchor candidate in the planner's list */
export const REANCHOR_CANDIDATE_MARKS = 3;

/** the line the planner's list adds to a Choice whose marks have piled up; empty for any other */
export function reanchorCandidateNote(choice: { place: Place[] }): string {
  const marks = placeMarkCount(choice);
  return marks >= REANCHOR_CANDIDATE_MARKS ? ` 〔Re-anchor の候補: 印 ${marks} 件〕` : "";
}

/**
 * The engine's reading of a v2 report: the shape already checked, and the state's own rules applied here. The
 * draft's Purpose must be active from the lane's side (or a Purpose this lane proposed), the target of every
 * `supersedes` must exist and not be a root Choice, and every Choice the paths pull on a file or dir Place must
 * have a row. A row outside the target is accepted (marked) when it exists, and refused when it does not.
 */
export function checkPlanRecords(input: PlanRecordsCheck): { report: PlanRecordsReport } | { error: string } {
  const actor = { lane: input.lane };
  const candidates = lookupChoices({ repo: input.repo, actor, paths: input.paths });
  const targets = candidates.filter(disposesOf);
  const targetIds = new Set(targets.map((c) => c.id));
  const rows = new Map(input.existing.map((e) => [e.id, e]));

  const missing = targets.filter((c) => !rows.has(c.id));
  if (missing.length) {
    const list = missing.map((c) => `- ${c.id} ${c.forms?.chosen ?? ""}（${c.matched.filter((m) => m.kind !== "root").map((m) => m.path).join(", ")}）`).join("\n");
    return {
      error: [
        "触る見込みのファイルに当たる Choice に処置（confirm / drop / supersede / keep / within_freedom / reanchor）がありません:",
        list,
        "1 件ずつ existing に 1 行にしてください。引き直すには `idd intent lookup <path>...`。",
      ].join("\n"),
    };
  }

  for (const row of input.existing) {
    if (targetIds.has(row.id)) continue;
    const found = showRecord({ repo: input.repo, actor, id: row.id });
    if (!found.ok) return { error: planRecordsRefusal(`existing の ${row.id} は repo の記録に見つかりません。番号を確かめるか、\`idd intent lookup <path>...\` で引いた Choice を使ってください。`) };
    row.outside_candidates = true;
  }

  for (const choice of input.choices) {
    const purpose = showRecord({ repo: input.repo, actor, id: choice.purpose });
    if (!purpose.ok || purpose.kind !== "purpose") return { error: planRecordsRefusal(`草案の purpose ${choice.purpose} の Purpose が見つかりません。`) };
    const p = purpose.record as PurposeView;
    const mine = raisedByLane(p.raised.by) === input.lane;
    if (p.status !== "active" && !(p.status === "proposed" && mine)) {
      return { error: planRecordsRefusal(`草案の purpose ${choice.purpose} は active でもこの lane の案でもありません（${p.status}）。`) };
    }
    for (const id of choice.supersedes?.ids ?? []) {
      const target = showRecord({ repo: input.repo, actor, id });
      if (!target.ok || target.kind !== "choice") return { error: planRecordsRefusal(`草案の supersedes.ids にある ${id} が見つかりません。`) };
      const targetChoice = target.record as ChoiceView;
      if (targetChoice.place.some((pl) => pl.kind === "root")) {
        return { error: planRecordsRefusal(`草案が root の Choice ${id} を Supersede しようとしています。root の置き換えは \`idd intent propose root-supersede\` で案を出してください。`) };
      }
    }
  }

  // the effect must fit the Choice's status: unconfirmed is confirmed / dropped / superseded, active is the rest
  for (const row of input.existing) {
    const found = showRecord({ repo: input.repo, actor, id: row.id });
    if (!found.ok || found.kind !== "choice") continue;
    const status = (found.record as ChoiceView).status;
    // a Choice the paths pull is the lane's to judge: an unconfirmed one is confirmed, dropped or superseded. An
    // unconfirmed Choice outside the touched files is not the lane's to judge, so moving its Place alone is let
    // through there (C-145-2): the report's own reading, not the plan's judgement, fixes a stale Place.
    const outsideTarget = !targetIds.has(row.id);
    const unconfirmedOk = row.effect === "confirm" || row.effect === "drop" || row.effect === "supersede" || (row.effect === "reanchor" && outsideTarget);
    const activeOk = row.effect === "keep" || row.effect === "within_freedom" || row.effect === "reanchor" || row.effect === "supersede";
    if (status === "unconfirmed" && !unconfirmedOk) {
      return { error: planRecordsRefusal(`existing の ${row.id} は unconfirmed なので、${row.effect} は使えません（触るファイルに当たるなら confirm / drop / supersede。触るファイルの外なら reanchor を place だけで送れます）。`) };
    }
    if (status === "unconfirmed" && row.effect === "reanchor" && row.anchored) {
      return { error: planRecordsRefusal(`existing の ${row.id} は unconfirmed なので、reanchor は place だけにしてください（anchored の変更は確認か Supersede で行います）。`) };
    }
    if (status === "active" && !activeOk) return { error: planRecordsRefusal(`existing の ${row.id} は active なので、${row.effect} は使えません（keep / within_freedom / reanchor / supersede）。`) };
    // a root Choice is every change's premise: a lane re-anchors neither it nor a Choice onto the root (a direct
    // reanchor refuses these the same way, so accepting them on the plan report would be a hole in the same gate)
    if (row.effect === "reanchor") {
      const hasRoot = (found.record as ChoiceView).place.some((p) => p.kind === "root") || Boolean(row.place?.some((p) => p.kind === "root"));
      if (hasRoot) return { error: planRecordsRefusal(`existing の ${row.id} は root の Place を持つので、lane からは Re-anchor できません。root の置き換えは \`idd intent propose root-reanchor\` で案を出してください。`) };
    }
  }

  return { report: { paths: input.paths, candidate_count: candidates.length, choices: input.choices, existing: input.existing } };
}

/** the last ready's v2 records, or undefined when that ready carries none */
export function readyPlanRecordsOf(events: { event: string; attrs?: Record<string, unknown> }[]): PlanRecordsReport | undefined {
  const last = [...events].reverse().find((e) => e.event === "s1_ready");
  const raw = last?.attrs?.plan_records;
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? (body.choices as PlanDraftChoice[]) : [];
  const existing = Array.isArray(body.existing) ? (body.existing as PlanExistingRow[]) : [];
  return { paths: [], candidate_count: 0, choices, existing };
}

/** the `intent_impact` rows a v2 report leaves behind, so the card's existing rendering can read them */
export function planRecordsImpactRows(existing: PlanExistingRow[]): IntentImpactRow[] {
  return existing.map((e) => ({ id: e.id, effect: e.effect as unknown as ImpactEffect, reason: e.reason ?? e.grounds ?? "", ...(e.outside_candidates ? { outside_candidates: true } : {}) }));
}

/** whether a raw report carries the v2 fields (the CLI reads this to tell the two shapes apart) */
export function isPlanRecordsShape(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const body = raw as Record<string, unknown>;
  return Array.isArray(body.choices) || Array.isArray(body.existing);
}
