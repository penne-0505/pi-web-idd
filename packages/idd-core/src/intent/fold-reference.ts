import { LANE_ENDED_EVENTS_REFERENCE } from "../plan/ledger-reads-reference.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import {
  FREE_WHILE_WHY, canonicalPlace,
  type ChoiceForms, type ChoiceOrigin, type HarmLevel, type IntentActor, type Place,
} from "./records.ts";
import type { PlaceMove } from "./rename.ts";
import type {
  ChoiceHistoryEntry, ChoiceView, ChoiceWaive, FoldedRecords, HarmExampleView, IntentRow, LaneState,
  PurposeView, Raised, WaiveView,
} from "./store.ts";

/**
 * The fold as it was written in TypeScript, kept as the thing the MoonBit fold is held against.
 *
 * Nothing on the running path calls this: `store.ts` folds through the MoonBit fold, and only the tests and
 * the cross-check run against a real ledger call these (`foldRowsTs`, `laneStatesTs`). It is the answer the
 * MoonBit fold has to reproduce, so it stays as it was written — the day the cross-check stops being needed,
 * this file goes with it (C-186-2). It reads the lane's end from the copy's own list, never from the fold's answer:
 * the end the fold takes for the lane's is the very thing this copy is here to disagree with (C-206-1).
 */

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function earlier(a: string, b: string): string {
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na <= nb ? a : b;
  return a <= b ? a : b;
}

export function isAfter(at: string, boundary: string): boolean {
  const a = Date.parse(at);
  const b = Date.parse(boundary);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a > b;
  return at > boundary;
}

export function laneStatesTs(events: LifecycleRecord[]): Map<string, LaneState> {
  const map = new Map<string, LaneState>();
  for (const e of events) {
    const state = map.get(e.idd_id) ?? {};
    if (e.event === "lane_close" && (e.attrs?.outcome === "merged" || e.attrs?.outcome === "local")) {
      state.mergedAt = state.mergedAt ? earlier(state.mergedAt, e.at) : e.at;
    }
    // the lane's own end, from the copy's list of the three rows that end it, took at the earliest of them
    if (LANE_ENDED_EVENTS_REFERENCE.includes(e.event)) {
      state.endedAt = state.endedAt ? earlier(state.endedAt, e.at) : e.at;
    }
    // the GO's confirmation of the lane's proposed Purposes: several GOs (a revise and a second GO) add up
    if (e.event === "s1_go" && Array.isArray(e.attrs?.purposes)) {
      const named = (e.attrs.purposes as unknown[]).flatMap((raw) => {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
        const id = (raw as Record<string, unknown>).id;
        if (typeof id !== "string" || !id.trim()) return [];
        const name = (raw as Record<string, unknown>).name;
        return [{ id: id.trim(), ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) }];
      });
      state.purposes = [...(state.purposes ?? []), ...named];
    }
    map.set(e.idd_id, state);
  }
  return map;
}

function rowEffective(row: IntentRow, viewer: string | null, states: Map<string, LaneState>): boolean {
  const by = row.by;
  const byLane = by && "lane" in by ? by.lane : null;
  if (!byLane) return true; // a session row is the lane's outside: it is effective at once
  const state = states.get(byLane);
  if (viewer && viewer === byLane) {
    return !(state?.endedAt && isAfter(row.at, state.endedAt));
  }
  return Boolean(state?.mergedAt && !isAfter(row.at, state.mergedAt));
}

function placesOf(raw: unknown): Place[] {
  // every Place a row carries is read as the module it names: a row written in the older `file` / `dir` form (by
  // another lane, a session, or a person's hand) means the same module as a row written in today's form
  return Array.isArray(raw) ? (raw as Place[]).map(canonicalPlace) : [];
}

/** the Place a move carries, or null when the move does not touch it */
function movedPlace(place: Place, move: PlaceMove): Place | null {
  const dirMove = move.from.endsWith("/");
  if (place.kind === "root") return null;
  // a Place with a file mark follows the file, and its module follows the file's new parent
  if (place.file) {
    const file = place.file;
    const next = file === move.from
      ? move.to
      : dirMove && file.startsWith(move.from) ? move.to.replace(/\/$/, "/") + file.slice(move.from.length) : null;
    if (next === null) return null;
    return { ...place, path: canonicalPlace({ path: next, kind: "file" }).path, file: next };
  }
  // a module with no file mark is a dir's own Choice: only a dir that moved carries it
  if (!dirMove) return null;
  const to = move.to.endsWith("/") ? move.to : `${move.to}/`;
  if (place.path === move.from) return { ...place, path: to };
  if (place.path.startsWith(move.from)) return { ...place, path: `${to}${place.path.slice(move.from.length)}` };
  return null;
}

/** the Place list with every move that touches it applied; null when no move touches it */
export function movedPlacesOf(places: Place[], moves: PlaceMove[]): Place[] | null {
  let changed = false;
  const next = places.map((place) => {
    let current = place;
    for (const move of moves) {
      const moved = movedPlace(current, move);
      if (moved) {
        current = moved;
        changed = true;
      }
    }
    return current;
  });
  return changed ? next : null;
}

/**
 * The one reading a replacement follows: the successor a row names takes the place of each Choice the row lists.
 * Both the raise that brings a new successor and the row that points at one already standing come here, so the
 * status, the successor and the grounds of a replaced Choice are decided by the same rule (C-204-2).
 */
function applySupersedes(
  choices: Map<string, ChoiceView>,
  successor: string,
  supersedes: unknown,
  at: string,
  by: IntentActor,
): void {
  const list = Array.isArray(supersedes) ? (supersedes as Record<string, unknown>[]) : [];
  for (const s of list) {
    const oldId = text(s.id);
    const old = oldId ? choices.get(oldId) : undefined;
    if (!old || (old.status !== "active" && old.status !== "unconfirmed")) continue;
    old.status = "superseded";
    const grounds = text(s.grounds);
    old.history.push({ at, event: "superseded", by, ...(grounds ? { grounds } : {}), successor });
  }
}

/** a Purpose standing in `from` ends in `to`, with the grounds when the row gave them */
function endPurpose(p: PurposeView | undefined, from: PurposeView["status"], to: PurposeView["status"], grounds: string | null): void {
  if (!p || p.status !== from) return;
  p.status = to;
  if (grounds) p.grounds = grounds;
}

export function foldRowsTs(rows: IntentRow[], viewer: string | null, states: Map<string, LaneState>): FoldedRecords {
  const purposes = new Map<string, PurposeView>();
  const choices = new Map<string, ChoiceView>();
  const waives: WaiveView[] = [];
  const harmExamples: HarmExampleView[] = [];
  for (const row of rows) {
    if (!rowEffective(row, viewer, states)) continue;
    const by = row.by;
    const at = row.at;
    switch (row.event) {
      case "purpose_raised": {
        const id = text(row.id);
        if (!id) break;
        // a row without a `by` still folds: the column is append-only and an older writer may have left it out
        const byLane = row.by && typeof row.by === "object" && "lane" in row.by ? row.by.lane : null;
        const named = byLane ? states.get(byLane)?.purposes?.find((p) => p.id === id) : undefined;
        const ownName = text(row.name);
        purposes.set(id, {
          id,
          statement: text(row.statement) ?? "",
          origin: text(row.origin) ?? "",
          ...(named?.name ? { name: named.name } : ownName ? { name: ownName } : {}),
          status: named ? "active" : row.status === "proposed" ? "proposed" : "active",
          raised: { by, at },
        });
        break;
      }
      case "purpose_restated": {
        const p = purposes.get(text(row.id) ?? "");
        const statement = text(row.statement);
        if (p && statement) {
          // the planner's sentence stays readable beside the person's: the first replacement keeps it
          if (statement !== p.statement) {
            if (p.raised_statement === undefined) p.raised_statement = p.statement;
            p.restated = { by, at };
          }
          p.statement = statement;
        }
        break;
      }
      case "purpose_confirmed": {
        const id = text(row.id);
        const p = id ? purposes.get(id) : undefined;
        if (p) {
          // the confirming row is written later: its name is the one the outside last gave
          const name = text(row.name);
          if (name) p.name = name;
          if (p.status === "proposed") p.status = "active";
        }
        break;
      }
      case "purpose_retired":
        endPurpose(purposes.get(text(row.id) ?? ""), "active", "retired", text(row.grounds));
        break;
      case "purpose_withdrawn":
        // only a proposal is withdrawn: an active Purpose ends by a retire, and a withdrawn one stays as it is
        endPurpose(purposes.get(text(row.id) ?? ""), "proposed", "withdrawn", text(row.grounds));
        break;
      case "choice_raised": {
        const id = text(row.id);
        if (!id) break;
        const origin = (row.origin as ChoiceOrigin | undefined) ?? { by: "agent" };
        const migratedCreated = origin.migrated?.created;
        const choice: ChoiceView = {
          id,
          purpose: text(row.purpose) ?? "",
          forms: (row.forms as ChoiceForms | undefined) ?? { chosen: "", rejected: [] },
          place: placesOf(row.place),
          why: text(row.why) ?? "",
          anchored: text(row.anchored) ?? "",
          free: text(row.free) ?? FREE_WHILE_WHY,
          ...(text(row.revisit) ? { revisit: text(row.revisit) as string } : {}),
          ...(Array.isArray(row.verification) && row.verification.length
            ? { verification: (row.verification as unknown[]).filter((v): v is string => typeof v === "string" && Boolean(v.trim())) }
            : {}),
          visibility: row.visibility === "public" ? "public" : "private",
          status: row.status === "unconfirmed" ? "unconfirmed" : "active",
          origin,
          // a migrated row keeps the document's own date for `created`, while `at` stays the row's time so the
          // lane-merge window (which decides whether the row applies at all) is read off the row itself
          history: [{ at: migratedCreated ?? at, event: "created", by }],
          waives: [],
        };
        const noWhyNot = text(row.no_why_not);
        if (noWhyNot) choice.waives.push({ reason: noWhyNot, by, at });
        choices.set(id, choice);
        applySupersedes(choices, id, row.supersedes, at, by);
        break;
      }
      case "choice_superseded": {
        const successor = text(row.id);
        if (!successor) break;
        applySupersedes(choices, successor, row.supersedes, at, by);
        break;
      }
      case "choice_reanchored": {
        const c = choices.get(text(row.id) ?? "");
        if (!c || (c.status !== "active" && c.status !== "unconfirmed")) break;
        if (Array.isArray(row.place)) c.place = placesOf(row.place);
        const anchored = text(row.anchored);
        // an unconfirmed Choice's re-anchor is a move of the Place alone: its anchored is a judgement about the
        // body, and only a confirmation or a Supersede may change that (C-145-1). A row carrying both can only
        // come from an older or hand-written column, so the anchored is left as it stands.
        if (anchored && c.status === "active") c.anchored = anchored;
        c.history.push({ at, event: "re-anchored", by });
        break;
      }
      case "places_moved": {
        // the landing's follow: the moves of this lane rewrite whatever still stands on the old path at this point
        // of the column, so an earlier row's own move is kept and a later one is not touched
        const moves = Array.isArray(row.moves)
          ? (row.moves as unknown[]).flatMap((raw) => {
            if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
            const from = text((raw as Record<string, unknown>).from);
            const to = text((raw as Record<string, unknown>).to);
            return from && to ? [{ from, to }] : [];
          })
          : [];
        if (!moves.length) break;
        for (const c of choices.values()) {
          if (c.status !== "active" && c.status !== "unconfirmed") continue;
          const moved = movedPlacesOf(c.place, moves);
          if (!moved) continue;
          c.place = moved;
          c.history.push({ at, event: "re-anchored", by });
        }
        break;
      }
      case "places_module": {
        // the conversion of the Places written before the module was the canonical form: the fold already reads
        // every Place as its module, so this row changes no reading. It stands in the column as the lane's own row
        // and no more: the conversion touches every Choice, so a history entry per Choice would name the lane as
        // the re-anchorer of records it neither raised nor moved, and the lane's own reading would list them as its.
        break;
      }
      case "choice_confirmed": {
        const c = choices.get(text(row.id) ?? "");
        if (c && c.status === "unconfirmed") {
          c.status = "active";
          c.history.push({ at, event: "confirmed", by });
        }
        break;
      }
      case "choice_dropped": {
        const c = choices.get(text(row.id) ?? "");
        if (c && c.status === "unconfirmed") {
          c.status = "dropped";
          const grounds = text(row.grounds);
          c.history.push({ at, event: "dropped", by, ...(grounds ? { grounds } : {}) });
        }
        break;
      }
      case "waive": {
        const kind = row.kind === "applied" ? "applied" : row.kind === "no-choice" ? "no-choice" : null;
        if (!kind) break;
        waives.push({
          kind,
          ...(Array.isArray(row.choices) ? { choices: row.choices.map(String) } : {}),
          ...(text(row.reason) ? { reason: text(row.reason) as string } : {}),
          ...(text(row.change) ? { change: text(row.change) as string } : {}),
          at,
          by,
        });
        break;
      }
      case "harm_example_added": {
        const id = text(row.id);
        const statement = text(row.statement);
        const harm = row.harm === 1 || row.harm === 2 || row.harm === 3 ? row.harm : null;
        if (!id || !statement || harm === null) break;
        harmExamples.push({ id, statement, harm: harm as HarmLevel, alwaysMust: row.always_must === true, at, by });
        break;
      }
      default:
        break;
    }
  }
  return { purposes: [...purposes.values()], choices: [...choices.values()], waives, harmExamples };
}

export type { ChoiceHistoryEntry, ChoiceWaive, Raised };
