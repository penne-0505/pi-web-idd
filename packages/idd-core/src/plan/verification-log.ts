import { acceptedOf, fixesNow } from "../ledger/review-loop.ts";
import type { LifecycleRecord } from "../schema/records.ts";
import { acStatesForLane, criterionKey, isVerified, type WorkRow } from "./work-records.ts";

/** the five stages a verification entry is made at */
export type VerificationStage = "計画" | "実装" | "レビュー" | "検査" | "取り込み";
export type VerificationVerdict = "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";

export interface VerificationEntry {
  at: string;
  stage: VerificationStage;
  /** the commands and results known by that moment: the executor's evidence, or what the engine ran */
  commands: string[];
  /** how far the ACs had got by that moment */
  acceptance: { done: number; total: number; open: string[] };
  verdict: VerificationVerdict;
  who: string;
  /** what is left and what to do next; only on PARTIAL / FAIL / BLOCKED */
  next?: string;
}

export interface VerificationLogInput {
  lane: string;
  criteria: { id: string }[];
  events: LifecycleRecord[];
  rows: WorkRow[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** the AC progress by the given moment, as the entries report it */
function acceptanceAt(input: VerificationLogInput, at: string): VerificationEntry["acceptance"] {
  const states = acStatesForLane({ lane: input.lane, rows: input.rows, events: input.events, before: at });
  const byId = new Map(states.map((s) => [criterionKey(s.id), s]));
  const open = input.criteria.filter((c) => !isVerified(byId.get(criterionKey(c.id)) ?? { id: c.id, status: "planned" })).map((c) => c.id);
  return { done: input.criteria.length - open.length, total: input.criteria.length, open };
}

/** the evidence of the reports up to the moment: the command-and-result lines the entries carry */
function evidenceAt(input: VerificationLogInput, at: string): string[] {
  const states = acStatesForLane({ lane: input.lane, rows: input.rows, events: input.events, before: at });
  return states.flatMap((s) => (s.evidence ? [`${s.id}: ${s.evidence}`] : []));
}

/** one review judgement's verdict: a failure blocks, a fix-bound must / should fails, otherwise it passes */
function reviewVerdict(e: LifecycleRecord): { verdict: VerificationVerdict; next?: string } {
  if (e.attrs?.failed) return { verdict: "BLOCKED", next: `判定が失敗した（${str(e.attrs?.error)}）。もう一度巡を行う。` };
  const accepted = acceptedOf(e.attrs);
  const must = accepted.filter((a) => a.severity === "must" && fixesNow(a)).length;
  const should = accepted.filter((a) => a.severity === "should" && fixesNow(a)).length;
  if (must || should) return { verdict: "FAIL", next: `must ${must} 件・should ${should} 件を修正に回した。修正の巡を行う。` };
  return { verdict: "PASS" };
}

/** one result's verdict: how the executor reported the stage, and what is left */
function resultVerdict(e: LifecycleRecord): { verdict: VerificationVerdict; next?: string } {
  const outcome = str(e.attrs?.outcome);
  if (outcome === "partial") {
    const open = arr(e.attrs?.qa_unverified).map(String);
    return { verdict: "PARTIAL", next: `未確認の AC: ${open.join(", ") || "（なし）"}。残りを確かめる。` };
  }
  if (outcome === "failed") return { verdict: "FAIL", next: `outcome が failed。実装をやり直す。` };
  return { verdict: "PASS" };
}

/** the S3 check's verdict: a clean tree passes, a conflict fails */
function checkVerdict(e: LifecycleRecord): { verdict: VerificationVerdict; next?: string } {
  if (e.event === "s3_check_conflict") {
    const files = arr(e.attrs?.conflict_files).map(String);
    return { verdict: "FAIL", next: `upstream と衝突した: ${files.join(", ") || "（ファイル名なし）"}。衝突を解く。` };
  }
  if (e.event === "s3_check_in_progress") return { verdict: "PASS" };
  if (e.event === "s4_push_held") return { verdict: "BLOCKED", next: `push が止まっている: ${str(e.attrs?.reason)}` };
  return { verdict: "PASS" };
}

/** the landing's verdict: a merged or local close passes, a failed land check fails */
function landVerdict(e: LifecycleRecord): { verdict: VerificationVerdict; next?: string } {
  if (e.event === "s4_land_check_failed" || e.event === "s4_land_conflict") {
    return { verdict: "FAIL", next: `取り込みに失敗した: ${str(e.attrs?.reason) || str(e.attrs?.detail) || "理由は記録にない"}` };
  }
  if (e.event === "s4_land_check_sent_back") {
    return { verdict: "FAIL", next: `取り込みの検査が落ちて実装役に差し戻した: ${arr(e.attrs?.checks).map(String).join(", ") || "検査名は記録にない"}` };
  }
  return { verdict: "PASS" };
}

function whoOf(stage: VerificationStage, e: LifecycleRecord): string {
  if (stage === "計画") return `planner${str(e.attrs?.planner_session_id) ? ` (${str(e.attrs?.planner_session_id)})` : ""}`;
  if (stage === "レビュー") {
    const kind = str(e.attrs?.kind) || "blind";
    const round = e.attrs?.round === undefined ? "" : ` ${String(e.attrs.round)} 巡目`;
    return `review:${kind}${round}`;
  }
  if (stage === "実装") return "executor";
  return "engine";
}

/** the executed check a record stands for, as a command and its result; null for a record that ran none */
function checkLine(e: LifecycleRecord): string | null {
  switch (e.event) {
    case "s3_check_clean":
      return "git merge-tree --write-tree: 衝突なし";
    case "s3_check_conflict": {
      const files = arr(e.attrs?.conflict_files).map(String);
      return `git merge-tree --write-tree: 衝突 ${files.length} 件${files.length ? `（${files.join(", ")}）` : ""}`;
    }
    case "s4_push_held":
      return `git push: 保留（${str(e.attrs?.reason) || "理由は記録にない"}）`;
    case "s4_land_merged":
      return `git merge: ${str(e.attrs?.branch) || "lane"} → 本流 @ ${str(e.attrs?.merge_commit).slice(0, 9) || "commit 不明"}`;
    case "s4_local_completed":
      return `git merge なしで完了${str(e.attrs?.recovered_commit) ? `（回復 commit ${str(e.attrs?.recovered_commit).slice(0, 9)}）` : ""}`;
    case "s4_land_check_failed":
      return `取り込みの検査: 失敗（${str(e.attrs?.reason) || "理由は記録にない"}）`;
    case "s4_land_check_sent_back": {
      const checks = arr(e.attrs?.checks).map(String);
      return `取り込みの検査: 失敗${checks.length ? `（${checks.join(", ")}）` : ""}、実装役に差し戻し`;
    }
    case "s4_land_conflict": {
      const files = arr(e.attrs?.conflict_files).map(String);
      return `git merge: 衝突${files.length ? `（${files.join(", ")}）` : ""}`;
    }
    case "lane_close": {
      const outcome = str(e.attrs?.outcome);
      return `lane_close: ${outcome}（確認済み ${arr(e.attrs?.final_qa_verified).length} 件）`;
    }
    default:
      return null;
  }
}

/**
 * The commands and results an entry knows: the evidence of the reports up to that moment, and the check or review
 * the record itself ran. The evidence is read as of the entry's own moment, so a later report cannot change it.
 */
function commandsFor(input: VerificationLogInput, e: LifecycleRecord, stage: VerificationStage, at: string): string[] {
  const out = [...evidenceAt(input, at)];
  if (stage === "レビュー") {
    const accepted = acceptedOf(e.attrs);
    const rejected = arr(e.attrs?.rejected).length;
    out.push(`レビュー: ${str(e.attrs?.kind) || "blind"}${e.attrs?.round === undefined ? "" : ` ${String(e.attrs.round)} 巡目`} → 受理 ${accepted.length} 件・棄却 ${rejected} 件`);
  } else {
    const line = checkLine(e);
    if (line) out.push(line);
  }
  return out;
}

/**
 * The lane's verification log: one entry per stage milestone, in time order. The entries are derived from the
 * records alone; nothing is written. Each entry's AC progress is what the reports said by that moment, and its
 * commands are the evidence and the check that ran, so an entry never changes when later records arrive. A landing
 * writes both its `s4_land_merged` / `s4_local_completed` and the `lane_close` right after it; the pair makes one
 * entry, at the landing's own record.
 */
export function buildVerificationLog(input: VerificationLogInput): VerificationEntry[] {
  const entries: VerificationEntry[] = [];
  const push = (e: LifecycleRecord, stage: VerificationStage, verdict: VerificationVerdict, commands: string[], next?: string) => {
    entries.push({
      at: e.at,
      stage,
      commands,
      acceptance: acceptanceAt(input, e.at),
      verdict,
      who: whoOf(stage, e),
      ...(next ? { next } : {}),
    });
  };
  let lastLanding: number | null = null;
  [...input.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).forEach((e, i) => {
    switch (e.event) {
      case "s1_ready":
        push(e, "計画", "PASS", commandsFor(input, e, "計画", e.at));
        break;
      case "s2_result": {
        const { verdict, next } = resultVerdict(e);
        push(e, "実装", verdict, commandsFor(input, e, "実装", e.at), next);
        break;
      }
      case "s2_triage_done": {
        const { verdict, next } = reviewVerdict(e);
        push(e, "レビュー", verdict, commandsFor(input, e, "レビュー", e.at), next);
        break;
      }
      case "s3_check_clean":
      case "s3_check_conflict":
      case "s4_push_held": {
        const { verdict, next } = checkVerdict(e);
        push(e, "検査", verdict, commandsFor(input, e, "検査", e.at), next);
        break;
      }
      case "s4_land_check_failed":
      case "s4_land_check_sent_back":
      case "s4_land_conflict":
      case "s4_land_merged":
      case "s4_local_completed": {
        const { verdict, next } = landVerdict(e);
        push(e, "取り込み", verdict, commandsFor(input, e, "取り込み", e.at), next);
        lastLanding = i;
        break;
      }
      case "lane_close": {
        const outcome = str(e.attrs?.outcome);
        if (outcome !== "merged" && outcome !== "local") break;
        // the landing right before it already made this milestone's entry
        if (lastLanding === i - 1) break;
        push(e, "取り込み", "PASS", commandsFor(input, e, "取り込み", e.at));
        lastLanding = i;
        break;
      }
      default:
        break;
    }
  });
  return entries;
}

/** the AC progress an entry reports, for a caller that wants only that */
export function acceptanceProgress(input: VerificationLogInput, at: string): { done: number; total: number; open: string[] } {
  return acceptanceAt(input, at);
}
