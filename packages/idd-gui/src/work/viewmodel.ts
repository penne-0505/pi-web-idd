/**
 * The Work screen's view model, filled from the engine's doors alone (DEC-103-1). The ported parts draw whatever
 * this hands them, so every lane row, bundle, order, detail field and band is written here from the engine's
 * answers; nothing is read from the port's sample tables and nothing is invented when the engine returned no value
 * (DEC-103-2).
 *
 * The shapes are the ones the ported components already read (`W` and `WOv`), so the drawing layer is untouched.
 * Only the engine's own response types and our pure time helpers are imported: no server code, no sample lanes.
 */
import type {
  ConsumptionSummary,
  DecisionTabView,
  ForecastLaneView,
  ForecastView,
  HeldIssue,
  LaneDetailView,
  StageKey,
  StageSpan,
  WorkDecisionsView,
  WorkDoneView,
  WorkFindingView,
  WorkLaneView,
  WorkRepoView,
  WorkRecordView,
} from "../engine/contract";
import { ATT, SEV, SIGN, STY, type BarKind, type Severity } from "../model/data";
import { clockLabel, timePosition, type TimeWindow } from "./time";

const MIN = 60_000;
const HOUR = 60 * MIN;
const JST = 9 * HOUR;
/** the prototype's strips hold twelve hours (09:00–21:00), so a pixel keeps the same number of minutes */
const SPAN_HOURS = 12;
/** how much of that window sits behind the engine's now; the rest is ahead of it */
const BACK_HOURS = 8;

const LIST_LEN = 600;
const OV_LEN = 756;
const OV_LEFT = 232;
const OV_ROW_H = 32;
const MINI_LEN = 252;
const MINI_LEFT = 52;
const MINI_ROW_H = 6;
const MINI_GROUP_GAP = 6;
/** the glyphs the 47px name column holds at the name's 9px face (5.4px a glyph), the mark included */
const MINI_LABEL_GLYPHS = 8;
/** of those glyphs, how many the end of the name keeps: the head a repo's variants share says little */
const MINI_LABEL_TAIL = 3;

/** the ported stage bars are drawn at 1.7px a minute */
const PX_PER_MIN = 1.7;

/** the window every strip shares: the same span the prototype drew, ending four hours ahead of the engine's now */
export function workWindow(now: number): TimeWindow {
  return { from: now - BACK_HOURS * HOUR, to: now + (SPAN_HOURS - BACK_HOURS) * HOUR };
}

/**
 * A field the engine left out reads as an empty list, never as a crash. The Work screen is drawn from the engine's
 * answers alone (DEC-103-1), and a door that returns no value for a field means that field has no value: the places
 * that depend on it come out empty while every other field is still drawn (DEC-103-2, C-151-3).
 */
function listOf<T>(value: readonly T[] | undefined | null): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function xPos(t: number, w: TimeWindow, len: number): number {
  return Math.round(timePosition(t, w) * len);
}

function parsed(t: string): number {
  const at = Date.parse(t);
  return Number.isNaN(at) ? NaN : at;
}

function spanStart(span: StageSpan): number {
  return parsed(span.start);
}

function spanEnd(span: StageSpan, nowMs: number): number {
  if (!span.end) return nowMs;
  const t = parsed(span.end);
  return Number.isNaN(t) ? nowMs : t;
}

/** the bar a span is drawn as: `past` is done, `stP` runs on a machine, `q`/`sign` wait at a person's turn */
function barKind(span: StageSpan): BarKind {
  if (span.end) return "past";
  if (span.owner !== "person") return "stP";
  return span.key === "ship" || span.key === "sign" ? "sign" : "q";
}

type StripBar = { l: number; w: number; bg: string; bd: string };

function barsOf(lane: WorkLaneView, w: TimeWindow, len: number, nowMs: number): StripBar[] {
  return listOf(lane.spans).map((span) => {
    const l = xPos(spanStart(span), w, len);
    const r = xPos(spanEnd(span, nowMs), w, len);
    const kind = barKind(span);
    return { l, w: Math.max(3, r - l), bg: STY[kind][0], bd: STY[kind][1] };
  });
}

/**
 * The name the mini map draws. A name wider than the column keeps both its head and its tail: spending every glyph
 * on the head left the repos that share a long prefix (`daysai-flutter`, `daysai-web`, `daysai-management`) as
 * one same `daysai-…`, so the list could not be told apart. The whole name is kept on the label for hover.
 */
function miniLabel(name: string): string {
  if (name.length <= MINI_LABEL_GLYPHS) return name;
  const head = MINI_LABEL_GLYPHS - 1 - MINI_LABEL_TAIL;
  return `${name.slice(0, head)}…${name.slice(-MINI_LABEL_TAIL)}`;
}

/** One row of a repo strip (the lane column, the context strip, the full band). */
export interface StripRow {
  ref: string;
  t: string;
  eta: string;
  etaT: string;
  ec: string;
  tc: string;
  fw: number;
  tGo: boolean;
  tSign: boolean;
  selSh: string;
  selBg: string;
  rowBg: string;
  bars: StripBar[];
  hasUsual: boolean;
  u0: number;
  u1: number;
  hasFail: boolean;
  fx: number;
  go?: () => void;
  rel?: string;
}

export interface StageRow {
  n: string;
  t: string;
  w: number;
  c: string;
  nc: string;
  fw: number;
  hasUs: boolean;
  ux: number;
}

export interface DecView {
  id: string;
  t: string;
  anchors: { x: string }[];
  why: string;
  rep: string;
  hasRep: boolean;
  state: string;
  stBg: string;
  stC: string;
  f1: string;
  f2: string;
  f3: string;
  fl: string;
}

export interface RoundView {
  r: string;
  n: string;
  segs: { w: number; bg: string; bd: string }[];
  rc: string;
  rw: number;
}

export interface FindingRowView {
  sev: Severity;
  loc: string;
  text: string;
  r: string;
  sc: string;
  sb: string;
}

export interface WorkDetailView {
  p: string;
  ref: string;
  t: string;
  eta: string;
  ec: string;
  stages: StageRow[];
  hasStages: boolean;
  live: boolean;
  isDone: boolean;
  pr?: string;
  at?: string;
  cost?: string;
  acN: string;
  acs: { bg: string }[];
  aStop?: boolean;
  aGo?: boolean;
  aSign?: boolean;
  aRetry?: boolean;
  decs: DecView[];
  hasDec: boolean;
  noDec: boolean;
  nDec: string;
  nFd: string;
  rounds: RoundView[];
  hasFd: boolean;
  noFd: boolean;
  open: FindingRowView[];
  hasOpen: boolean;
  nOpen: string;
  fixed: string;
  pins: FindingRowView[];
  hasPin: boolean;
}

/** the reading side of the ported state machine the components hand their presses to */
export interface WorkState {
  wsel?: string | null;
  wproj?: string;
  wdone?: boolean;
  wopen?: boolean;
  wtab?: string;
}

export interface WorkSetState {
  (update: Partial<WorkState> | ((s: WorkState) => Partial<WorkState>)): void;
}

/** the Work column as one read of `/api/idd/work` returns it */
export interface WorkSnapshot {
  now: string;
  repos: WorkRepoView[];
  lanes: WorkLaneView[];
  done: WorkDoneView[];
  holds: HeldIssue[];
}

/** one lane's own reads: `/api/idd/lane/:id`, its decisions, and its record */
export interface WorkDetailSource {
  lane: LaneDetailView | null;
  decisions: WorkDecisionsView | null;
  record: WorkRecordView | null;
  error: string | null;
}

/** everything the Work view model is written from */
export interface WorkSource {
  snapshot: WorkSnapshot | null;
  /** `/api/idd/forecast`: the only door that returns the finish, the usual length and the anomaly (C-130-1) */
  forecast: ForecastView | null;
  /** `/api/idd/work/consumption`: the sidebar's 今日 shows this door's own total for the day */
  consumption: ConsumptionSummary | null;
  detail: WorkDetailSource | null;
}

// ------------------------------------------------------------------ time labels
function etaText(f: ForecastLaneView | undefined): string {
  const at = f?.eta?.at;
  if (!at) return "";
  const t = parsed(at);
  if (Number.isNaN(t)) return "";
  return `≈ ${clockLabel(t)}`;
}

function dateLabel(iso: string | undefined): string {
  const t = iso ? parsed(iso) : NaN;
  if (Number.isNaN(t)) return "";
  return new Date(t + JST).toISOString().slice(5, 10).replace("-", "/");
}

function dateTimeLabel(iso: string | undefined): string {
  const t = iso ? parsed(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = new Date(t + JST).toISOString();
  return `${s.slice(5, 10).replace("-", "/")} ${s.slice(11, 16)}`;
}

function minutesLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** the sidebar's one money value: the engine's own total, or empty when the door returned none (DEC-103-2) */
function costText(summary: ConsumptionSummary | null): string {
  return summary && typeof summary.cost === "number" && Number.isFinite(summary.cost) ? `$${summary.cost.toFixed(2)}` : "";
}

/** the ticks of a strip's axis, on whole hours, with the ones under the now mark left out */
function ticksOf(w: TimeWindow, len: number, nowPx: number, stepHours: number): { x: number; t: string }[] {
  const out: { x: number; t: string }[] = [];
  const step = stepHours * HOUR;
  const first = Math.ceil((w.from + JST) / step) * step - JST;
  for (let t = first; t <= w.to; t += step) {
    const x = xPos(t, w, len);
    if (Math.abs(x - nowPx) <= 20) continue;
    out.push({ x, t: clockLabel(t) });
  }
  return out;
}

// ------------------------------------------------------------------ one strip row
interface StripBuild {
  repos: WorkRepoView[];
  lanes: WorkLaneView[];
  selected: string | null;
  forecast: Map<string, ForecastLaneView>;
  forecastView: ForecastView | null;
}

/** the usual length the engine sent for one repo's stage, or nothing when the answer carried none */
function usualMedian(forecast: ForecastView | null | undefined, area: string, stage: StageKey | undefined): number | undefined {
  if (!stage) return undefined;
  const median = listOf(forecast?.usual).find((u) => u.area === area)?.stages?.[stage]?.median;
  return typeof median === "number" ? median : undefined;
}

/**
 * The usual length of the stage a lane is in now, as the two dotted marks the strip draws. It is read from the
 * forecast's own `now`, which is the one stage the engine's anomaly is judged on: reading the band's stage key here
 * would look the value up under a key the usual table does not have (C-151-1, C-130-1). A lane at a gate or a wait,
 * and a lane the forecast did not return, get no mark.
 */
function usualOfLane(lane: WorkLaneView, source: StripBuild, w: TimeWindow, len: number): { u0: number; u1: number } | null {
  const now = source.forecast.get(lane.id)?.now;
  const median = usualMedian(source.forecastView, lane.repo, now?.kind === "stage" ? now.stage : undefined);
  const from = now && typeof now.since === "string" ? parsed(now.since) : NaN;
  if (median === undefined || Number.isNaN(from)) return null;
  return { u0: xPos(from, w, len), u1: xPos(from + median * MIN, w, len) };
}

function rowOf(lane: WorkLaneView, source: StripBuild, w: TimeWindow, len: number, nowMs: number): StripRow {
  const selected = lane.id === source.selected;
  const f = source.forecast.get(lane.id);
  const anomaly = f?.anomaly ?? false;
  const eta = etaText(f);
  const usual = usualOfLane(lane, source, w, len);
  return {
    ref: lane.ref?.label ?? lane.id,
    t: lane.title,
    eta,
    etaT: eta.replace("≈ ", ""),
    // the anomaly is the only value that turns a finish red: no forecast, no red (C-130-1, DEC-103-2)
    ec: anomaly ? "var(--attention-text)" : "var(--ink)",
    tc: lane.bundle === "next" ? "var(--ink-2)" : "var(--ink)",
    fw: selected ? 600 : 400,
    tGo: lane.turn === "go",
    tSign: lane.turn === "ship",
    selSh: selected ? "0 0 0 1.5px var(--ink)" : "none",
    selBg: selected ? "var(--surface)" : "transparent",
    rowBg: anomaly ? "var(--attention-bg-soft)" : "transparent",
    bars: barsOf(lane, w, len, nowMs),
    hasUsual: !!usual,
    u0: usual?.u0 ?? 0,
    u1: usual?.u1 ?? 0,
    // the engine returns no failure time: no failure mark is drawn (DEC-103-2)
    hasFail: false,
    fx: 0,
  };
}

interface StripGroup {
  p: string;
  rows: StripRow[];
  links: { x: number; from: number; len: number }[];
  hasFail: boolean;
  idea: string;
  hasIdea: boolean;
}

/** the row click every strip row gets: pressing the selected lane lets it go, any other selects it */
function pickRow(source: StripBuild, setState: WorkSetState, lane: WorkLaneView): () => void {
  return () =>
    setState(
      lane.id === source.selected ? { wsel: null, wopen: false } : { wsel: lane.id, wproj: lane.repo, wopen: false },
    );
}

function buildStrip(
  source: StripBuild,
  setState: WorkSetState,
  w: TimeWindow,
  nowMs: number,
  len: number,
  rowH: number,
  left: number,
  withLinks: boolean,
) {
  const groups: StripGroup[] = listOf(source.repos).map((p) => {
    const lanes = listOf(source.lanes).filter((l) => l.repo === p.id);
    const rows = lanes.map((lane) => {
      const row = rowOf(lane, source, w, len, nowMs);
      row.go = pickRow(source, setState, lane);
      return row;
    });
    const links = withLinks
      ? lanes.flatMap((lane, i) => {
          const dep = listOf(lane.waitsFor).find((x) => x.lane && lanes.some((l) => l.id === x.lane));
          const first = listOf(lane.spans)[0];
          if (!dep?.lane || !first) return [];
          const j = lanes.findIndex((l) => l.id === dep.lane);
          if (j < 0) return [];
          return [{ x: xPos(spanStart(first), w, len) + left, from: j * rowH + rowH / 2, len: (i - j) * rowH }];
        })
      : [];
    return { p: p.name, rows, links, hasFail: false, idea: "", hasIdea: false };
  });
  const now = xPos(nowMs, w, len);
  return { groups, now, ticks: ticksOf(w, len, now, 2) };
}

// ------------------------------------------------------------------ the detail
/**
 * The stage table's rows: the band's spans accumulated by key, in the order the lane met them. Only the row the lane
 * stands on now carries the usual mark, and only a lane the engine called anomalous carries the over-red — and that
 * red sits on that same row. The value is the forecast's own stage, looked up on the band's open row, because the
 * two cuts use different keys and the view must not rename a stage (C-151-1, C-151-2). Every other row keeps the
 * plain colour the prototype gives it, and the time column always shows the row's real length (C-151-7).
 */
function stageRows(lane: WorkLaneView | null, source: WorkSource, nowMs: number): StageRow[] {
  if (!lane) return [];
  const spans = listOf(lane.spans);
  const order: string[] = [];
  const acc = new Map<string, { label: string; owner: string; ms: number }>();
  for (const span of spans) {
    const start = spanStart(span);
    const from = Number.isNaN(start) ? nowMs : start;
    const minutes = Math.max(0, (spanEnd(span, nowMs) - from) / MIN);
    const cur = acc.get(span.key);
    if (cur) cur.ms += minutes;
    else {
      acc.set(span.key, { label: span.label, owner: span.owner, ms: minutes });
      order.push(span.key);
    }
  }
  const nowSpan = spans.find((s) => !s.end);
  const f = source.forecast?.lanes?.find((l) => l.iddId === lane.id);
  const nowStage = f?.now?.kind === "stage" ? f.now.stage : undefined;
  const median = usualMedian(source.forecast, lane.repo, nowStage);
  const anomalous = f?.anomaly === true;
  return order.map((key) => {
    const row = acc.get(key)!;
    const isNow = !!nowSpan && key === nowSpan.key;
    const usual = isNow && typeof median === "number" ? median : undefined;
    // a past row is plain grey: the person's own colour is the running row's, as the prototype's samples show
    const c = !isNow
      ? "var(--mute-1)"
      : anomalous
        ? ATT
        : row.owner === "person"
          ? key === "ship" || key === "sign"
            ? SIGN
            : ATT
          : "var(--mute-1)";
    return {
      n: row.label,
      t: minutesLabel(row.ms),
      w: Math.round(row.ms * PX_PER_MIN),
      c,
      nc: c === ATT ? "var(--attention-text)" : c === SIGN ? "var(--sign-text)" : "var(--ink-2)",
      fw: c !== "var(--mute-1)" ? 600 : 400,
      hasUs: usual !== undefined,
      ux: Math.round((usual ?? 0) * PX_PER_MIN),
    };
  });
}

function decisionView(d: DecisionTabView, isDone: boolean): DecView {
  return {
    id: d.id,
    t: d.title,
    anchors: d.hasPlace && d.place ? d.place.split(", ").filter(Boolean).map((x) => ({ x })) : [],
    why: d.why,
    // the engine returns no "replaced by": empty, never guessed (DEC-103-2)
    rep: "",
    hasRep: false,
    state: isDone ? "確定" : "lane が閉じると確定",
    stBg: isDone ? "var(--ok-bg)" : "var(--surface)",
    stC: isDone ? "var(--ok-text)" : "var(--ink-2)",
    // the Change freedom level is not among the engine's values: the three marks stay empty (DEC-103-2)
    f1: "var(--line-strong)",
    f2: "var(--line-strong)",
    f3: "var(--line-strong)",
    fl: "",
  };
}

function roundsByNumber(lane: LaneDetailView | null): Map<number, { accepted: number; open: number }> {
  const byRound = new Map<number, { accepted: number; open: number }>();
  for (const r of listOf(lane?.reviewRounds)) {
    const cur = byRound.get(r.round) ?? { accepted: 0, open: 0 };
    // the judgement's accepted count is must + should + nit; `open` is the part of it still unfixed (DEC-9141)
    cur.accepted += (r.must ?? 0) + (r.should ?? 0) + (r.nit ?? 0);
    cur.open += r.open ?? 0;
    byRound.set(r.round, cur);
  }
  return byRound;
}

/**
 * The findings a lane's review rounds confirmed as fixed: what each judgement accepted less what it left open. The
 * dropped findings do not enter it — a drop is a rejection or a lost place, never a fix (C-151-4).
 */
function fixedCount(lane: LaneDetailView | null): number {
  let fixed = 0;
  for (const r of roundsByNumber(lane).values()) fixed += Math.max(0, r.accepted - r.open);
  return fixed;
}

function roundViews(lane: LaneDetailView | null, isDone: boolean): RoundView[] {
  const byRound = new Map<number, { must: number; should: number; nit: number; open: number }>();
  for (const r of listOf(lane?.reviewRounds)) {
    const cur = byRound.get(r.round) ?? { must: 0, should: 0, nit: 0, open: 0 };
    cur.must += r.must ?? 0;
    cur.should += r.should ?? 0;
    cur.nit += r.nit ?? 0;
    cur.open += r.open ?? 0;
    byRound.set(r.round, cur);
  }
  const keys = [...byRound.keys()].sort((a, b) => a - b);
  return keys.map((round, i) => {
    const c = byRound.get(round)!;
    const segs: { w: number; bg: string; bd: string }[] = [];
    (
      [
        [c.must, ATT],
        [c.should, "var(--ink)"],
        [c.nit, "var(--mute-1)"],
      ] as [number, string][]
    ).forEach(([n, bg]) => {
      for (let k = 0; k < n; k += 1) segs.push({ w: 14, bg, bd: "none" });
    });
    for (let k = 0; k < c.open; k += 1) segs.push({ w: 14, bg: "transparent", bd: "1.5px solid var(--ink-3)" });
    // the running round's own open count from the engine marks the last row, never the count from another section
    const last = i === keys.length - 1 && !isDone && c.open > 0;
    return {
      r: `R${round}`,
      // the judgement's accepted count: the open part is already inside it, so it is not added again (C-151-4)
      n: String(c.must + c.should + c.nit),
      segs,
      rc: last ? "var(--ink)" : "var(--ink-3)",
      rw: last ? 600 : 400,
    };
  });
}

function severityOf(s: string): Severity {
  return s === "must" || s === "should" || s === "nit" ? s : "should";
}

/** an open finding is located by its line, a place-attached one by its range */
function locationOf(f: WorkFindingView, range: boolean): string {
  const lines = f.lines;
  if (!lines) return f.path;
  return range ? `${f.path} L${lines[0]}–${lines[1]}` : `${f.path}:${lines[0]}`;
}

function findingRow(f: WorkFindingView, range: boolean): FindingRowView {
  const sev = severityOf(f.severity);
  return {
    sev,
    loc: locationOf(f, range),
    text: f.claim,
    r: !range && f.round !== undefined ? `R${f.round}` : "",
    sc: SEV[sev][2],
    sb: SEV[sev][1],
  };
}

function detailOf(
  source: WorkSource,
  selLane: WorkLaneView | null,
  selDone: WorkDoneView | null,
  pName: string,
  nowMs: number,
): WorkDetailView {
  const lane = source.detail?.lane ?? null;
  const record = source.detail?.record ?? null;
  const decisions = source.detail?.decisions ?? null;
  const isDone = !!selDone;
  const live = !!selLane && !isDone;
  const forecastLane = selLane ? source.forecast?.lanes?.find((l) => l.iddId === selLane.id) : undefined;
  const anomaly = forecastLane?.anomaly ?? false;

  const seen = new Set<string>();
  const decs: DecView[] = [...listOf(decisions?.own), ...listOf(decisions?.existing)]
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
    .map((d) => decisionView(d, isDone));

  const placed = listOf(record?.findings?.placed);
  const delivered = listOf(record?.findings?.delivered);
  // a dropped finding is a rejection or a place lost in the mainline: it is drawn nowhere on the tab (C-151-5)
  const openPlaced = placed.filter((f) => f.status === "open");
  // the lane's open findings are the ones it attached to places, so they are what a later lane is handed (C-151-5)
  const pins = openPlaced;
  // the other section is the engine's other per-finding list: what was handed to this lane and is still open. A
  // finding this lane placed itself is already drawn on the place side, so it is left out of this one (C-151-5)
  const placedIds = new Set(openPlaced.map((f) => f.id));
  const openFindings = delivered.filter((f) => f.status === "open" && !placedIds.has(f.id));
  const rounds = roundViews(lane, isDone);
  const hasFd = rounds.length > 0 || openPlaced.length > 0 || openFindings.length > 0;

  const acceptance = listOf(record?.acceptance);
  const doneAc = acceptance.filter((a) => a.status === "verified").length;
  const totalAc = acceptance.length;
  const stages = stageRows(selLane, source, nowMs);
  const closedAt = selDone?.closedAt;

  return {
    p: pName,
    ref: selLane?.ref?.label ?? selDone?.ref?.label ?? selLane?.id ?? selDone?.id ?? "",
    t: selLane?.title ?? selDone?.title ?? "",
    eta: isDone ? (closedAt ? `済み ${dateLabel(closedAt)}` : "") : etaText(forecastLane),
    ec: isDone ? "var(--ok-text)" : anomaly ? "var(--attention-text)" : "var(--ink-2)",
    stages,
    hasStages: stages.length > 0,
    live,
    isDone,
    pr: lane?.pr ? `PR #${lane.pr.number}` : undefined,
    at: isDone ? dateTimeLabel(closedAt) : undefined,
    cost: lane?.cost ? `$${lane.cost.total.toFixed(2)}` : undefined,
    // the actions have no engine value: the screen draws no button and sends no judgement (DEC-103-4)
    aStop: undefined,
    aGo: undefined,
    aSign: undefined,
    aRetry: undefined,
    acN: totalAc ? `${doneAc} / ${totalAc}` : "",
    acs: Array.from({ length: totalAc }, (_, i) => ({ bg: i < doneAc ? "var(--ok)" : "transparent" })),
    decs,
    hasDec: decs.length > 0,
    noDec: decs.length === 0,
    nDec: String(decs.length),
    nFd: String(openFindings.length + pins.length),
    rounds,
    hasFd,
    noFd: !hasFd,
    open: openFindings.map((f) => findingRow(f, false)),
    hasOpen: openFindings.length > 0,
    nOpen: String(openFindings.length),
    fixed: String(fixedCount(lane)),
    pins: pins.map((f) => findingRow(f, true)),
    hasPin: pins.length > 0,
  };
}

// ------------------------------------------------------------------ summary rows
type AttnMark = "long" | "fail" | "block" | "question" | "go" | "sign";

function turnLabel(turn: string): string {
  switch (turn) {
    case "granularity":
      return "粒度の判断";
    case "question":
      return "質問";
    case "review":
      return "Review";
    case "stuck":
      return "行き詰まり";
    case "requeue":
      return "やり直し";
    default:
      return turn;
  }
}

function attentionOf(lane: WorkLaneView, f: ForecastLaneView | undefined): { mark: AttnMark; why: string } | null {
  if (lane.turn === "go") return { mark: "go", why: "GO を待っている" };
  if (lane.turn === "ship") return { mark: "sign", why: "署名を待っている" };
  // a lane waiting on an answer is drawn with the question mark the prototype has for it (C-151-6, DEC-103-5)
  if (lane.turn === "question") return { mark: "question", why: "質問を待っている" };
  // the engine's forecast is the only ground for a long lane: its red is the anomaly's alone
  if (f?.anomaly) return { mark: "long", why: "ふだんより長い" };
  // a person's turn the prototype has no shape of its own for: the common mark still says something waits (DEC-103-5)
  if (lane.turn) return { mark: "block", why: `${turnLabel(lane.turn)}を待っている` };
  if (listOf(lane.waitsFor).length) return { mark: "block", why: `${listOf(lane.waitsFor)[0].ref?.label ?? ""} 待ち` };
  // a machine that stopped is something to mind, but it is not the engine's anomaly: the common mark, never red
  if (lane.activity === "stalled") return { mark: "block", why: "止まっている" };
  return null;
}

// ------------------------------------------------------------------ the whole thing
export function workVals(state: WorkState, setState: WorkSetState, source: WorkSource) {
  const snapshot = source.snapshot;
  const repos = listOf(snapshot?.repos);
  const lanes = listOf(snapshot?.lanes);
  const done = listOf(snapshot?.done);
  const nowMs = snapshot ? parsed(snapshot.now) : NaN;
  const at = Number.isNaN(nowMs) ? Date.now() : nowMs;
  const w = workWindow(at);

  const wsel = state.wsel ?? null;
  const selLane = wsel ? lanes.find((l) => l.id === wsel) ?? null : null;
  const selDone = wsel ? done.find((d) => d.id === wsel) ?? null : null;
  const hasSel = !!(selLane || selDone);

  const repoName = (id: string | null | undefined): string => repos.find((p) => p.id === id)?.name ?? id ?? "";
  const p3 = selLane?.repo ?? selDone?.repo ?? state.wproj ?? repos[0]?.id ?? "";
  const pName = repoName(p3);

  const forecast = new Map(listOf(source.forecast?.lanes).map((l) => [l.iddId, l]));
  const build: StripBuild = { repos, lanes, selected: wsel, forecast, forecastView: source.forecast };

  // ---- the lane column (24px rows)
  const listStrip = buildStrip(build, setState, w, at, LIST_LEN, 24, 0, false);
  // a lane's row is built from the lane itself, never looked up by its ref label: two lanes of one repo carry the
  // same label (a review lane and its Issue both read `a#1`), and a label-keyed map made them share one row (C-151-3)
  const rowFor = (lane: WorkLaneView): StripRow => rowOf(lane, build, w, LIST_LEN, at);

  const mine = lanes.filter((l) => l.repo === p3);
  const act = mine.filter((l) => l.bundle === "running");
  const wait = mine.filter((l) => l.bundle === "next");
  const list = [...act, ...wait].map((lane, i) => ({
    ...rowFor(lane),
    hasDiv: i === act.length && wait.length > 0,
    div: "次に入る",
    go: pickRow(build, setState, lane),
  }));

  const select = (lane: WorkLaneView) => () => setState({ wsel: lane.id, wproj: lane.repo, wopen: false });
  const selectDone = (d: WorkDoneView) => () => setState({ wsel: d.id, wproj: d.repo, wdone: true });

  const projs = [
    { t: "すべて", f: false, ff: "var(--font-sans)", bg: "transparent", sh: "none", go: () => setState({ wopen: true }) },
    ...repos.map((p) => ({
      t: p.name,
      f: p.attention,
      ff: "var(--font-mono)",
      bg: p.id === p3 ? "var(--surface)" : "transparent",
      sh: p.id === p3 ? "0 0 0 1px var(--ink)" : "none",
      go: () => setState({ wproj: p.id, wsel: null }),
    })),
  ];

  const attn = mine
    .map((lane) => {
      const a = attentionOf(lane, forecast.get(lane.id));
      if (!a) return null;
      return {
        ref: lane.ref?.label ?? lane.id,
        t: lane.title,
        why: a.why,
        gLong: a.mark === "long",
        gFail: a.mark === "fail",
        gBlock: a.mark === "block",
        gQuestion: a.mark === "question",
        gGo: a.mark === "go",
        gSign: a.mark === "sign",
        go: select(lane),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const doneK = done.filter((d) => d.repo === p3);
  const doneRows = doneK.map((d) => {
    const me = d.id === wsel;
    return {
      ref: d.ref?.label ?? d.id,
      t: d.title,
      at: dateLabel(d.closedAt),
      n: String(d.decisions),
      hasDec: d.decisions > 0,
      selBg: me ? "var(--surface)" : "transparent",
      selSh: me ? "0 0 0 1.5px var(--ink)" : "none",
      fw: me ? 600 : 400,
      go: me ? () => setState({ wsel: null }) : selectDone(d),
    };
  });
  const doneOpen = state.wdone ?? false;

  const sum = {
    line: `動いている ${act.length} · 待ち ${wait.length} · 済み ${doneK.length}`,
    attn,
    noAttn: attn.length === 0,
    next: wait.map((lane) => ({
      ref: lane.ref?.label ?? lane.id,
      t: lane.title,
      eta: etaText(forecast.get(lane.id)).replace("≈ ", ""),
      go: select(lane),
    })),
    done: doneRows,
  };

  // ---- the relation rows the detail's context strip draws
  const rel: [WorkLaneView, string][] = [];
  if (selLane) {
    rel.push([selLane, "この lane"]);
    listOf(selLane.waitsFor)
      .map((x) => (x.lane ? lanes.find((l) => l.id === x.lane) : undefined))
      .filter((l): l is WorkLaneView => !!l)
      .forEach((l) => rel.push([l, "待っている相手"]));
    lanes.filter((l) => listOf(l.waitsFor).some((x) => x.lane === selLane.id)).forEach((l) => rel.push([l, "上に載る"]));
    lanes
      .filter((l) => l.repo === p3 && l.bundle === "running" && !rel.some((x) => x[0].id === l.id))
      .forEach((l) => rel.push([l, "同じ時間に"]));
  }
  const ctx = rel.slice(0, 4).map(([lane, label]) => ({
    ...rowFor(lane),
    rel: label,
    fw: lane.id === wsel ? 600 : 400,
    tc: lane.id === wsel ? "var(--ink)" : "var(--ink-2)",
  }));

  // ---- the mini map: every repo as a thin strip
  const mX = (t: number) => MINI_LEFT + xPos(t, w, MINI_LEN);
  const mBars: { l: number; w: number; y: number; bg: string; bd: string }[] = [];
  const mMarks: { x: number; y: number }[] = [];
  const mLabels: { y: number; t: string; full: string; c: string }[] = [];
  const mSel: { y: number }[] = [];
  let y = 0;
  repos.forEach((p, gi) => {
    if (gi) y += MINI_GROUP_GAP;
    mLabels.push({ y, t: miniLabel(p.name), full: p.name, c: p.id === p3 ? "var(--ink)" : "var(--ink-3)" });
    const rows = lanes.filter((l) => l.repo === p.id);
    rows.forEach((lane) => {
      const me = lane.id === wsel;
      listOf(lane.spans).forEach((span) => {
        const kind = barKind(span);
        const l = mX(spanStart(span));
        const r = mX(spanEnd(span, at));
        const hot = kind === "stP";
        mBars.push({
          l,
          w: Math.max(2, r - l),
          y,
          bg:
            kind === "q"
              ? "transparent"
              : hot
                ? ATT
                : kind === "sign"
                  ? SIGN
                  : kind === "past"
                    ? me
                      ? "var(--ink)"
                      : "var(--mute-1)"
                    : "var(--line)",
          bd: kind === "q" ? "1px solid var(--line-strong)" : "none",
        });
      });
      if (me) mSel.push({ y });
      y += MINI_ROW_H;
    });
    // a repo with no lane still holds one row for its name: without it the next name sits 6px below and the
    // 9px labels overlap, so the name row is kept whatever the number of lanes
    if (rows.length === 0) y += MINI_ROW_H;
  });

  // ---- the detail and its tabs
  const tab = state.wtab ?? "st";
  const d = detailOf(source, selLane, selDone, pName, at);
  const tabs = (
    [
      ["st", "状況", ""],
      ["dec", "DEC", d.nDec],
      ["fd", "指摘", d.nFd],
    ] as [string, string, string][]
  ).map(([k, t, n]) => ({
    t,
    n,
    bg: tab === k ? "var(--surface)" : "transparent",
    sh: tab === k ? "0 0 0 1px var(--line)" : "none",
    c: tab === k ? "var(--ink)" : "var(--ink-2)",
    go: () => setState({ wtab: k }),
  }));

  // ---- the full band (32px rows)
  const Ov = buildStrip(build, setState, w, at, OV_LEN, OV_ROW_H, OV_LEFT, true);

  return {
    W: {
      ...listStrip,
      // the sidebar's 今日: the consumption door's number for the day, never the port's sample (DEC-103-1)
      todayCost: costText(source.consumption),
      ctx,
      list,
      projs,
      d,
      tabs,
      tSt: tab === "st",
      tDec: tab === "dec",
      tFd: tab === "fd",
      doneRows,
      doneOpen,
      nDone: String(doneK.length),
      doneChev: doneOpen ? "▾" : "▸",
      togDone: () => setState((s) => ({ wdone: !(s.wdone ?? false) })),
      hasSel,
      noSel: !hasSel,
      sum,
      askT: hasSel ? "この lane について聞く" : `${pName} について聞く`,
      mBars,
      mMarks,
      mLabels,
      mSel,
      mH: y,
      mNowX: mX(at),
      mTicks: ticksOf(w, MINI_LEN, xPos(at, w, MINI_LEN), 4),
      ovOpen: !!state.wopen,
      openOv: () => setState({ wopen: true }),
      closeOv: () => setState({ wopen: false }),
    },
    WOv: Ov,
  };
}
