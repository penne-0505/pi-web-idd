/**
 * Where a user's instruction applies, and the one rule that decides it. An instruction declares three ranges when it
 * is written: the repos, the scenes (what the agent is doing) and the places (a lane's stage or a conversation). It
 * reaches a run or a conversation only when all three match; one miss and it stays out. The match is a set
 * membership test over the three ranges, so the same ranges and the same situation always give the same answer: no
 * model decides which instruction applies.
 */

/** what an agent is doing: the stage groups a lane runs, and the conversation */
export const SCENES = ["plan", "implement", "review", "triage", "pr", "reply", "chat"] as const;
export type Scene = (typeof SCENES)[number];

/** the label a card and the readable copy show for a scene */
export const SCENE_LABELS: Record<Scene, string> = {
  plan: "計画",
  implement: "実装",
  review: "レビュー",
  triage: "判定",
  pr: "PR 本文と commit message",
  reply: "返信・投稿の下書き",
  chat: "会話",
};

/** where an agent runs: a lane's stage, or a conversation. Not a conversation's mode (chat / idea) */
export const PLACES = ["lane", "conversation"] as const;
export type Place = (typeof PLACES)[number];

export const PLACE_LABELS: Record<Place, string> = { lane: "lane の段", conversation: "会話" };

/**
 * The scene each stage belongs to. The review scene holds every stage that reads a diff or a plan to judge it: the
 * plan review, the blind review, the last review, the spec check and the confirmations (`map` picks what the blind reads and
 * `device` looks at the screen). A stage that is not here has no scene and gets no instruction.
 */
const SCENE_OF_STAGE: Record<string, Scene> = {
  plan: "plan",
  exec: "implement",
  fix: "implement",
  fix_plan: "implement",
  plan_review: "review",
  blind: "review",
  final: "review",
  spec: "review",
  confirm: "review",
  feedback_confirm: "review",
  device: "review",
  map: "review",
  triage: "triage",
  feedback: "triage",
  feedback_leftovers: "triage",
};

/** the scene of a lane stage, or null for a stage no instruction is written for */
export function sceneOfStage(stage: string | undefined): Scene | null {
  if (!stage) return null;
  return SCENE_OF_STAGE[stage] ?? null;
}

/** the place a scene is run in: the conversation's scene is `chat`, every other one is a lane's stage */
export function placeOfScene(scene: Scene): Place {
  return scene === "chat" ? "conversation" : "lane";
}

/** the ranges one instruction declares; `"all"` is every value of the axis */
export interface Scope {
  repos: string[] | "all";
  scenes: Scene[] | "all";
  places: Place[] | "all";
}

/** what a run or a conversation is: the repo it belongs to (when it has one), the scene and the place */
export interface Situation {
  repo?: string;
  scene: Scene;
  place: Place;
}

export const ALL_SCOPE: Scope = { repos: "all", scenes: "all", places: "all" };

/** whether one scope matches a situation: all three ranges must contain the situation's value */
export function scopeMatches(scope: Scope, situation: Situation): boolean {
  if (scope.repos !== "all" && (situation.repo === undefined || !scope.repos.includes(situation.repo))) return false;
  if (scope.scenes !== "all" && !scope.scenes.includes(situation.scene)) return false;
  if (scope.places !== "all" && !scope.places.includes(situation.place)) return false;
  return true;
}

/** a scope names a scene and a place that can never meet (a lane scene on a conversation only, for one) */
function reachable(scope: Scope): boolean {
  const scenes = scope.scenes === "all" ? SCENES : scope.scenes;
  const places = scope.places === "all" ? PLACES : scope.places;
  return scenes.some((s) => places.includes(placeOfScene(s)));
}

const REPO_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function axis<T extends string>(value: unknown, name: string, valid: (v: string) => v is T, words: string): { ok: true; value: T[] | "all" } | { ok: false; error: string } {
  if (value === "all") return { ok: true, value: "all" };
  if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== "string")) {
    return { ok: false, error: `範囲の ${name} は "all" か、空でない文字列の一覧です` };
  }
  const bad = (value as string[]).filter((v) => !valid(v));
  if (bad.length) return { ok: false, error: `範囲の ${name} に知らない値があります: ${bad.join(", ")}（${words}）` };
  return { ok: true, value: [...new Set(value as string[])] as T[] };
}

const isRepoKey = (v: string): v is string => REPO_KEY.test(v);
const isScene = (v: string): v is Scene => (SCENES as readonly string[]).includes(v);
const isPlace = (v: string): v is Place => (PLACES as readonly string[]).includes(v);
const UNREACHABLE = "範囲の場面と場所が重なりません（会話の場面は chat、それ以外は lane の段です）";

/**
 * A scope read from a payload or a file. An unknown scene or place, a repo that is not `owner/name`, and a scope
 * whose scenes and places never meet are refused here, at the time it is declared.
 */
export function normalizeScope(raw: unknown): { ok: true; scope: Scope } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "範囲（repos・scenes・places）が必要です" };
  const r = raw as Record<string, unknown>;
  const repos = axis(r.repos, "repos", isRepoKey, "owner/name の形");
  if (!repos.ok) return repos;
  const scenes = axis(r.scenes, "scenes", isScene, `場面: ${SCENES.join(", ")}`);
  if (!scenes.ok) return scenes;
  const places = axis(r.places, "places", isPlace, `場所: ${PLACES.join(", ")}`);
  if (!places.ok) return places;
  const scope: Scope = { repos: repos.value, scenes: scenes.value, places: places.value };
  if (!reachable(scope)) return { ok: false, error: UNREACHABLE };
  return { ok: true, scope };
}

/** the axes a change proposal names; an axis it does not name keeps the instruction's value (a change is a difference) */
export type PartialScope = Partial<Scope>;

/** a partial scope read from a payload or a file: each named axis is checked as in a whole scope, and at least one is named */
export function normalizePartialScope(raw: unknown): { ok: true; scope: PartialScope } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "範囲（repos・scenes・places のどれか）が必要です" };
  const r = raw as Record<string, unknown>;
  const scope: PartialScope = {};
  if (r.repos !== undefined) {
    const repos = axis(r.repos, "repos", isRepoKey, "owner/name の形");
    if (!repos.ok) return repos;
    scope.repos = repos.value;
  }
  if (r.scenes !== undefined) {
    const scenes = axis(r.scenes, "scenes", isScene, `場面: ${SCENES.join(", ")}`);
    if (!scenes.ok) return scenes;
    scope.scenes = scenes.value;
  }
  if (r.places !== undefined) {
    const places = axis(r.places, "places", isPlace, `場所: ${PLACES.join(", ")}`);
    if (!places.ok) return places;
    scope.places = places.value;
  }
  if (scope.repos === undefined && scope.scenes === undefined && scope.places === undefined) return { ok: false, error: "範囲の repos・scenes・places のどれかを指定してください" };
  return { ok: true, scope };
}

/** the scope a change makes: the instruction's own value for every axis the change does not name */
export function applyPartialScope(current: Scope, change: PartialScope): { ok: true; scope: Scope } | { ok: false; error: string } {
  const scope: Scope = { repos: change.repos ?? current.repos, scenes: change.scenes ?? current.scenes, places: change.places ?? current.places };
  if (!reachable(scope)) return { ok: false, error: UNREACHABLE };
  return { ok: true, scope };
}

/** the axes a change names, as a line for a card: the axes it leaves alone say they keep the current value */
export function describePartialScope(current: Scope | undefined, change: PartialScope): string {
  const axes = {
    repos: change.repos === undefined ? "repo は今のまま" : `repo: ${change.repos === "all" ? "すべての repo" : change.repos.join("・")}`,
    scenes: change.scenes === undefined ? "場面は今のまま" : `場面: ${change.scenes === "all" ? "すべての場面" : change.scenes.map((s) => SCENE_LABELS[s]).join("・")}`,
    places: change.places === undefined ? "場所は今のまま" : `場所: ${change.places === "all" ? "どこでも" : change.places.map((p) => PLACE_LABELS[p]).join("・")}`,
  };
  const line = `${axes.repos} / ${axes.scenes} / ${axes.places}`;
  if (!current) return line;
  const result = applyPartialScope(current, change);
  return result.ok ? `${line}（変えた後: ${describeScope(result.scope)}）` : line;
}

/** one scope as a short line for a card and the readable copy */
export function describeScope(scope: Scope): string {
  const repos = scope.repos === "all" ? "すべての repo" : scope.repos.join("・");
  const scenes = scope.scenes === "all" ? "すべての場面" : scope.scenes.map((s) => SCENE_LABELS[s]).join("・");
  const places = scope.places === "all" ? "どこでも" : scope.places.map((p) => PLACE_LABELS[p]).join("・");
  return `${repos} / ${scenes} / ${places}`;
}
