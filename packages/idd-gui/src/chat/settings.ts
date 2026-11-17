/**
 * The conversation screen's switch for the features the engine keeps for every conversation: which skills a
 * conversation may read, and whether web search and MCP are on. Every value comes from the engine's answers
 * (DEC-103-1); a change reaches only the next pi (DEC-2011), so the value the open conversation's pi was
 * started with is drawn beside the switch and never mixed into it (C-174-3).
 *
 * The switch itself is the settings file's value. What this conversation's next pi will be handed is read
 * apart from it: a skill another cwd turned on is on in the settings but is never handed to a conversation
 * whose cwd cannot reach it (INV-1245), so it is listed apart and marked as not this conversation's.
 *
 * A conversation whose harness is Claude Code never receives these switches at all: only a pi's start reads
 * them, so the row never says "今 OFF · 次の pi から ON" there. The harness is the engine's answer alone; the
 * screen does not read it out of a mode's name (DEC-103-1).
 */
import { WORDS } from "../strings";
import type { ChatFeatures, ChatSettings, ChatStoreState, SkillCandidateView } from "./store";

/** where a skill lives; `other` is a skill that is on but is not a candidate for this conversation's cwd */
export type SkillRowOrigin = "user" | "workspace" | "repo" | "other";

export interface SettingsSkillRowView {
  path: string;
  name: string;
  description: string;
  origin: SkillRowOrigin;
  /** the settings value: the switch, what the settings file holds for every conversation */
  on: boolean;
  /** the open conversation's pi was started with it; null when the open door did not say */
  effective: boolean | null;
  /** this conversation's next pi will be handed it (a skill this cwd cannot reach never is) */
  next: boolean;
  /** the effective value and the next one differ: the change waits for the next pi */
  differs: boolean;
  /** the skill cannot be handed to a conversation in this cwd: it is on for another place's cwd */
  foreign: boolean;
  toggle: () => void;
}

export interface SettingsFeatureRowView {
  key: "webSearch" | "mcp";
  label: string;
  detail: string;
  /** the settings value: the switch */
  on: boolean;
  /** the open conversation's pi was started with it; null when the open door did not say */
  effective: boolean | null;
  /** the value the next pi will get: the settings value, because these two are not cwd-scoped */
  next: boolean;
  differs: boolean;
  toggle: () => void;
}

export interface SettingsGroupView {
  origin: SkillRowOrigin;
  label: string;
  rows: SettingsSkillRowView[];
}

/** the switch as the popover draws it, with every value the engine answered and nothing invented */
export interface ChatSettingsView {
  /** the settings file the engine read, drawn as a footnote */
  path: string;
  loading: boolean;
  /** the engine's refusal of the last read or change; the rows keep the engine's last values */
  error: string | null;
  /** a change is on its way */
  busy: boolean;
  groups: SettingsGroupView[];
  /** web search and MCP, the two switches that are not skills */
  features: SettingsFeatureRowView[];
  /** the sentence that says a change reaches every conversation's next pi */
  scopeNote: string;
  /**
   * whether the settings' switches reach this conversation's next start: true for pi, false for Claude Code,
   * and null when the open door did not say. Only the engine's `harness` decides it.
   */
  featuresApply: boolean | null;
  /** the settings file holds nothing to switch: the door answered but the screen shows no row */
  empty: boolean;
  /** the open conversation's pi values are unknown, so every row says so instead of guessing */
  effectiveKnown: boolean;
}

export interface ConversationSettingsHandlers {
  setSkill: (path: string, on: boolean) => void;
  setFeature: (key: "webSearch" | "mcp", on: boolean) => void;
}

/** the order the places are drawn in: the user's own first, then this cwd, then the repo, then the rest */
const ORIGIN_ORDER: SkillRowOrigin[] = ["user", "workspace", "repo", "other"];

/** the last segment of a path, for a skill the engine did not name because it is not this cwd's candidate */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function skillRow(candidate: SkillCandidateView, settings: ChatSettings | null, effectiveSkills: string[] | null, on: ConversationSettingsHandlers): SettingsSkillRowView {
  const value = settings ? settings.values.skills.includes(candidate.path) : false;
  const effective = effectiveSkills === null ? null : effectiveSkills.includes(candidate.path);
  return {
    path: candidate.path,
    name: candidate.name,
    description: candidate.description,
    origin: candidate.origin,
    on: value,
    effective,
    next: value,
    differs: effective !== null && effective !== value,
    foreign: false,
    toggle: () => on.setSkill(candidate.path, !value),
  };
}

/** a skill that is on but is not a candidate for this cwd: kept in the list so it can be turned off again */
function foreignRow(path: string, effectiveSkills: string[] | null, on: ConversationSettingsHandlers): SettingsSkillRowView {
  const effective = effectiveSkills === null ? null : effectiveSkills.includes(path);
  return {
    path,
    name: lastSegment(path),
    description: "",
    origin: "other",
    on: true,
    effective,
    next: false,
    differs: effective !== null && effective !== false,
    foreign: true,
    toggle: () => on.setSkill(path, false),
  };
}

export function conversationSettingsVals(state: ChatStoreState, on: ConversationSettingsHandlers): ChatSettingsView {
  const settings = state.settings;
  const features: ChatFeatures | null = state.open?.features ?? null;
  const effectiveSkills = features?.skills ?? null;
  const rows: SettingsSkillRowView[] = [];
  const known = new Set<string>();
  for (const candidate of settings?.candidates ?? []) {
    known.add(candidate.path);
    rows.push(skillRow(candidate, settings, effectiveSkills, on));
  }
  for (const path of settings?.values.skills ?? []) {
    if (known.has(path)) continue;
    rows.push(foreignRow(path, effectiveSkills, on));
  }
  const groups: SettingsGroupView[] = [];
  for (const origin of ORIGIN_ORDER) {
    const groupRows = rows.filter((row) => row.origin === origin).sort((a, b) => a.name.localeCompare(b.name));
    if (groupRows.length) groups.push({ origin, label: WORDS.chat.settings.origins[origin], rows: groupRows });
  }
  const values = settings?.values ?? null;
  // the settings are handed to a pi's start alone: a Claude Code conversation never reads them
  const harness = state.open?.harness ?? null;
  const featuresApply: boolean | null = harness === null ? null : harness === "pi";
  const featureRow = (key: "webSearch" | "mcp", label: string, detail: string, value: boolean): SettingsFeatureRowView => {
    const effective = features === null ? null : key === "webSearch" ? features.webSearch : features.mcp;
    return { key, label, detail, on: value, effective, next: value, differs: effective !== null && effective !== value, toggle: () => on.setFeature(key, !value) };
  };
  return {
    path: settings?.path ?? "",
    loading: settings?.loading ?? true,
    error: settings?.error ?? null,
    busy: settings?.busy ?? false,
    groups,
    features: values
      ? [
          featureRow("webSearch", WORDS.chat.settings.webSearch, WORDS.chat.settings.webSearchDetail, values.webSearch),
          featureRow("mcp", WORDS.chat.settings.mcp, WORDS.chat.settings.mcpDetail, values.mcp),
        ]
      : [],
    scopeNote: featuresApply === false ? WORDS.chat.settings.scopeOtherConversations : WORDS.chat.settings.scope,
    featuresApply,
    empty: values !== null && !rows.length,
    effectiveKnown: features !== null,
  };
}
