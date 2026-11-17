
import { answeredJudgementAt, fixAfter, GRANULARITY_RECORDED_EVENT, MERGE_ONLY_SKIP_EVENT, reviewLoopState, REVIEW_EVENTS, type LifecycleRecord } from "@idd/core";
import type { TimelineEntry } from "../../../../lib/idd-ui/types.ts";

type Kind = TimelineEntry["kind"];

interface EventMeta {
  label: string;
  kind: Kind;
  keep?: boolean;
}

/** an event of a landing that went in with others: kept in the timeline, with its own heading */
const batchMeta = (label: string, kind: Kind): EventMeta => ({ label, kind, keep: true });

export const EVENT_META: Record<string, EventMeta> = {
  lane_open: { label: "起票", kind: "mark", keep: true },
  pending_review_open: { label: "重複疑い", kind: "agent" },
  pending_review_resolved: { label: "重複を判定", kind: "user", keep: true },

  question_batch_asked: { label: "質問", kind: "mark", keep: true },
  question_batch_answered: { label: "回答", kind: "user", keep: true },
  s1_granularity_proposed: { label: "粒度の案", kind: "agent", keep: true },
  // a proposal that arrived while the stage was stopped: it is kept in the record, but nobody is asked to decide it
  [GRANULARITY_RECORDED_EVENT]: { label: "粒度の案（段は止まっている）", kind: "agent" },
  s1_granularity_answered: { label: "粒度の答え", kind: "user", keep: true },
  s1_ready: { label: "下調べ 完了", kind: "mark", keep: true },
  s1_plan_review_started: { label: "plan 査読 開始", kind: "agent" },
  s1_plan_review_done: { label: "plan 査読 完了", kind: "mark", keep: true },
  s1_plan_review_skipped: { label: "plan 査読 省略", kind: "mark" },
  s1_base_advanced: { label: "plan の後に本流が進んだ", kind: "warn", keep: true },
  s2_plan_written: { label: "plan の記録を列へ書いた", kind: "mark" },
  s2_map_started: { label: "危ない経路の下調べ 開始", kind: "agent" },
  s2_map_done: { label: "危ない経路の下調べ 完了", kind: "mark" },
  s2_map_dropped: { label: "地図なしで起こし直し", kind: "warn" },
  // the routes were drawn at a head the lane has left: they are dropped and drawn again
  s2_map_head_moved: { label: "経路を捨てて立て直し", kind: "warn", keep: true },
  // the executor's work has not stopped (its conversation is answering, or its head is still moving)
  s2_executor_waiting: { label: "実装役の終了待ち", kind: "warn", keep: true },
  // the first look that found the executor stopped after a wait
  s2_executor_wait_ended: { label: "実装役の終了待ち 明け", kind: "mark" },
  s2_review_started: { label: "レビュー 開始", kind: "agent" },
  s2_review_findings: { label: "レビュー 完了", kind: "mark" },
  s2_triage_started: { label: "判定 開始", kind: "agent" },
  s2_triage_done: { label: "判定 完了", kind: "mark", keep: true },
  s2_fix_sent: { label: "修正を依頼", kind: "agent", keep: true },
  s2_confirm_started: { label: "確認 開始", kind: "agent" },
  s2_confirm_done: { label: "確認 完了", kind: "mark" },
  s2_review_converged: { label: "レビュー 収束", kind: "mark", keep: true },
  s2_review_escalated: { label: "要判断", kind: "warn", keep: true },
  s2_review_resumed: { label: "判断", kind: "user", keep: true },
  s2_review_skipped: { label: "レビュー 省略", kind: "mark" },
  // the round read nothing: the head was only the mainline merged in. Kept, so the user sees the round was passed
  // over and why, and is not left reading a gap between the review and the submit
  [MERGE_ONLY_SKIP_EVENT]: { label: "レビュー 省略", kind: "mark", keep: true },
  s2_review_base_merged: { label: "本流を merge（レビュー前）", kind: "mark", keep: true },
  // the executor took the mainline in after the first review: the origin moved before the next round, so it is kept
  s2_review_base_advanced: { label: "本流を merge（巡の間）", kind: "mark", keep: true },
  s2_review_base_conflict: { label: "本流との merge が衝突", kind: "warn", keep: true },
  s2_review_base_instructed: { label: "衝突の解消を依頼", kind: "agent", keep: true },
  s2_intent_checked: { label: "記録の検査", kind: "mark", keep: true },
  s2_records_conflict: { label: "記録の error", kind: "warn", keep: true },
  s2_records_instructed: { label: "記録の直しを依頼", kind: "agent", keep: true },
  s2_records_reopened: { label: "記録の直しで code が変わった", kind: "warn", keep: true },
  s2_review_base_skipped: { label: "レビュー前の merge を省いた", kind: "mark" },
  s2_order_waiting: { label: "取り込みの順番待ち", kind: "warn", keep: true },
  s2_order_released: { label: "順番待ちが解けた", kind: "mark", keep: true },
  s2_order_passed: { label: "順番の判定を通過", kind: "mark" },
  s2_order_limit: { label: "順番待ちの上限を超えた", kind: "warn", keep: true },
  s2_order_unknown: { label: "順番の判定が答えず", kind: "warn" },
  s2_review_run_failed: { label: "レビューの起動失敗", kind: "warn" },
  s2_device_started: { label: "絵の見比べ 開始", kind: "agent" },
  s2_device_done: { label: "絵の見比べ 完了", kind: "mark", keep: true },
  s2_device_skipped: { label: "絵の見比べ 省略", kind: "mark" },
  // the repo's required checks at the head before the loop converges (`checks_before_converge`)
  s2_checks_started: { label: "収束前の検査 開始", kind: "agent" },
  s2_checks_done: { label: "収束前の検査 完了", kind: "mark", keep: true },
  s2_hand_fixed: { label: "手番の直しを反映", kind: "user", keep: true },
  s1_replan_requested: { label: "計画から考え直す", kind: "user", keep: true },
  s3_plan_archived: { label: "plan を archive へ移動", kind: "mark", keep: true },
  s3_plan_refs_fixed: { label: "plan への参照を直した", kind: "mark" },
  s3_plan_archive_failed: { label: "plan を archive へ移せず", kind: "warn", keep: true },
  s3_r2_started: { label: "R2 開始", kind: "agent" },
  s3_r2_done: { label: "R2 完了", kind: "mark", keep: true },
  s3_r2_skipped: { label: "R2 省略", kind: "mark" },
  s3_r2_recorded: { label: "R2 を qa に記録", kind: "mark" },
  s3_kept_recorded: { label: "確かめを qa に記録", kind: "mark" },
  s3_kept_not_recorded: { label: "確かめを qa に書けず", kind: "warn", keep: true },
  s3_r2_not_recorded: { label: "R2 を qa に書けず", kind: "warn", keep: true },
  s3_followups_written: { label: "follow-up を記録", kind: "mark" },
  s3_followups_not_written: { label: "follow-up を TODO に書けず", kind: "warn", keep: true },
  s1_go: { label: "GO", kind: "user", keep: true },
  s1_defer: { label: "無視", kind: "user", keep: true },

  s2_start: { label: "実装 開始", kind: "mark", keep: true },
  blocked_by_dependency: { label: "依存待ち", kind: "warn", keep: true },
  s2_blocked: { label: "停止", kind: "warn", keep: true },
  s2_model_fallback: { label: "モデル切替", kind: "agent" },
  s1_recovery_attempt: { label: "自己修復", kind: "agent" },
  s2_recovery_attempt: { label: "自己修復", kind: "agent" },
  s2_result: { label: "実装 完了", kind: "mark", keep: true },
  s2_interjection: { label: "伝えた", kind: "user", keep: true },

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

  s4_submit_started: { label: "提出 開始", kind: "mark", keep: true },
  s4_verify_started: { label: "検査", kind: "agent" },
  s4_verify_clean: { label: "検査 通過", kind: "agent" },
  s4_verify_mechanical_fix: { label: "自動で修正", kind: "agent" },
  s4_verify_user_judgment_requested: { label: "判断を依頼", kind: "warn", keep: true },
  s4_verify_user_judgment_answered: { label: "判断", kind: "user", keep: true },
  s4_pushed: { label: "push", kind: "agent" },
  s4_push_held: { label: "push を保留", kind: "warn", keep: true },
  s4_push_unsaved: { label: "記録の無い push を確認", kind: "agent" },
  s4_push_approved: { label: "push を承認", kind: "user", keep: true },
  s4_r2_overridden: { label: "R2 の指摘を越えて push", kind: "user", keep: true },
  s4_commit_drafted: { label: "commit message の下書き", kind: "agent" },
  s4_commit_draft_failed: { label: "commit message の下書きに失敗", kind: "warn" },
  s4_pr_body_proposed: { label: "PR の本文の更新案", kind: "agent", keep: true },
  s4_pr_created: { label: "PR 作成", kind: "mark", keep: true },

  s4_ci_failed: { label: "CI 失敗", kind: "warn", keep: true },
  s4_review_comment_received: { label: "指摘", kind: "mark", keep: true },
  s4_change_pushed: { label: "修正を push", kind: "agent" },
  s4_response_posted: { label: "返答", kind: "agent" },
  s4_merged: { label: "merge", kind: "mark", keep: true },
  s4_pr_drafted: { label: "PR の下書き", kind: "agent" },
  s4_pr_draft_failed: { label: "PR の下書きに失敗", kind: "warn" },
  s4_ship_failed: { label: "提出に失敗", kind: "warn", keep: true },
  s4_submit_open_failed: { label: "提出前確認を開けず", kind: "warn", keep: true },
  s4_local_completed: { label: "公開の変更なしで完了", kind: "mark", keep: true },
  s4_land_approved: { label: "merge を承認", kind: "user", keep: true },
  s4_land_merged: { label: "本流へ merge", kind: "mark", keep: true },
  s4_land_conflict: { label: "本流と衝突", kind: "warn", keep: true },
  s4_land_check_failed: { label: "merge の検査が落ちた", kind: "warn", keep: true },
  s4_land_check_sent_back: { label: "merge の検査が落ちて差し戻し", kind: "warn", keep: true },
  s4_land_recheck: { label: "merge の検査をやり直す", kind: "mark", keep: true },
  s4_land_approval_dropped: { label: "merge の承認を外した", kind: "warn", keep: true },
  s4_land_issue_close_queued: { label: "Issue を閉じる下書き", kind: "agent", keep: true },
  s4_land_issue_close_posted: { label: "Issue を閉じた", kind: "mark", keep: true },
  s4_land_issue_close_failed: { label: "Issue を閉じられなかった", kind: "warn", keep: true },
  s4_land_held: { label: "merge を保留", kind: "warn", keep: true },
  s4_land_hold: { label: "merge 待ち", kind: "warn", keep: true },
  s4_land_batch_dropped: batchMeta("まとめた取り込みから外れた", "warn"),
  s4_land_batch_converted: batchMeta("署名の後に merge を変換した", "mark"),
  s4_land_batch_landed: batchMeta("まとめて取り込んだ", "mark"),
  s4_replies_queued: { label: "返信の下書き", kind: "agent", keep: true },
  s0_requeue_go: { label: "取り込み直しを再開", kind: "user", keep: true },
  s1_revise_requested: { label: "plan の見直しを依頼", kind: "user", keep: true },
  lane_stalled: { label: "止まった", kind: "warn", keep: true },
  lane_stall_detected: { label: "engine が停止と見た", kind: "warn", keep: true },
  lane_stall_instructed: { label: "停止の原因を直させる", kind: "agent", keep: true },
  fix_plan_started: { label: "直し方を整理", kind: "agent" },
  fix_plan_done: { label: "整理 完了", kind: "mark" },
  s2_shape_started: { label: "形を判断", kind: "agent" },
  s2_shape_judged: { label: "形の判断 完了", kind: "mark" },
  lane_wait_notified: { label: "長く残った card を通知", kind: "mark", keep: true },
  lane_start_skipped: { kind: "warn", keep: true, label: "段を起こせなかった" },
  lane_stall_resumed: { label: "再開", kind: "user", keep: true },
  lane_over_budget: { label: "予算を超えた", kind: "warn", keep: true },
  claude_quota_wait: { label: "Claude の枠待ち", kind: "warn", keep: true },
  // the planner's spawn only: every other stage says it on the event of its start
  claude_quota_fallback: { label: "代わりの role で実行", kind: "warn", keep: true },
  lane_budget_extended: { label: "予算を足した", kind: "user", keep: true },
  lane_close: { label: "終了", kind: "mark", keep: true },
  lane_work_stopped: { label: "session と run を止めた", kind: "mark" },
  lane_redo_failed: { label: "やり直しに失敗", kind: "warn", keep: true },
  lane_worktree_retired: { label: "worktree を退役", kind: "mark", keep: true },
  lane_worktree_kept: { label: "worktree を残した", kind: "warn", keep: true },
  lane_base_set: { label: "積む先（base）を決めた", kind: "mark", keep: true },
  lane_base_received: { label: "base と同期した", kind: "mark", keep: true },
  lane_base_conflict: { label: "base との同期が衝突", kind: "warn", keep: true },

  priority_elevated: { label: "最優先", kind: "user", keep: true },
  priority_reset: { label: "最優先 解除", kind: "user", keep: true },
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** the stages that start an agent, as a lane's start-skipped line names them */
const START_STAGE_NAME: Record<string, string> = { planner: "計画役", executor: "実装役" };

/** a stage's run refused for Claude's windows ran on its fallback: which role ran, in place of which */
const fallbackText = (f: Record<string, unknown>): string => `${FALLBACK_WHY[String(f.kind ?? "quota")] ?? "枠のため"} ${str(f.fallback)} で実行（${str(f.role)} の代わり${f.folded ? "、1 本にまとめた" : ""}）`;

/** why a run left its own role, as the display says it: an absent kind is an older record, read as a window wait */
const FALLBACK_WHY: Record<string, string> = { quota: "枠のため", provider: "provider の障害のため", timeout: "時間切れのため" };

/** the fallbacks the event of a stage's start recorded (attrs.fallbacks), after the rest of its detail */
function withFallbacks(detail: string | undefined, attrs: Record<string, unknown>): string | undefined {
  const fallbacks = Array.isArray(attrs.fallbacks) ? (attrs.fallbacks as Record<string, unknown>[]).filter((f) => f && typeof f === "object") : [];
  if (!fallbacks.length) return detail;
  return [detail, ...fallbacks.map(fallbackText)].filter(Boolean).join(" · ");
}

function detailOf(event: string, attrs: Record<string, unknown> = {}): string | undefined {
  switch (event) {
    case "lane_open": return str(attrs.area) || undefined;
    case "pending_review_resolved": return str(attrs.outcome) || undefined;
    case "question_batch_asked": return `${list(attrs.question_ids).length} 件`;
    case "s1_ready": {
      if (attrs.records_shape === "state") {
        const recs = attrs.plan_records && typeof attrs.plan_records === "object" ? (attrs.plan_records as { choices?: unknown; existing?: unknown }) : undefined;
        const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
        return `Choice ${n(recs?.choices)} · 処置 ${n(recs?.existing)} · QA ${attrs.qa_count ?? 0}`;
      }
      return `DEC ${attrs.dec_count ?? 0} · QA ${attrs.qa_count ?? 0}`;
    }
    case "s2_review_started": return `${attrs.kind === "final" ? "最後のレビュー" : `${attrs.round ?? 1} 巡目`} · ${Array.isArray(attrs.run_ids) ? attrs.run_ids.length : 0} 本${attrs.mapped_routes ? `（経路 ${attrs.mapped_routes} 本 + 残り）` : ""}${attrs.routes_over_cap ? ` · 経路が ${attrs.route_count ?? ""} 本（責務が複数ある合図）` : ""}${attrs.map_skipped ? ` · 地図なし: ${str(attrs.map_skipped).slice(0, 80)}` : ""}`;
    case "s2_map_done": return attrs.failed ? `失敗: ${String(attrs.error ?? "").slice(0, 80)}（地図なしで続ける）` : `経路 ${Array.isArray(attrs.routes) ? attrs.routes.length : 0} 本`;
    case "s2_map_dropped": return str(attrs.reason) || undefined;
    case "s2_map_head_moved": return [str(attrs.map_head).slice(0, 9) ? `経路 ${str(attrs.map_head).slice(0, 9)}` : "", str(attrs.head).slice(0, 9) ? `→ ${str(attrs.head).slice(0, 9)}` : ""].filter(Boolean).join(" ") || undefined;
    case "s2_executor_wait_ended": return str(attrs.head).slice(0, 9) || undefined;
    case "s2_executor_waiting": return [str(attrs.reason), str(attrs.head).slice(0, 9)].filter(Boolean).join(" · ") || undefined;
    case "s2_triage_done": {
      if (attrs.failed) return `失敗: ${String(attrs.error ?? "").slice(0, 80)}`;
      const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      return `受理 ${n(attrs.accepted)} · 棄却 ${n(attrs.rejected)} · 判断を求める ${n(attrs.escalated_claims)}`;
    }
    case "s2_fix_sent": return `${attrs.round ?? ""} 巡目 · ${Array.isArray(attrs.refs) ? attrs.refs.length : 0} 件`;
    // after PR feedback the reviewer's requests count on their own, nits included
    case "s2_confirm_done": return attrs.failed ? `失敗: ${String(attrs.error ?? "").slice(0, 80)}` : `未解消 must ${attrs.unresolved_must ?? 0} · should ${attrs.unresolved_should ?? 0}${attrs.unresolved_requests === undefined ? "" : ` · PR の指摘 ${attrs.unresolved_requests}`} · 新規 ${attrs.new_blocking ?? 0}`;
    case "s2_review_escalated": return String(attrs.reason ?? "").slice(0, 120);
    case "s2_review_converged": return str(attrs.final_skipped).slice(0, 120) || undefined;
    case MERGE_ONLY_SKIP_EVENT: return str(attrs.reason).slice(0, 120) || undefined;
    case "s3_plan_archive_failed": return str(attrs.reason).slice(0, 160) || undefined;
    case "s3_plan_refs_fixed": return list(attrs.files).join(", ") || undefined;
    case "s3_r2_done": return attrs.failed ? `失敗: ${String(attrs.error ?? "").slice(0, 80)}` : `must ${attrs.must ?? 0} · should ${attrs.should ?? 0} · nit ${attrs.nit ?? 0}`;
    case "s3_r2_recorded": return `${attrs.retry ? "記録し直し · " : ""}${list(attrs.files).join(", ")}${attrs.base_debt ? " · 分岐元の検査の負債あり" : ""}` || undefined;
    case "s3_r2_not_recorded": return `${attrs.retry ? "記録し直し · " : ""}${String(attrs.reason ?? "")}`.slice(0, 120);
    case "s3_followups_written": return `${attrs.retry ? "記録し直し · " : ""}${list(attrs.entries).length} 件${list(attrs.files).length ? ` · ${list(attrs.files).join(", ")}` : ""}${attrs.base_debt ? " · 分岐元の検査の負債あり" : ""}`.slice(0, 120) || undefined;
    case "s3_followups_not_written": return `${attrs.retry ? "記録し直し · " : ""}${String(attrs.reason ?? "")}`.slice(0, 120);
    case "s2_review_run_failed": return String(attrs.error ?? "").slice(0, 120);
    case "s2_checks_started": return str(attrs.head).slice(0, 9) || undefined;
    case "s2_checks_done": {
      if (attrs.failed) return `回せず: ${str(attrs.error).slice(0, 100)}`;
      const rows = Array.isArray(attrs.checks) ? (attrs.checks as Record<string, unknown>[]) : [];
      const named = (pick: (r: Record<string, unknown>) => boolean) => rows.filter(pick).map((r) => str(r.name)).join("、");
      if (attrs.outcome === "new") return `新しく落ちた: ${named((r) => r.status === "fail" && r.verdict === "new")}`;
      if (attrs.outcome === "unknown") return `比べられない: ${named((r) => r.status !== "pass" && r.status !== "not-applicable" && !(r.status === "fail" && r.verdict === "preexisting"))}`;
      const already = named((r) => r.status === "fail" && r.verdict === "preexisting");
      return already ? `通過（元から落ちている: ${already}）` : "通過";
    }
    case "s2_device_done": return attrs.failed ? `失敗: ${String(attrs.error ?? "").slice(0, 80)}` : attrs.skipped_reason ? `省略: ${String(attrs.skipped_reason).slice(0, 80)}` : attrs.judge === "human" ? `判定は人 · 指摘 ${Array.isArray(attrs.findings) ? attrs.findings.length : 0} 件${attrs.stale_reason ? ` · ${String(attrs.stale_reason).slice(0, 60)}` : ""}` : `must / should ${attrs.blocking ?? 0}${attrs.pictures !== undefined ? ` · 絵 ${attrs.pictures} 枚` : ""}`;
    case "s1_plan_review_started": {
      const runs = Array.isArray(attrs.runs) ? (attrs.runs as Record<string, unknown>[]) : [];
      const startFailed = Array.isArray(attrs.start_failed) ? (attrs.start_failed as Record<string, unknown>[]) : [];
      if (!runs.length) return undefined;
      const names = (list: Record<string, unknown>[]) => list.map((r) => str(r.role) || str(r.model)).filter(Boolean).join(", ");
      return `${runs.length} 本（${names(runs)}）${startFailed.length ? `· 起動失敗 ${names(startFailed)}` : ""}`;
    }
    case "s1_plan_review_done": return attrs.failed ? `失敗: ${String(attrs.error ?? "").slice(0, 80)}` : `must ${attrs.must ?? 0} · should ${attrs.should ?? 0} · nit ${attrs.nit ?? 0}${Number(attrs.failed_runs ?? 0) > 0 ? ` · ${attrs.failed_runs} 本失敗` : ""}`;
    // a GO over a must the plan review left carries the reason its giver wrote; a GO without one shows nothing
    case "s1_go": return str(attrs.reason).slice(0, 160) || undefined;
    case "s1_defer":
    case "s3_defer": return str(attrs.reason) || undefined;
    case "s2_start": return str(attrs.model) || undefined;
    case "blocked_by_dependency": return list(attrs.waiting_for).join(" ") || undefined;
    case "s2_model_fallback": return `${str(attrs.from)} → ${str(attrs.to)}`;
    case "s1_recovery_attempt":
    case "s2_recovery_attempt": return `${attrs.attempt_number ?? "?"} 回目`;
    case "s2_result": return `${list(attrs.changed_files).length} ファイル · commit ${attrs.commit_count ?? 0}`;
    case "s2_review_base_merged": return [attrs.by === "executor" ? "executor の merge" : "ハーネスが merge", attrs.merge_commit ? str(attrs.merge_commit).slice(0, 9) : str(attrs.mainline).slice(0, 9)].filter(Boolean).join(" · ") || undefined;
    case "s2_review_base_advanced": return `起点を ${str(attrs.mainline).slice(0, 9)} まで進めた`;
    case "s2_review_base_conflict": return list(attrs.files).slice(0, 6).join(", ") || undefined;
    case "s2_review_base_instructed": return list(attrs.files).slice(0, 6).join(", ") || undefined;
    case "s2_intent_checked":
      return attrs.outcome === "unavailable" ? `答えず: ${str(attrs.reason).slice(0, 120)}`
        : attrs.outcome === "errors" ? `error ${Array.isArray(attrs.remaining) ? attrs.remaining.length : 0} 件${attrs.sent_back === false ? "（戻さず進む）" : ""}`
          : attrs.outcome === "skipped" ? str(attrs.reason).slice(0, 120) || undefined : "error なし";
    case "s2_records_conflict":
    case "s2_records_instructed": return `error ${Array.isArray(attrs.errors) ? attrs.errors.length : 0} 件`;
    case "s2_records_reopened": return [str(attrs.reason).slice(0, 100), list(attrs.files).length ? `${list(attrs.files).length} ファイル` : ""].filter(Boolean).join(" · ") || undefined;
    case "s2_review_base_skipped": return str(attrs.reason).slice(0, 120) || undefined;
    case "s2_order_waiting":
    case "s2_order_released":
    case "s2_order_limit":
    case "s2_order_unknown": {
      const ops = Array.isArray(attrs.opponents) ? (attrs.opponents as Record<string, unknown>[]) : [];
      const lanes = [...new Set(ops.map((o) => str(o.lane)).filter(Boolean))].join("、");
      const files = [...new Set(ops.flatMap((o) => list(o.files)))];
      const shown = `${files.slice(0, 3).join("、")}${files.length > 3 ? ` ほか ${files.length - 3} 件` : ""}`;
      if (event === "s2_order_released") return lanes ? `${lanes} の取り込みで解けた` : undefined;
      if (event === "s2_order_limit") return `${lanes ? `${lanes} を待ったまま` : ""}上限を超えた`;
      if (!lanes) return str(attrs.reason).slice(0, 120) || undefined;
      return `${lanes} の取り込みを待っている${shown ? `（${shown}）` : ""}`;
    }
    case "s3_check_conflict": return list(attrs.conflict_files).join(", ") || undefined;
    case "s3_mechanical_resolve": return `${list(attrs.resolved_files).length} ファイル`;
    case "s3_sub_todo_spawned": return str(attrs.sub_todo_id) || undefined;
    case "s3_reject": return str(attrs.next_stage) === "s1_rethink" ? "方針へ" : "実装へ";
    case "s4_verify_mechanical_fix": return str(attrs.what_was_fixed) || undefined;
    case "s4_pushed": return str(attrs.pushed_branch) || undefined;
    case "s4_push_held": return str(attrs.reason).slice(0, 120) || undefined;
    case "s4_land_approved": return str(attrs.merge_commit).slice(0, 9) || undefined;
    case "s4_land_merged": return attrs.merge_commit ? `${str(attrs.branch).slice(0, 40)} → 本流 @ ${str(attrs.merge_commit).slice(0, 9)}` : undefined;
    case "s4_land_conflict": return list(attrs.conflict_files).slice(0, 6).join(", ") || undefined;
    case "s4_land_check_failed": return `止める検査 ${Number(attrs.blocking ?? 0)} 件`;
    case "s4_land_check_sent_back": return list(attrs.checks).slice(0, 6).join(", ") || undefined;
    case "s4_land_recheck": return [attrs.attempt !== undefined ? `${Number(attrs.attempt)} 回目` : "", str(attrs.reason).slice(0, 120)].filter(Boolean).join(" · ") || undefined;
    case "s4_land_approval_dropped": return str(attrs.reason).slice(0, 120) || undefined;
    case "s4_land_issue_close_queued": return str(attrs.issue) || undefined;
    case "s4_land_issue_close_posted": return str(attrs.issue) || undefined;
    case "s4_land_issue_close_failed": return [str(attrs.issue), str(attrs.reason).slice(0, 120)].filter(Boolean).join(" · ") || undefined;
    case "s4_land_held": return str(attrs.reason).slice(0, 120) || undefined;
    case "s4_land_batch_dropped":
    case "s4_land_hold": return str(attrs.reason).slice(0, 120) || undefined;
    case "s4_land_batch_converted": return [str(attrs.kind) === "resolved" ? "衝突を解いた" : str(attrs.kind) === "rebuilt" ? "生成物を作り直した" : "写しを描き直した", list(attrs.files).slice(0, 4).join(", ")].filter(Boolean).join(" · ") || undefined;
    case "s4_land_batch_landed": return `${list(attrs.lanes).length} 本を 1 回の検査で取り込み`;
    case "s4_push_unsaved": return str(attrs.pushed_branch) || undefined;
    case "s4_push_approved": return str(attrs.commit_message).split("\n")[0].slice(0, 120) || undefined;
    case "s4_r2_overridden": return `must ${attrs.must ?? 0} · should ${attrs.should ?? 0}`;
    case "s4_commit_drafted": return str(attrs.message).split("\n")[0].slice(0, 120) || undefined;
    case "s4_commit_draft_failed": return str(attrs.error).slice(0, 120) || undefined;
    case "s4_pr_body_proposed": return attrs.pr ? `#${attrs.pr}（投稿カードで承認すると書きます）` : undefined;
    case "s4_pr_created": return attrs.pr_number ? `#${attrs.pr_number}${attrs.existing ? "（既存の PR に push。題名と本文はそのまま）" : ""}` : undefined;
    case "s4_ci_failed": return str(attrs.failure_type) || undefined;
    case "s4_review_comment_received": {
      const items = Array.isArray(attrs.items) ? (attrs.items as { author?: unknown }[]) : [];
      if (!items.length) return str(attrs.commenter) || undefined;
      return `${items.length} 件（${[...new Set(items.map((i) => String(i.author ?? "")).filter(Boolean))].join(", ")}）`;
    }
    case "s4_replies_queued": {
      if (!attrs.outbound_id) return str(attrs.skipped) || undefined;
      const followups = list(attrs.followup_ids).length;
      return `返信 ${Number(attrs.parts ?? 0)} 件${followups ? `・別件 ${followups} 件` : ""}`;
    }
    case "s4_pr_drafted": return str(attrs.title) || undefined;
    case "s4_pr_draft_failed":
    case "s4_ship_failed": return str(attrs.error).slice(0, 120) || undefined;
    case "s4_submit_open_failed": return str(attrs.reason).slice(0, 160) || undefined;
    case "s1_revise_requested": return str(attrs.instruction).slice(0, 120) || undefined;
    case "s1_base_advanced": {
      const total = Number(attrs.files_total ?? list(attrs.files).length);
      // none left: the work branch took the change back, or the plan took the work branch in
      if (total === 0) return `plan の触る場所に、分岐点との差が無くなった · 本流 ${str(attrs.to).slice(0, 12)}`;
      return `${attrs.known === false ? "触る場所を取り出せない plan · " : ""}${total} ファイル · 本流 ${str(attrs.to).slice(0, 12)}`;
    }
    case "lane_stalled": return [str(attrs.role), str(attrs.reason)].filter(Boolean).join(": ").slice(0, 160) || undefined;
    case "lane_stall_detected": return [str(attrs.stage), str(attrs.reason).slice(0, 160)].filter(Boolean).join(" · ") || undefined;
    case "lane_stall_instructed": return list(attrs.causes).join(", ") || undefined;
    case "s2_shape_started": return `判断の役を起こした（${attrs.trigger === "symptom" ? "巡に症状が出た" : "巡が止まった"}）`;
    case "s2_shape_judged": {
      if (attrs.unavailable) return `推奨なし（${String(attrs.reason ?? "").slice(0, 100)}）`;
      const rec = attrs.recommendation as { choice?: string; reasons?: unknown[] } | undefined;
      return `推奨: ${rec?.choice === "replan" ? "計画から考え直す" : rec?.choice === "accept" ? "受け入れて後に回す" : "直し続ける"}（根拠 ${rec?.reasons?.length ?? 0} 件）`;
    }
    case "fix_plan_started": return "整理役を起こした";
    case "fix_plan_done": return attrs.failed ? `整理に失敗（案なしで依頼）: ${String(attrs.error ?? "").slice(0, 100)}` : "案を添えて依頼";
    case "lane_wait_notified": return str(attrs.decision) || undefined;
    case "lane_start_skipped": return `${START_STAGE_NAME[str(attrs.stage)] ?? "段"} · ${str(attrs.reason).slice(0, 160)}`;
    case "lane_stall_resumed": return str(attrs.note) || undefined;
    case "claude_quota_wait": return str(attrs.reason).slice(0, 160) || undefined;
    case "claude_quota_fallback": return `${fallbackText(attrs)}${attrs.stage ? ` · ${str(attrs.stage)}` : ""}`;
    case "lane_over_budget": return typeof attrs.cost === "number" && typeof attrs.limit === "number" ? `$${attrs.cost.toFixed(2)} / $${attrs.limit.toFixed(2)}` : undefined;
    case "lane_budget_extended": return typeof attrs.limit === "number" ? `上限 $${attrs.limit.toFixed(2)}` : undefined;
    case "s4_change_pushed": return list(attrs.changed_files).join(", ") || undefined;
    case "lane_close": return attrs.total_duration_hours ? `${attrs.total_duration_hours} 時間` : undefined;
    case "lane_worktree_retired": return str(attrs.branch) ? `branch ${str(attrs.branch)} は残す` : undefined;
    case "lane_worktree_kept": return str(attrs.reason).slice(0, 200) || undefined;
    case "lane_base_set": return `${str(attrs.branch)}${str(attrs.parent) ? `（${str(attrs.parent)}）` : ""}${str(attrs.previous) ? ` ← ${str(attrs.previous)}` : ""}` || undefined;
    case "lane_base_received": return `${str(attrs.branch)}${str(attrs.tip) ? ` @${str(attrs.tip).slice(0, 7)}` : ""}` || undefined;
    case "lane_base_conflict": return list(attrs.files).join(", ").slice(0, 200) || undefined;
    case "priority_elevated":
    case "priority_reset": return str(attrs.reason) || undefined;
    default: return undefined;
  }
}

/** a review lane's history (someone else's PR): the same four shapes, its own words */
export const REVIEW_EVENT_META: Record<string, EventMeta> = {
  r_opened: { label: "PR レビュー 開始", kind: "mark", keep: true },
  r_wt_ready: { label: "PR の複製を用意", kind: "agent" },
  r_map_started: { label: "危ない経路の下調べ 開始", kind: "agent" },
  r_map_done: { label: "危ない経路の下調べ 完了", kind: "mark" },
  r_map_dropped: { label: "地図なしで起こし直し", kind: "warn" },
  r_quota_wait: { label: "Claude の枠待ち", kind: "warn", keep: true },
  r_blind_started: { label: "blind 開始", kind: "agent" },
  r_findings: { label: "blind 完了", kind: "agent" },
  r_triage_started: { label: "判定 開始", kind: "agent" },
  r_triage_done: { label: "判定 完了", kind: "mark", keep: true },
  r_drafted: { label: "下書き", kind: "mark", keep: true },
  r_redraft_requested: { label: "下書きの作り直しを依頼", kind: "user", keep: true },
  r_posted: { label: "投稿", kind: "user", keep: true },
  r_discarded: { label: "下書きを破棄", kind: "user", keep: true },
  r_head_changed: { label: "作者が更新（やり直し）", kind: "mark", keep: true },
  r_confirm_started: { label: "対応の確認 開始", kind: "agent" },
  r_confirm_done: { label: "対応の確認 完了", kind: "agent" },
  r_failed: { label: "失敗", kind: "warn", keep: true },
  r_resumed: { label: "再開", kind: "user", keep: true },
  r_closed: { label: "終了", kind: "mark", keep: true },
};

export const REVIEW_EVENT_WORD: Record<string, string> = { comment: "コメント", "request-changes": "変更を依頼", approve: "Approve" };

/** the timeline's display name for a record (the engine writes some names into a card) */
export function eventLabel(event: string): string {
  return EVENT_META[event]?.label ?? event;
}const sha = (v: unknown) => str(v).slice(0, 9);

function reviewDetailOf(event: string, attrs: Record<string, unknown> = {}): string | undefined {
  const round = Number(attrs.round ?? 0) > 1 ? `${attrs.round} 巡目 · ` : "";
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (event) {
    case "r_wt_ready": return attrs.head ? `head ${sha(attrs.head)}` : undefined;
    case "r_blind_started": return `${round}${n(attrs.run_ids)} 本${attrs.mapped_routes ? `（経路 ${attrs.mapped_routes} 本 + 残り）` : ""}${attrs.routes_over_cap ? ` · 経路が ${attrs.route_count ?? ""} 本（責務が複数ある合図）` : ""}${attrs.map_skipped ? ` · 地図なし: ${str(attrs.map_skipped).slice(0, 80)}` : ""}`;
    case "r_map_dropped": return str(attrs.reason) || undefined;
    case "r_quota_wait": return str(attrs.reason).slice(0, 160) || undefined;
    case "r_map_done": return attrs.failed ? `${round}失敗: ${str(attrs.error).slice(0, 80)}（地図なしで続ける）` : `${round}経路 ${n(attrs.routes)} 本`;
    case "r_findings": return `${round}報告 ${n(attrs.files)} 件`;
    case "r_triage_done": return `${round}受理 ${n(attrs.accepted)} · 棄却 ${n(attrs.rejected)} · 判断を求める ${n(attrs.escalated)}`;
    case "r_drafted": return `${round}投稿カードへ · 案 ${REVIEW_EVENT_WORD[str(attrs.suggested)] ?? (str(attrs.suggested) || "—")}`;
    case "r_posted": return REVIEW_EVENT_WORD[str(attrs.event)] ?? (str(attrs.event) || undefined);
    case "r_head_changed": return `head ${sha(attrs.previous)} → ${sha(attrs.head)}`;
    case "r_confirm_done": return attrs.head ? `head ${sha(attrs.head)}` : undefined;
    case "r_failed": return str(attrs.error).slice(0, 120) || undefined;
    case "r_closed": return str(attrs.reason) || undefined;
    default: return undefined;
  }
}

export interface RawEvent {
  event: string;
  at: string;
  attrs?: Record<string, unknown>;
}

/**
 * penne's answer on a stuck card, named for what followed it on record: a fix, the stopped stage run again, or
 * going on without a fix. Just after the answer, before the loop moved, it is named for where the loop takes it.
 */
function resumedDetail(events: RawEvent[], i: number): string {
  if (events[i].attrs?.decision === "accept") return "この状態で進める";
  const evs = events as LifecycleRecord[];
  if (fixAfter(evs, i)) return "修正を続ける";
  const moved = events.slice(i + 1).some((e) => (REVIEW_EVENTS as readonly string[]).includes(e.event));
  if (!moved && reviewLoopState(evs.slice(0, i + 1)).state === "send_fix") return "修正を続ける";
  return answeredJudgementAt(evs, i) >= 0 ? "直さずに続ける" : "止まった段をやり直す";
}

function entryOf(e: RawEvent, i: number, events: RawEvent[]): TimelineEntry & { keep: boolean } {
  // S3 passed by the pipeline itself is not penne's approval and must not read like one
  const auto = e.event === "s3_ok" && e.attrs?.at_by === "auto";
  const meta = auto ? { label: "S3 自動通過", kind: "mark" as Kind, keep: true } : EVENT_META[e.event] ?? { label: e.event, kind: "agent" as Kind };
  return {
    time: e.at.slice(11, 16),
    title: meta.label,
    detail: withFallbacks(e.event === "s2_review_resumed" ? resumedDetail(events, i) : detailOf(e.event, e.attrs), e.attrs ?? {}),
    kind: meta.kind,
    keep: Boolean(meta.keep),
  };
}

const JST_CLOCK = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** HH:MM in Japan time; a review lane's history is written in UTC */
export function clockJst(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(11, 16) : JST_CLOCK.format(t);
}

/** "5m 前", but "たった今" and "昨日" already say when */
export function agoLabel(elapsed: string): string {
  return elapsed === "たった今" || elapsed === "昨日" || !elapsed ? elapsed : `${elapsed} 前`;
}

function reviewEntryOf(e: RawEvent): TimelineEntry & { keep: boolean } {
  const meta = REVIEW_EVENT_META[e.event] ?? { label: e.event, kind: "agent" as Kind };
  return { time: clockJst(e.at), title: meta.label, detail: withFallbacks(reviewDetailOf(e.event, e.attrs), e.attrs ?? {}), kind: meta.kind, keep: Boolean(meta.keep) };
}

export function buildTimeline(events: RawEvent[]): TimelineEntry[] {
  return foldTimeline(events.map((e, i) => entryOf(e, i, events)));
}

export function buildReviewTimeline(events: RawEvent[]): TimelineEntry[] {
  return foldTimeline(events.map(reviewEntryOf));
}

/** the milestones and penne's own decisions stay; the agent's moves between them fold into one row */
function foldTimeline(entries: (TimelineEntry & { keep: boolean })[]): TimelineEntry[] {
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

  for (const entry of entries) {
    const { keep, ...rest } = entry;
    if (keep) { flush(); out.push(rest); } else { run.push(rest); }
  }
  flush();
  return out;
}
