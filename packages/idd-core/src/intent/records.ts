/**
 * The shape of a v2 intent record, and the one place its input is checked. The engine's door and the CLI both
 * call these functions, so a caller never sends something the other side would have refused. What is checked
 * here is the shape alone: a Place is looked at for its form, never for whether the path is on disk (the plan
 * writes a Choice before the file it governs exists).
 */

/** `withdrawn` is a proposal a person took back before the GO: it never took effect, so it is not `retired` */
export type PurposeStatus = "proposed" | "active" | "retired" | "withdrawn";
/** the two statuses a raise may ask for; the other two are derived by Supersede and the drop */
export type RaisedChoiceStatus = "active" | "unconfirmed";
export type ChoiceStatus = "active" | "unconfirmed" | "superseded" | "dropped";
export type PlaceKind = "module" | "root" | "file" | "dir";
export type Visibility = "private" | "public";

/** who wrote a row: a lane's agent, or a chat session (the lane's outside) */
export type IntentActor = { lane: string } | { session: string };

/**
 * Where a Choice holds: one module of the repo's tree. The module is the file's own parent directory (a dir's Place
 * is the dir itself), so a rename, a split or a move of a file leaves the module standing and the Choice keeps
 * reaching the code it governs. `file` and `symbols` are marks: they say which file inside the module the Choice
 * was written against, and narrow the injection and the planner's disposal to it, but a mark that no longer stands
 * is a maintenance mark and never a defect. The `dir` and `file` kinds are the older form, still accepted and read
 * as the module they name (`canonicalPlace` writes no `dir` or `file` Place of its own).
 */
export interface Place {
  /** repo-root relative; a module keeps its trailing `/`, the repo's own root module and a root Place are `/` */
  path: string;
  kind: PlaceKind;
  /** the mark: the file inside the module this Place was written against */
  file?: string;
  symbols?: string[];
}

export interface RejectedForm {
  form: string;
  fails_because: string;
}

export interface ChoiceForms {
  chosen: string;
  rejected: RejectedForm[];
}

/** how a migrated Choice's Purpose was decided: the mechanical assignment, or a person's review */
export type MigrationPurposeFrom = "移行時の割り当て" | "人の見直し";

/**
 * Where a migrated Choice came from, as the migration entrance carries it. Only the lane's outside may name it:
 * it can say a person reviewed the record and when the record was written, so a lane passing it could pass its own
 * Choice off as an old, human-checked one. It rides onto the row's `origin` rather than the body's fields.
 */
export interface ChoiceMigration {
  /** repo-relative path of the decision document the record was read from */
  doc: string;
  purpose_from: MigrationPurposeFrom;
  /** the DEC's Source text, when it names one */
  source?: string;
  /** the document's own date (`YYYY-MM-DD`); the fold uses it for the created history entry */
  created?: string;
}

/** where a Choice came from: a question the person answered turns the origin human; a migrated record names its source */
export interface ChoiceOrigin {
  by: "agent" | "human";
  question?: string;
  migrated?: ChoiceMigration;
}

/** a Choice as its raise carries it, before an actor's rules (id, status) are applied */
export interface ChoiceBody {
  purpose: string;
  forms: ChoiceForms;
  place: Place[];
  why: string;
  anchored: string;
  /**
   * Absent when the caller's body did not name one: the store fills the repo's `visibility_default` before the
   * row is written, and the CLI must not add a value the body did not carry.
   */
  visibility?: Visibility;
  free?: string;
  revisit?: string;
  question?: string;
  no_why_not?: string;
  /**
   * the verification anchors: test names (or an AC id) that would go red if this Choice's behaviour broke. Optional,
   * because not every Choice guards a behaviour; a test that leaves the tree is a maintenance mark, never a defect.
   */
  verification?: string[];
  /** the migration entrance: only the lane's outside may name it, and only in the `DEC-` and `INV-` forms */
  id?: string;
  status?: RaisedChoiceStatus;
  /** the migration entrance: only the lane's outside may name it */
  migration?: ChoiceMigration;
}

export interface PurposeBody {
  statement: string;
  origin: string;
  id?: string;
  /** an optional short handle; the statement is 1-3 sentences and does not fit a list row */
  name?: string;
}

export interface ReanchorBody {
  place?: Place[];
  anchored?: string;
}

/** the four things an agent may only ask for: the overview's statement, a root Choice's replacement or re-anchor, a harm example */
export type ProposalKind = "overview" | "root_supersede" | "root_reanchor" | "harm_example";

export const PROPOSAL_KINDS: readonly ProposalKind[] = ["overview", "root_supersede", "root_reanchor", "harm_example"];

/** the three weights of a harm example; 3 is the irreversibly damaging one */
export type HarmLevel = 1 | 2 | 3;

/** the shape one proposal carries, by kind; the fields a kind does not use are absent */
export interface ProposalBody {
  /** overview / harm_example: the statement the proposal would write */
  statement?: string;
  /** root_supersede: the Choices to replace, the Grounds, and the successor's own body */
  ids?: string[];
  grounds?: string;
  choice?: ChoiceBody;
  /** root_reanchor: the Choice and its new Place / anchored */
  id?: string;
  place?: Place[];
  anchored?: string;
  /** harm_example: the weight, and whether it is a must whatever its frequency */
  harm?: HarmLevel;
  always_must?: true;
}

export type ShapeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What a Choice with no `free` is read as: the record's own Why is the whole boundary. Kept as one constant
 * so the readers and the tests name the same words.
 */
export const FREE_WHILE_WHY = "why を保つ限り自由";

/** the `DEC-<n>` / `DEC-<lane>-<n>` / `DEC-<Area>-<n>` forms a migrated Choice keeps as its id */
export const MIGRATED_CHOICE_ID = /^DEC-(?:\d+(?:-[1-9]\d*)?|[A-Za-z][A-Za-z0-9_-]*-[1-9]\d*)$/;
/** the same three forms with the `INV-` head, for a Choice migrated from a parentless INV */
export const MIGRATED_INV_ID = /^INV-(?:\d+(?:-[1-9]\d*)?|[A-Za-z][A-Za-z0-9_-]*-[1-9]\d*)$/;

export function isMigratedChoiceId(id: string): boolean {
  return MIGRATED_CHOICE_ID.test(id) || MIGRATED_INV_ID.test(id);
}

export function isPurposeId(id: string): boolean {
  return /^P-\d+$/.test(id);
}

/**
 * The id of the Purpose whose statement is the repo's 概要: the projections, the overview proposal and the GO
 * confirmation all name the same record, so the id is written once here.
 */
export const OVERVIEW_PURPOSE_ID = "P-1";

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** a non-empty trimmed string, or null */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** the symbols of a Place: absent, or a list of non-empty strings */
function symbolsOf(raw: unknown): { symbols?: string[] } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || !s.trim())) {
    return { error: "place の symbols は空でない文字列の一覧にしてください" };
  }
  return { symbols: (raw as string[]).map((s) => s.trim()) };
}

/** the module a repo-root relative file or dir path belongs to: the file's own parent dir, or `/` at the top */
export function moduleOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "/" : path.slice(0, at + 1);
}

/**
 * The Place every reader uses: the module it names, with the file it was written against kept as a mark. The `file`
 * kind becomes its parent dir with that file as the mark, and the `dir` kind becomes the same dir as a module. A
 * module and a root Place are left as they stand, so running this twice writes the same value.
 */
export function canonicalPlace(place: Place): Place {
  const withSymbols = place.symbols?.length ? { symbols: place.symbols } : {};
  if (place.kind === "root") return { path: "/", kind: "root", ...withSymbols };
  if (place.kind === "module") return place;
  if (place.kind === "file") return { path: moduleOf(place.path), kind: "module", file: place.path, ...withSymbols };
  // the older `dir` kind names the module itself, with no file to mark
  return { path: place.path, kind: "module", ...withSymbols };
}

/** every Place of a Choice in the canonical form, in the order they were written */
export function canonicalPlaces(places: Place[]): Place[] {
  return places.map(canonicalPlace);
}

/**
 * The mark a module keeps: the file inside it this Place was written against, checked as a repo-relative file name
 * of that module. Absent when the Place names none.
 */
function fileMarkOf(raw: unknown, kind: string, module: string): { file?: string } | { error: string } {
  if (raw === undefined || raw === null) return {};
  const rawFile = typeof raw === "string" ? raw.trim() : "";
  if (!rawFile) return { error: "place の file が空です" };
  if (rawFile.startsWith("/") || /\s/.test(rawFile) || rawFile.split("/").includes("..") || rawFile.endsWith("/")) {
    return { error: `place の file は repo の root からの相対のファイル名にしてください: ${rawFile}` };
  }
  if (kind !== "module") return { error: "place の file は kind が module のときだけ書けます" };
  if (moduleOf(rawFile) !== module) return { error: `place の file ${rawFile} は module ${module} の下にありません` };
  return { file: rawFile };
}

/** one Place: the module it names (canonical), or the older `file` / `dir` form, read as that module */
export function normalizePlace(raw: unknown): ShapeResult<Place> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "place は表で書いてください" };
  const kind = o.kind;
  if (kind !== "file" && kind !== "dir" && kind !== "root" && kind !== "module") {
    return { ok: false, error: `place の kind は module / file / dir / root のどれかにしてください: ${String(kind)}` };
  }
  const symbols = symbolsOf(o.symbols);
  if ("error" in symbols) return { ok: false, error: symbols.error };
  const withSymbols = symbols.symbols ? { symbols: symbols.symbols } : {};
  if (kind === "root") {
    if (o.path !== "/") return { ok: false, error: "kind が root の place の path は / だけです" };
    return { ok: true, value: { path: "/", kind: "root", ...withSymbols } };
  }
  const rawPath = typeof o.path === "string" ? o.path : "";
  if (!rawPath) return { ok: false, error: "place の path が空です" };
  // the repo's own module: the dir of a file at the top of the tree, or a Place meaning the whole repo's code
  if (rawPath === "/" || rawPath === "./") {
    if (kind === "file") return { ok: false, error: "kind が file の place の path に / は使えません" };
    // a file at the top of the tree belongs to this module too, and its name is the mark that keeps it precise
    const mark = fileMarkOf(o.file, kind, "/");
    if ("error" in mark) return { ok: false, error: mark.error };
    return { ok: true, value: canonicalPlace({ path: "/", kind: "module", ...(mark.file ? { file: mark.file } : {}), ...withSymbols }) };
  }
  if (rawPath.startsWith("/")) return { ok: false, error: `place の path は repo の root からの相対にしてください: ${rawPath}` };
  if (/\s/.test(rawPath)) return { ok: false, error: `place の path に空白を含めません: ${rawPath}` };
  if (rawPath.split("/").includes("..")) return { ok: false, error: `place の path に .. を含めません: ${rawPath}` };
  const path = rawPath.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!path || path === "/") return { ok: false, error: "place の path が空です" };
  const dirShaped = kind === "dir" || kind === "module";
  if (!dirShaped && path.endsWith("/")) return { ok: false, error: `kind が ${kind} の place の path は / で終われません: ${path}` };
  if (dirShaped && !path.endsWith("/")) return { ok: false, error: `kind が ${kind} の place の path は / で終わってください: ${path}` };
  // the mark: the file inside the module this Place was written against
  const mark = fileMarkOf(o.file, kind, path);
  if ("error" in mark) return { ok: false, error: mark.error };
  const value = canonicalPlace({ path, kind, ...(mark.file ? { file: mark.file } : {}), ...withSymbols });
  return { ok: true, value };
}

/** the Place list of a Choice: one or more, each of the four forms; every Place comes back canonical */
export function normalizePlaces(raw: unknown): ShapeResult<Place[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "place は 1 つ以上の一覧で書いてください" };
  const places: Place[] = [];
  for (const item of raw) {
    const one = normalizePlace(item);
    if (!one.ok) return one;
    places.push(one.value);
  }
  return { ok: true, value: places };
}

/** chosen, and the rejected forms; each rejected item needs both its form and why that form fails */
function chooseForms(raw: unknown): ShapeResult<ChoiceForms> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "必須の欄 forms が表ではありません" };
  const chosen = text(o.chosen);
  if (!chosen) return { ok: false, error: "必須の欄 forms.chosen が空です" };
  const rawRejected = o.rejected;
  if (rawRejected !== undefined && rawRejected !== null && !Array.isArray(rawRejected)) {
    return { ok: false, error: "forms.rejected は一覧で書いてください" };
  }
  const rejected: RejectedForm[] = [];
  for (const item of Array.isArray(rawRejected) ? rawRejected : []) {
    const i = asRecord(item);
    const form = i ? text(i.form) : null;
    const fails = i ? text(i.fails_because) : null;
    if (!form || !fails) return { ok: false, error: "forms.rejected の各項には form と fails_because の両方が要ります" };
    rejected.push({ form, fails_because: fails });
  }
  return { ok: true, value: { chosen, rejected } };
}

function visibilityOf(raw: unknown): ShapeResult<Visibility | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (raw === "private" || raw === "public") return { ok: true, value: raw };
  return { ok: false, error: `visibility は private か public にしてください: ${String(raw)}` };
}

/** an optional free-form line; absent is fine, a non-string is not */
function optionalText(raw: unknown, name: string): ShapeResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const t = text(raw);
  if (!t) return { ok: false, error: `${name} は空でない文字列にしてください` };
  return { ok: true, value: t };
}

/** a list of non-empty strings: absent is fine, anything else is not */
function stringListOf(raw: unknown, name: string): ShapeResult<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((s) => typeof s !== "string" || !s.trim())) {
    return { ok: false, error: `${name} は空でない文字列の一覧にしてください` };
  }
  return { ok: true, value: (raw as string[]).map((s) => s.trim()) };
}

const MIGRATION_PURPOSE_FROM = ["移行時の割り当て", "人の見直し"] as const;

/** the migration entrance's source record; its shape is checked here so an ill-shaped one never reaches a row */
export function normalizeMigration(raw: unknown): ShapeResult<ChoiceMigration> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "migration は表で書いてください" };
  const doc = text(o.doc);
  if (!doc) return { ok: false, error: "必須の欄 migration.doc が空です" };
  const purposeFrom = o.purpose_from;
  if (purposeFrom !== "移行時の割り当て" && purposeFrom !== "人の見直し") {
    return { ok: false, error: `migration.purpose_from は ${MIGRATION_PURPOSE_FROM.join(" か ")} にしてください: ${String(purposeFrom)}` };
  }
  const source = optionalText(o.source, "migration.source");
  if (!source.ok) return source;
  let created: string | undefined;
  if (o.created !== undefined && o.created !== null) {
    const c = text(o.created);
    if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(c)) {
      return { ok: false, error: `migration.created は YYYY-MM-DD にしてください: ${String(o.created)}` };
    }
    created = c;
  }
  return {
    ok: true,
    value: { doc, purpose_from: purposeFrom, ...(source.value ? { source: source.value } : {}), ...(created ? { created } : {}) },
  };
}

/**
 * The body of a raise or a Supersede successor. The required fields are purpose, forms, place, why and anchored;
 * a Choice with no rejected form needs the no-why-not reason on the same call, so the state never holds a Choice
 * with neither (the two are one row).
 */
export function normalizeChoiceBody(raw: unknown): ShapeResult<ChoiceBody> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "choice の本文は表で書いてください" };
  const purpose = text(o.purpose);
  if (!purpose) return { ok: false, error: "必須の欄 purpose が空です" };
  const forms = chooseForms(o.forms);
  if (!forms.ok) return forms;
  const place = normalizePlaces(o.place);
  if (!place.ok) return place;
  const why = text(o.why);
  if (!why) return { ok: false, error: "必須の欄 why が空です" };
  const anchored = text(o.anchored);
  if (!anchored) return { ok: false, error: "必須の欄 anchored が空です" };
  const visibility = visibilityOf(o.visibility);
  if (!visibility.ok) return visibility;
  const noWhyNot = optionalText(o.no_why_not, "no_why_not");
  if (!noWhyNot.ok) return noWhyNot;
  if (forms.value.rejected.length === 0 && !noWhyNot.value) {
    return { ok: false, error: "forms.rejected が空なら no_why_not に理由を書いてください" };
  }
  const free = optionalText(o.free, "free");
  if (!free.ok) return free;
  const revisit = optionalText(o.revisit, "revisit");
  if (!revisit.ok) return revisit;
  const question = optionalText(o.question, "question");
  if (!question.ok) return question;
  const verification = stringListOf(o.verification, "verification");
  if (!verification.ok) return verification;
  const id = optionalText(o.id, "id");
  if (!id.ok) return id;
  let migration: ChoiceMigration | undefined;
  if (o.migration !== undefined && o.migration !== null) {
    const m = normalizeMigration(o.migration);
    if (!m.ok) return m;
    migration = m.value;
  }
  let status: RaisedChoiceStatus | undefined;
  if (o.status !== undefined && o.status !== null) {
    if (o.status !== "active" && o.status !== "unconfirmed") {
      return { ok: false, error: `status は active か unconfirmed にしてください: ${String(o.status)}` };
    }
    status = o.status;
  }
  return {
    ok: true,
    value: {
      purpose, forms: forms.value, place: place.value, why, anchored,
      ...(visibility.value ? { visibility: visibility.value } : {}),
      ...(free.value ? { free: free.value } : {}),
      ...(revisit.value ? { revisit: revisit.value } : {}),
      ...(question.value ? { question: question.value } : {}),
      ...(verification.value ? { verification: verification.value } : {}),
      ...(noWhyNot.value ? { no_why_not: noWhyNot.value } : {}),
      ...(id.value ? { id: id.value } : {}),
      ...(migration ? { migration } : {}),
      ...(status ? { status } : {}),
    },
  };
}

/** the body of a Purpose raise: statement, origin and an optional short name */
export function normalizePurposeBody(raw: unknown): ShapeResult<PurposeBody> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "purpose の本文は表で書いてください" };
  const statement = text(o.statement);
  if (!statement) return { ok: false, error: "必須の欄 statement が空です" };
  const origin = text(o.origin);
  if (!origin) return { ok: false, error: "必須の欄 origin が空です" };
  const id = optionalText(o.id, "id");
  if (!id.ok) return id;
  const name = optionalText(o.name, "name");
  if (!name.ok) return name;
  return { ok: true, value: { statement, origin, ...(id.value ? { id: id.value } : {}), ...(name.value ? { name: name.value } : {}) } };
}

/**
 * The body of a proposal, checked by its kind alone. What a proposal would change is held whole here: the approval
 * writes the effect from this body, so a body that is not complete and well-shaped never reaches a row.
 */
export function normalizeProposalBody(kind: string, raw: unknown): ShapeResult<{ kind: ProposalKind; body: ProposalBody }> {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `提案の種類は ${PROPOSAL_KINDS.join(" / ")} のどれかにしてください: ${kind}` };
  }
  const k = kind as ProposalKind;
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "提案の本文は表で書いてください" };
  if (k === "overview") {
    const statement = text(o.statement);
    if (!statement) return { ok: false, error: "必須の欄 statement が空です" };
    return { ok: true, value: { kind: k, body: { statement } } };
  }
  if (k === "harm_example") {
    const statement = text(o.statement);
    if (!statement) return { ok: false, error: "必須の欄 statement が空です" };
    if (o.harm !== 1 && o.harm !== 2 && o.harm !== 3) {
      return { ok: false, error: `must の欄 harm は 1 / 2 / 3 のどれかにしてください: ${String(o.harm)}` };
    }
    if (o.always_must !== undefined && o.always_must !== true) {
      return { ok: false, error: "always_must は true か、書かないかにしてください" };
    }
    return { ok: true, value: { kind: k, body: { statement, harm: o.harm, ...(o.always_must === true ? { always_must: true as const } : {}) } } };
  }
  if (k === "root_supersede") {
    const ids = Array.isArray(o.ids) ? o.ids.map((v) => text(v)).filter((v): v is string => Boolean(v)) : [];
    if (!ids.length) return { ok: false, error: "置き換える Choice の ID を 1 つ以上渡してください" };
    const grounds = text(o.grounds);
    if (!grounds) return { ok: false, error: "必須の欄 grounds が空です" };
    const choice = normalizeChoiceBody(o.choice);
    if (!choice.ok) return choice;
    return { ok: true, value: { kind: k, body: { ids, grounds, choice: choice.value } } };
  }
  const id = text(o.id);
  if (!id) return { ok: false, error: "id が空です" };
  const body = normalizeReanchorBody({ place: o.place, anchored: o.anchored });
  if (!body.ok) return body;
  return { ok: true, value: { kind: k, body: { id, ...body.value } } };
}

/** the body of a Re-anchor: at least one of place and anchored */
export function normalizeReanchorBody(raw: unknown): ShapeResult<ReanchorBody> {
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "re-anchor の本文は表で書いてください" };
  let place: Place[] | undefined;
  if (o.place !== undefined && o.place !== null) {
    const p = normalizePlaces(o.place);
    if (!p.ok) return p;
    place = p.value;
  }
  let anchored: string | undefined;
  if (o.anchored !== undefined && o.anchored !== null) {
    const a = text(o.anchored);
    if (!a) return { ok: false, error: "anchored は空でない文字列にしてください" };
    anchored = a;
  }
  if (!place && !anchored) return { ok: false, error: "place と anchored の少なくとも 1 つを渡してください" };
  return { ok: true, value: { ...(place ? { place } : {}), ...(anchored ? { anchored } : {}) } };
}
