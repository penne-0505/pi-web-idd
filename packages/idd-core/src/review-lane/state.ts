import type { RiskRoute } from "../agent/port.ts";
import { routesOf } from "../ledger/review-loop.ts";

/**
 * A review lane: someone else's PR, reviewed with the same blind / triage / confirm stages as the
 * S2 loop, and answered through the outbound card. The state is read from the lane's history alone.
 * A blind round of a large diff may begin with a map of the routes a value passes through (r_map_*), which only shapes its blinds.
 */

export interface ReviewEvent {
  event: string;
  at: string;
  attrs: Record<string, unknown>;
}

export interface ReviewLaneRecord {
  id: string;
  repo: string;
  pr: number;
  title: string;
  url: string;
  created_at: string;
  history: ReviewEvent[];
}

export type ReviewLaneState =
  | { state: "prepare" }
  /** map: the round's map is done (its routes, none when it failed or found nothing); absent before one ran */
  | { state: "start_blind"; round: number; base: string; head: string; map?: { routes: RiskRoute[] } }
  | { state: "running_map"; round: number; runId: string; base: string; head: string }
  | { state: "running_blind"; round: number; runIds: string[] }
  | { state: "start_triage"; round: number; inputs: string[] }
  | { state: "running_triage"; round: number; runId: string }
  | { state: "draft"; round: number }
  | { state: "awaiting_penne"; round: number; outboundId: string }
  | { state: "awaiting_author"; round: number; head: string }
  | { state: "start_confirm"; round: number; base: string; head: string }
  | { state: "running_confirm"; round: number; runId: string }
  | { state: "stuck"; reason: string }
  | { state: "closed"; reason: string };

const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function last(history: ReviewEvent[], name: string): ReviewEvent | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].event === name) return history[i];
  return undefined;
}

export function reviewLaneState(rec: ReviewLaneRecord): ReviewLaneState {
  const h = rec.history;
  const ev = h[h.length - 1];
  const round = h.filter((e) => e.event === "r_triage_done").length + 1;
  const wt = last(h, "r_wt_ready");
  if (!ev) return { state: "prepare" };
  const a = ev.attrs ?? {};
  switch (ev.event) {
    case "r_opened":
      return { state: "prepare" };
    case "r_wt_ready":
      return { state: "start_blind", round: 1, base: str(a.base), head: str(a.head) };
    // waiting for Claude Code's windows leaves the lane where it was
    case "r_quota_wait":
      return reviewLaneState({ ...rec, history: h.slice(0, -1) });
    case "r_map_started":
      return { state: "running_map", round: Number(a.round ?? round), runId: str(a.run_id), base: str(a.base), head: str(a.head) };
    case "r_map_done":
      return { state: "start_blind", round: Number(a.round ?? round), base: str(a.base), head: str(a.head), map: { routes: routesOf(a.routes) } };
    // the whole-diff blind of a routed round did not finish: the round runs again as if there were no map
    case "r_map_dropped":
      return { state: "start_blind", round: Number(a.round ?? round), base: str(a.base), head: str(a.head), map: { routes: [] } };
    case "r_blind_started":
      return { state: "running_blind", round: Number(a.round ?? round), runIds: strs(a.run_ids) };
    case "r_findings": {
      // a re-review judges the confirm and the increment's blind together, with what was said before
      const confirm = last(h, "r_confirm_done");
      const prior = last(h, "r_triage_done");
      const inputs = [...strs(a.files), ...(Number(a.round) > 1 && confirm ? strs(confirm.attrs.files) : []), ...(Number(a.round) > 1 && prior?.attrs.report_md ? [str(prior.attrs.report_md)] : [])];
      return { state: "start_triage", round: Number(a.round ?? round), inputs };
    }
    case "r_triage_started":
      return { state: "running_triage", round: Number(a.round ?? round), runId: str(a.run_id) };
    case "r_triage_done":
      return { state: "draft", round: Number(a.round ?? round) };
    case "r_drafted":
      return { state: "awaiting_penne", round: Number(a.round ?? round), outboundId: str(a.outbound_id) };
    case "r_posted":
      if (a.event === "approve") return { state: "closed", reason: "Approve した" };
      return { state: "awaiting_author", round: Number(a.round ?? round), head: str(a.head) };
    case "r_redraft_requested":
      // penne asked for the draft again (e.g. after the format changed): the same triage, a new card
      return { state: "draft", round: Number(a.round ?? round) };
    case "r_discarded":
      // nothing was sent; keep watching, so a push from the author still gets a look
      return { state: "awaiting_author", round: Number(a.round ?? round), head: str(a.head) };
    case "r_head_changed":
      return { state: "start_confirm", round, base: str(a.previous), head: str(a.head) };
    case "r_confirm_started":
      return { state: "running_confirm", round: Number(a.round ?? round), runId: str(a.run_id) };
    case "r_confirm_done":
      return { state: "start_blind", round: Number(a.round ?? round), base: str(a.base), head: str(a.head) };
    // a failure records the state to retry; continuing starts that state again
    case "r_failed":
      return { state: "stuck", reason: str(a.error) };
    case "r_resumed": {
      const failed = last(h, "r_failed");
      const retry = failed?.attrs.retry_state as ReviewLaneState | undefined;
      return retry && typeof retry === "object" && "state" in retry ? retry : { state: "stuck", reason: "再試行する段が記録にありません" };
    }
    case "r_closed":
      return { state: "closed", reason: str(a.reason) };
    default:
      return wt ? { state: "stuck", reason: `未知の記録: ${ev.event}` } : { state: "prepare" };
  }
}

export function reviewLaneLabel(s: ReviewLaneState): string {
  switch (s.state) {
    case "prepare": return "PR を準備中";
    case "running_map": return "危ない経路の下調べ中";
    case "start_blind":
    case "running_blind": return s.round > 1 ? "PR レビューをやり直し中" : "PR レビュー中";
    case "start_triage":
    case "running_triage": return "指摘の判定中";
    case "draft": return "下書きを作成中";
    case "awaiting_penne": return "投稿カードの確認待ち";
    case "awaiting_author": return "作者の対応待ち";
    case "start_confirm":
    case "running_confirm": return "対応の確認中";
    case "stuck": return "要判断";
    case "closed": return "終了";
  }
}

export interface DraftItem { severity: string; claim: string; path?: string; reason?: string; fix?: string; impact?: string; action?: string; /** the judgement chose to tell the author this should */ report?: boolean }

/**
 * The review body before the rewrite: only the musts and the shoulds the judgement chose to report, each item
 * its essence and the evidence. Nits and unreported shoulds stay on record, and no request is written: the body
 * says what is off and where, and the rewrite only shapes it.
 */
export function renderReviewDraft(accepted: DraftItem[]): { body: string; event: "comment" | "request-changes" | "approve" } {
  const shown = accepted.filter((a) => a.severity === "must" || (a.severity === "should" && a.report === true && a.action !== "followup"));
  const by = (s: string) => shown.filter((a) => a.severity === s);
  // one finding is one numbered item: its evidence is a paragraph inside it, so it never reads as a finding of its own
  const item = (a: DraftItem, i: number) => [
    `${i + 1}. **${a.claim}**${a.path ? `（\`${a.path}\`）` : ""}`,
    ...(a.reason ? ["", `   ${a.reason}`] : []),
  ].join("\n");
  const block = (s: string, items: DraftItem[]) => {
    if (!items.length) return [];
    const detailed = items.some((a) => a.reason);
    return [`## ${s}`, "", ...items.map(item).join(detailed ? "\n\n" : "\n").split("\n"), ""];
  };
  const musts = by("must");
  const event = musts.length ? "request-changes" : "approve";
  const lead = event === "approve" && shown.length ? ["blocker は無いので Approve します。", ""] : [];
  const body = [...lead, ...block("must", musts), ...block("should", by("should"))].join("\n").trim();
  return { body, event };
}
