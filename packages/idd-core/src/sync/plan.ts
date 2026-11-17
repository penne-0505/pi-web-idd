import { createHash } from "node:crypto";

import type {
  Baseline, ConflictProposal, ConflictUnit, ExtIssue, ExtProject, ExtSnapshot, PropterSide, SyncPlan, TrackerSyncConfig,
} from "./types.ts";

/**
 * The three-way compare. For every unit (a Project's body, an Issue's Project, an Issue's state) the outside's value now,
 * propter's value now and the baseline's value (the last synced copy) are compared:
 *   same now                      -> the pair is in step; the baseline follows
 *   propter still at the baseline -> the outside changed: propter takes it, silently (intake)
 *   outside still at the baseline -> propter changed: propter keeps its value, nothing is done
 *   neither at the baseline       -> both changed: a conflict, and neither value is taken
 * This file is pure: it reads no tracker and no state, and it has no way to write to either side's outside.
 */

/** a document in one spelling: only the line ends are made alike and the ends trimmed. Nothing after the text is dropped */
export function normBody(text: string): string {
  return (text ?? "").replace(/\r\n?/g, "\n").trim();
}

export type Verdict = "same" | "external" | "propter" | "conflict";

export function verdict(external: string, propter: string, base: string): Verdict {
  if (external === propter) return "same";
  if (propter === base) return "external";
  if (external === base) return "propter";
  return "conflict";
}

/** an Issue's Project as a card spells it: the id and name, or "no Project" */
export function membershipWord(id: string, prop: PropterSide): string {
  const name = prop.projects.find((p) => p.id === id)?.name;
  return id ? `${id}${name !== undefined ? `「${name}」` : ""}` : "（所属なし）";
}

/**
 * What the outside's side of a unit is when the Project or Issue is gone from it. It equals no text and no id, so a
 * gone thing is a change of the outside's like any other: propter at the baseline lets go of it, propter changed too
 * is a conflict, and a card shows the outside's value as "gone".
 */
const GONE = "\u0000gone";
export const GONE_WORD = "（外で消えた）";

export function conflictId(repo: string, unit: ConflictUnit, subject: string): string {
  return `CF-${createHash("sha1").update(`${repo}\n${unit}\n${subject}`).digest("hex").slice(0, 12)}`;
}

export interface PlanInput {
  repo: string;
  cfg: TrackerSyncConfig;
  baseline: Baseline;
  ext: ExtSnapshot;
  prop: PropterSide;
  /** whether an Issue ref belongs to the tracker this repo is paired with (the others are no business of this sync) */
  owns: (ref: string) => boolean;
}

/** the Issues the baseline last saw in a Project, of the tracker this repo is paired with */
export function syncedRefs(baseline: Baseline, owns: (ref: string) => boolean): string[] {
  return Object.entries(baseline.issueProject).filter(([ref, project]) => project && owns(ref)).map(([ref]) => ref);
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function planSync(input: PlanInput): SyncPlan {
  const { repo, cfg, baseline, ext, prop } = input;
  const word = cfg.target === "github" ? "milestone" : "Project";
  const plan: SyncPlan = { intake: [], conflicts: [], compared: [], uncertain: [], settled: [], notes: [] };
  const extProject = new Map<string, ExtProject>(ext.projects.map((p) => [p.id, p]));
  const extIssue = new Map<string, ExtIssue>(ext.issues.map((i) => [i.ref, i]));

  // ---- the pairs: kept across a rename, found by name only for a Project that has none yet ----
  const links: Record<string, string> = { ...baseline.links };
  const taken = new Set(Object.values(links));
  /** paired Projects whose pair the whole Project list does not show: gone */
  const gone = new Set<string>();
  /** paired Projects whose pair is not shown by a list that was cut short: not known to be gone */
  const missing = new Set<string>();
  const projectsCut = ext.projectsTruncated ?? ext.truncated ?? false;
  const unread = new Set(ext.unread ?? []);
  const unpaired = prop.projects.filter((p) => !links[p.id]);
  for (const p of prop.projects) {
    const linked = links[p.id];
    if (!linked) continue;
    if (extProject.has(linked)) continue;
    missing.add(p.id);
    if (projectsCut) {
      plan.uncertain.push(conflictId(repo, "project_body", p.id));
      plan.notes.push(`${p.id}: 対の ${word}（${linked}）が外の一覧に見えません。一覧が切れているので、消えたとは扱いません`);
    } else {
      gone.add(p.id);
    }
  }
  for (const p of unpaired) {
    // a list that was cut short cannot say that a name is held by one Project only: a same-named one may be out of sight
    if (projectsCut) {
      plan.notes.push(`${p.id}: 外の ${word} の一覧が切れているので、名前では対にしません。全件を読めた回に決めます`);
      continue;
    }
    const candidates = ext.projects.filter((e) => !taken.has(e.id) && sameName(e.name, p.name));
    if (!candidates.length) {
      plan.notes.push(`${p.id}: 外に同じ名前の ${word} が無いので、対にしません（外には作りません）`);
      continue;
    }
    // a name that more than one Project holds on either side does not say which is the pair: none is chosen
    if (candidates.length > 1 || unpaired.filter((q) => sameName(q.name, p.name)).length > 1) {
      plan.notes.push(`${p.id}: 同じ名前の ${word} が複数あり、どれが対か決められないので、対にしません`);
      continue;
    }
    links[p.id] = candidates[0].id;
    taken.add(candidates[0].id);
    plan.settled.push({ unit: "link", key: p.id, value: candidates[0].id });
  }
  const inverse = new Map<string, string>(Object.entries(links).map(([prj, id]) => [id, prj]));
  const projectOfRef = new Map<string, string>();
  for (const p of prop.projects) for (const ref of p.issues) if (input.owns(ref)) projectOfRef.set(ref, p.id);
  /** whether a Project of propter can be the other end of a membership: it is paired and its pair is still outside */
  const paired = (id: string): boolean => Boolean(links[id]) && !missing.has(id);
  /** the Projects whose pair is gone and whose Issues are in conflict with that: the pair is not let go while a person has cards to read */
  const heldPair = new Set<string>();
  /** a card on an Issue's membership reads the baseline's Project and propter's: whichever of them is gone keeps its pair, or the card loses its "last in step" value */
  const hold = (...ids: string[]): void => {
    for (const id of ids) if (gone.has(id)) heldPair.add(id);
  };
  const bodyLetGo = new Set<string>();

  const conflict = (unit: ConflictUnit, subject: string, label: string, external: string, base: string, propter: string): void => {
    plan.conflicts.push({ id: conflictId(repo, unit, subject), unit, subject, label, external, base, propter } satisfies ConflictProposal);
  };

  /**
   * One Issue's Project compared three ways. `value` is the outside's side, `take` what propter takes in when only the
   * outside moved ("" lets the Issue go), `word` how a card spells the outside's side; `propV` and `baseV` stand in for
   * the two other sides when they are to be read as the outside's side (an outside Project propter has no pair for)
   */
  const member = (ref: string, owner: string, baseV: string, out: { value: string; take: string; word: string; note?: string; propV?: string; baseCmp?: string }): void => {
    const v = verdict(out.value, out.propV ?? owner, out.baseCmp ?? baseV);
    plan.compared.push(conflictId(repo, "issue_project", ref));
    if (v === "same") {
      if (baseline.issueProject[ref] !== out.take) plan.settled.push({ unit: "issueProject", key: ref, value: out.take });
    } else if (v === "external") {
      if (out.note) plan.notes.push(`${ref}: ${out.note}`);
      plan.intake.push({ op: "issue_project", ref, project: out.take, base: [{ unit: "issueProject", key: ref, value: out.take }] });
    } else if (v === "conflict") {
      hold(owner, baseV);
      conflict("issue_project", ref, `${ref} の所属`, out.word, membershipWord(baseV, prop), membershipWord(owner, prop));
    }
  };

  // ---- the Projects' bodies ----
  for (const p of prop.projects) {
    const propV = normBody(p.body);
    const baseV = baseline.projectBody[p.id] ?? "";
    if (gone.has(p.id)) {
      // the pair is gone from the outside: that is the outside's change of this unit
      plan.compared.push(conflictId(repo, "project_body", p.id));
      const v = verdict(GONE, propV, baseV);
      if (v === "external") bodyLetGo.add(p.id);
      else if (v === "conflict") conflict("project_body", p.id, `${p.id} の本文`, GONE_WORD, baseV, propV);
      continue;
    }
    if (!paired(p.id)) continue;
    const e = extProject.get(links[p.id]);
    if (!e) continue;
    const extV = normBody(e.body);
    const v = verdict(extV, propV, baseV);
    plan.compared.push(conflictId(repo, "project_body", p.id));
    if (v === "same") {
      if (baseline.projectBody[p.id] !== extV) plan.settled.push({ unit: "projectBody", key: p.id, value: extV });
    } else if (v === "external") {
      plan.intake.push({ op: "project_body", project: p.id, value: extV, base: [{ unit: "projectBody", key: p.id, value: extV }] });
    } else if (v === "conflict") {
      conflict("project_body", p.id, `${p.id} の本文`, extV, baseV, propV);
    }
  }

  // ---- the Issues: those propter's Projects hold and those the paired outside Projects hold ----
  const refs = new Set<string>(projectOfRef.keys());
  for (const i of ext.issues) {
    if (i.projectId && inverse.has(i.projectId) && input.owns(i.ref)) refs.add(i.ref);
  }
  // an Issue the baseline last saw in a Project is compared even when propter no longer holds it: propter taking it out and the outside deleting it are both changes
  for (const ref of syncedRefs(baseline, input.owns)) refs.add(ref);
  for (const ref of [...refs].sort()) {
    const e = extIssue.get(ref);
    const owner = projectOfRef.get(ref) ?? "";
    const baseV = baseline.issueProject[ref] ?? "";
    const memberId = conflictId(repo, "issue_project", ref);
    if (!e && unread.has(ref)) {
      plan.uncertain.push(memberId);
      hold(owner, baseV);
      plan.notes.push(`${ref}: 外から読めなかったので、消えたとは扱いません。次の同期でもう一度読みます`);
      continue;
    }
    if (!e) {
      // the outside answered that there is no such Issue: gone, which is the outside's change of its membership
      if (!owner && !baseV) continue;
      if (owner && !paired(owner) && !gone.has(owner)) {
        plan.notes.push(`${ref}: 外に見つかりません。属する Project（${owner}）は外と対になっていないので、このままにします`);
        continue;
      }
      member(ref, owner, baseV, { value: GONE, take: "", word: GONE_WORD, note: `外で消えたので、${owner} から外しました` });
      continue;
    }
    // the Project of the Issue
    const extOwner = e.projectId ? (inverse.get(e.projectId) ?? "") : "";
    // An outside Project that is not paired with any of propter's is a value of its own, not "no Project". Propter has no
    // Project to show it as, so for propter with none it is the same, and a baseline that held none counts it unchanged
    const foreign = e.projectId !== null && !inverse.has(e.projectId);
    if (!foreign && owner && gone.has(owner) && !extOwner) {
      // the Issue's Project is gone, so the Issue is outside every Project: that is the Project going, not each Issue leaving it
      member(ref, owner, baseV, { value: GONE, take: "", word: GONE_WORD, note: `外の ${word} が消えたので、${owner} から外しました` });
    } else if (!owner || paired(owner) || gone.has(owner)) {
      const other = `\u0000foreign:${e.projectId}`;
      member(ref, owner, baseV, foreign
        ? { value: other, take: "", word: `未対の ${word}（${e.projectId}）`, note: `外の ${word}（${e.projectId}）は propter の Project と対になっていないので、${owner} から外しました`, propV: owner || other, baseCmp: baseV || other }
        : { value: extOwner, take: extOwner, word: membershipWord(extOwner, prop) });
    } else if (owner && missing.has(owner)) {
      plan.uncertain.push(memberId);
    }

    // the state of the Issue: two booleans cannot both differ from a third and from each other, so this never conflicts
    const sv = verdict(String(e.closed), String(prop.closed(ref)), String(baseline.issueClosed[ref] ?? false));
    if (sv === "same") {
      if (baseline.issueClosed[ref] !== e.closed) plan.settled.push({ unit: "issueClosed", key: ref, value: e.closed });
    } else if (sv === "external") {
      plan.intake.push({ op: "issue_closed", ref, closed: e.closed, base: [{ unit: "issueClosed", key: ref, value: e.closed }] });
    }
  }

  // a Project whose pair is gone and which propter did not change is let go; one with a card to read stays paired until it is settled
  for (const id of bodyLetGo) {
    if (heldPair.has(id)) continue;
    plan.settled.push({ unit: "unlink", key: id });
    plan.notes.push(`${id}: 対の ${word} が外で消えたので、対を外しました（propter の ${id} は変えません）`);
  }
  return plan;
}
