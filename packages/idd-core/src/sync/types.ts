/**
 * The shapes the intake of an outside tracker's Projects and Issues passes around. A tracker is read into `ExtSnapshot`,
 * propter's side into `PropterSide`, and the three-way compare (plan.ts) turns them and the last synced copy (the
 * baseline) into intake operations and conflicts. Nothing here describes a write to the outside: there is none.
 */

export type Tracker = "github" | "linear";

export interface TrackerSyncConfig {
  target: Tracker;
  /** the Linear team key Issues and Projects are read from (a Linear target needs it) */
  linearTeam?: string;
  /** the least minutes between two syncs the tick makes of this repo */
  intervalMinutes: number;
}

/** a Project of the outside: a GitHub milestone (id = its number) or a Linear Project (id = its uuid) */
export interface ExtProject {
  id: string;
  name: string;
  /** the description as the outside has it, whole */
  body: string;
  url?: string;
}

export interface ExtIssue {
  /** `owner/name#N` or `APP-1234`, the same name propter keeps an Issue under */
  ref: string;
  closed: boolean;
  /** the id of the outside Project the Issue belongs to, or null */
  projectId: string | null;
}

export interface ExtSnapshot {
  projects: ExtProject[];
  issues: ExtIssue[];
  /** a list the read stopped short of: an Issue absent from it is not evidence of anything by itself */
  truncated?: boolean;
  /** the Project list alone was cut short (when absent, `truncated` stands for it): a Project missing from a whole list is gone */
  projectsTruncated?: boolean;
  /**
   * The Issues propter holds are asked for by name (`read(refs)`) when no list showed them, so an asked Issue that is in
   * neither `issues` nor here is one the outside answered "no such Issue" for. Here are the ones the reader could not
   * settle (the read failed, or the name is a pull request): they are neither seen nor proven gone.
   */
  unread?: string[];
}

/** what propter holds of one Project, as the sync reads it */
export interface PropterProject {
  id: string;
  name: string;
  /** the free text of the document */
  body: string;
  issues: string[];
}

export interface PropterSide {
  projects: PropterProject[];
  /** whether propter counts an Issue closed (a person's record, a landing, or else the outside's own state) */
  closed(ref: string): boolean;
}

/** the last synced copy: what both sides agreed on, kept so a change can be told from who made it */
export interface Baseline {
  version: 1;
  /** the repo this baseline is of; a file that names another repo is refused, never read */
  repo?: string;
  lastRunAt?: string;
  /** propter Project id -> the id of the outside Project it is paired with; a rename of either side keeps the pair */
  links: Record<string, string>;
  projectBody: Record<string, string>;
  /** Issue ref -> the propter Project id, or "" for no Project */
  issueProject: Record<string, string>;
  issueClosed: Record<string, boolean>;
}

export function emptyBaseline(): Baseline {
  return { version: 1, links: {}, projectBody: {}, issueProject: {}, issueClosed: {} };
}

/** the values a unit of the baseline takes; applied when an operation has succeeded or the pair is already in step */
export type BaselinePatch =
  | { unit: "projectBody"; key: string; value: string }
  | { unit: "issueProject"; key: string; value: string }
  | { unit: "issueClosed"; key: string; value: boolean }
  | { unit: "link"; key: string; value: string }
  /** the outside Project of a propter Project is gone: the pair is let go, with the copies kept for it */
  | { unit: "unlink"; key: string };

/** what the sync does to propter when only the outside changed */
export type IntakeOp =
  | { op: "project_body"; project: string; value: string; base: BaselinePatch[] }
  | { op: "issue_project"; ref: string; project: string; base: BaselinePatch[] }
  | { op: "issue_closed"; ref: string; closed: boolean; base: BaselinePatch[] };

export type ConflictUnit = "project_body" | "issue_project";

/** a unit both sides changed: neither value is taken, and a person reads the three */
export interface ConflictProposal {
  /** stable for the unit */
  id: string;
  unit: ConflictUnit;
  /** `PRJ-1` or the Issue ref */
  subject: string;
  label: string;
  external: string;
  base: string;
  propter: string;
}

export interface SyncPlan {
  intake: IntakeOp[];
  conflicts: ConflictProposal[];
  /** the conflict ids of every unit the plan actually compared this time; a unit the outside did not show is not here */
  compared: string[];
  /** the conflict ids of units the plan could not judge for want of evidence; an open one of these stays as it is */
  uncertain: string[];
  /** the baseline entries that only need to follow a pair already in step */
  settled: BaselinePatch[];
  /** things the sync saw and left alone, in words */
  notes: string[];
}
