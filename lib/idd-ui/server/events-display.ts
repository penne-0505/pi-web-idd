// intent: lifecycle event (41 種) を経過の 1 行に写す。event 名をそのまま出さない。
//
// 表示の粒度は 3 段構え:
//   1. 対応表で見出しを動詞ひとつにする (文章にしない)
//   2. kind で形を分ける (節目 / 自分の判断 / agent の動き / 失敗) — 読まずに拾えるのは形の方
//   3. 節目と自分の判断だけを既定で出し、間の agent の動きは畳む
// lane detail を開く動機は「今どうなっているか」なので、既定は畳む側に置く。

import type { TimelineEntry } from "../types";

type Kind = TimelineEntry["kind"];

interface EventMeta {
  label: string;
  kind: Kind;
  /** true = 節目。畳まれず必ず出る。 */
  keep?: boolean;
}

export const EVENT_META: Record<string, EventMeta> = {
  // S0
  lane_open: { label: "起票", kind: "mark", keep: true },
  pending_review_open: { label: "重複疑い", kind: "agent" },
  pending_review_resolved: { label: "重複を判定", kind: "user", keep: true },

  // S1
  question_batch_asked: { label: "質問", kind: "mark", keep: true },
  question_batch_answered: { label: "回答", kind: "user", keep: true },
  s1_ready: { label: "下調べ 完了", kind: "mark", keep: true },
  s1_go: { label: "GO", kind: "user", keep: true },
  s1_defer: { label: "中止", kind: "user", keep: true },

  // S2
  s2_start: { label: "実装 開始", kind: "mark", keep: true },
  blocked_by_dependency: { label: "依存待ち", kind: "warn", keep: true },
  s2_blocked: { label: "停止", kind: "warn", keep: true },
  s2_model_fallback: { label: "モデル切替", kind: "agent" },
  s2_recovery_attempt: { label: "自己修復", kind: "agent" },
  s2_result: { label: "実装 完了", kind: "mark", keep: true },
  s2_interjection: { label: "伝えた", kind: "user", keep: true },

  // S3
  s3_ready: { label: "衝突確認 待ち", kind: "agent" },
  s3_check_in_progress: { label: "衝突確認", kind: "agent" },
  s3_check_clean: { label: "衝突なし", kind: "agent" },
  s3_check_conflict: { label: "衝突", kind: "warn", keep: true },
  s3_check_invalidated: { label: "確認やり直し", kind: "agent" },
  s3_integrator_analysis: { label: "分析", kind: "agent" },
  s3_mechanical_resolve: { label: "自動で解消", kind: "agent" },
  s3_sub_todo_spawned: { label: "切り出し", kind: "mark", keep: true },
  s3_user_judgment_requested: { label: "判断を依頼", kind: "warn", keep: true },
  s3_ok: { label: "承認", kind: "user", keep: true },
  s3_reject: { label: "差し戻し", kind: "user", keep: true },
  s3_defer: { label: "保留", kind: "user", keep: true },

  // S4 Phase A
  s4_submit_started: { label: "提出 開始", kind: "mark", keep: true },
  s4_verify_started: { label: "検査", kind: "agent" },
  s4_verify_clean: { label: "検査 通過", kind: "agent" },
  s4_verify_mechanical_fix: { label: "自動で修正", kind: "agent" },
  s4_verify_user_judgment_requested: { label: "判断を依頼", kind: "warn", keep: true },
  s4_verify_user_judgment_answered: { label: "判断", kind: "user", keep: true },
  s4_pushed: { label: "push", kind: "agent" },
  s4_pr_created: { label: "PR 作成", kind: "mark", keep: true },

  // S4 Phase B
  s4_ci_failed: { label: "CI 失敗", kind: "warn", keep: true },
  s4_review_comment_received: { label: "指摘", kind: "mark", keep: true },
  s4_change_pushed: { label: "修正を push", kind: "agent" },
  s4_response_posted: { label: "返答", kind: "agent" },
  s4_merged: { label: "merge", kind: "mark", keep: true },
  lane_close: { label: "終了", kind: "mark", keep: true },

  // 共通
  priority_elevated: { label: "最優先", kind: "user", keep: true },
  priority_reset: { label: "最優先 解除", kind: "user", keep: true },
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 添える値は 1 つまで。文章にはしない。 */
function detailOf(event: string, attrs: Record<string, unknown> = {}): string | undefined {
  switch (event) {
    case "lane_open": return str(attrs.area) || undefined;
    case "pending_review_resolved": return str(attrs.outcome) || undefined;
    case "question_batch_asked": return `${list(attrs.question_ids).length} 件`;
    case "s1_ready": return `DEC ${attrs.dec_count ?? 0} · QA ${attrs.qa_count ?? 0}`;
    case "s1_defer":
    case "s3_defer": return str(attrs.reason) || undefined;
    case "s2_start": return str(attrs.model) || undefined;
    case "blocked_by_dependency": return list(attrs.waiting_for).join(" ") || undefined;
    case "s2_model_fallback": return `${str(attrs.from)} → ${str(attrs.to)}`;
    case "s2_recovery_attempt": return `${attrs.attempt_number ?? "?"} 回目`;
    case "s2_result": return `${list(attrs.changed_files).length} ファイル · commit ${attrs.commit_count ?? 0}`;
    case "s3_check_conflict": return list(attrs.conflict_files).join(", ") || undefined;
    case "s3_mechanical_resolve": return `${list(attrs.resolved_files).length} ファイル`;
    case "s3_sub_todo_spawned": return str(attrs.sub_todo_id) || undefined;
    case "s3_reject": return str(attrs.next_stage) === "s1_rethink" ? "方針へ" : "実装へ";
    case "s4_verify_mechanical_fix": return str(attrs.what_was_fixed) || undefined;
    case "s4_pushed": return str(attrs.pushed_branch) || undefined;
    case "s4_pr_created": return attrs.pr_number ? `#${attrs.pr_number}` : undefined;
    case "s4_ci_failed": return str(attrs.failure_type) || undefined;
    case "s4_review_comment_received": return str(attrs.commenter) || undefined;
    case "s4_change_pushed": return list(attrs.changed_files).join(", ") || undefined;
    case "lane_close": return attrs.total_duration_hours ? `${attrs.total_duration_hours} 時間` : undefined;
    case "priority_elevated":
    case "priority_reset": return str(attrs.reason) || undefined;
    default: return undefined;
  }
}

export interface RawEvent {
  event: string;
  at: string;
  attrs?: Record<string, unknown>;
}

function entryOf(e: RawEvent): TimelineEntry & { keep: boolean } {
  const meta = EVENT_META[e.event] ?? { label: e.event, kind: "agent" as Kind };
  return {
    time: e.at.slice(11, 16),
    title: meta.label,
    detail: detailOf(e.event, e.attrs),
    kind: meta.kind,
    keep: Boolean(meta.keep),
  };
}

/** 節目と自分の判断だけを残し、その間の agent の動きは 1 行に畳む。 */
export function buildTimeline(events: RawEvent[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let run: TimelineEntry[] = [];

  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) {
      const [only] = run;
      out.push({ time: only.time, title: only.title, detail: only.detail, kind: only.kind });
    } else {
      out.push({
        time: run[run.length - 1].time,
        title: run[run.length - 1].title,
        kind: "agent",
        folded: run.length,
        items: run.map(({ time, title, detail, kind }) => ({ time, title, detail, kind })),
      });
    }
    run = [];
  };

  for (const e of events) {
    const entry = entryOf(e);
    const { keep, ...rest } = entry;
    if (keep) { flush(); out.push(rest); } else { run.push(rest); }
  }
  flush();
  return out;
}
