import { existsSync } from "node:fs";
import { join } from "node:path";

import { areaSegment, slugOf } from "../intent/parse.ts";

/** where a lane's plan document lives: the live one under `_docs/plan/`, else the archived one, else none */
export interface LanePlan {
  /** repo-relative path, as the worktree has it */
  rel: string;
  /** the plan was already moved to `_docs/archives/plan/` */
  archived: boolean;
}

/**
 * Where a lane's important-context document lives: beside the lane's other records and outside `_docs/plan/`, so it
 * outlives the work instruction that the harness moves to the archive before the submit.
 */
export function laneContextPath(rec: { area: string; idd_id: string; title: string } & Parameters<typeof slugOf>[0]): string {
  return `_docs/context/${areaSegment(rec.area)}/${slugOf(rec)}/context.md`;
}

/**
 * The lane's context document as the worktree holds it, or undefined for a lane planned before the document existed.
 * A lane without one is told nothing about it: the executor's brief, the plan review and the fix plan's inputs
 * simply name no document, and the stages run as they did.
 */
export function laneContextDoc(rec: { area: string; idd_id: string; title: string } & Parameters<typeof slugOf>[0], worktree: string): string | undefined {
  const rel = laneContextPath(rec);
  return existsSync(join(worktree, rel)) ? rel : undefined;
}

/**
 * The lane's work instruction as its worktree holds it now. The stages that decide their own shape from the plan's
 * presence read this, not the repo's setting: a lane keeps the shape it was planned under even if the setting
 * changes while it runs (DEC-2647).
 */
export function lanePlanDoc(rec: { area: string; idd_id: string; title: string } & Parameters<typeof slugOf>[0], worktree: string): LanePlan | undefined {
  const seg = areaSegment(rec.area);
  const slug = slugOf(rec);
  const live = `_docs/plan/${seg}/${slug}/plan.md`;
  if (existsSync(join(worktree, live))) return { rel: live, archived: false };
  const archived = `_docs/archives/plan/${seg}/${slug}/plan.md`;
  if (existsSync(join(worktree, archived))) return { rel: archived, archived: true };
  return undefined;
}
