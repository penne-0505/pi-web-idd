import { relative } from "node:path";

import { elapsedLabel, laneCost, readReviewLane, reviewLaneLabel, reviewLaneState, slotWaits, stateDir, subscriptionTotal } from "@idd/core";
import type { LaneGroup, ReviewLaneRecord, ReviewLaneState } from "@idd/core";
import { pendingOutbound } from "@idd/lane";

import type { ReviewLaneDetailView } from "../../../../lib/idd-ui/types.ts";
import { agoLabel, buildReviewTimeline, REVIEW_EVENT_WORD } from "./events-display";
import { claudeQuotaView, claudeRunsView, runIdsOf } from "./claude-view";
import { laneSlotWait } from "../../../../lib/idd-ui/slot-wait.ts";

export const isReviewLaneId = (id: string) => id.startsWith("REV-");

/** where a review lane sits in the lane list: the outbound card and a stop are penne's, the author's turn is waiting */
export function reviewGroup(st: ReviewLaneState): LaneGroup {
  if (st.state === "closed") return "closed";
  if (st.state === "stuck" || st.state === "awaiting_penne") return "judge";
  if (st.state === "awaiting_author") return "waiting";
  return "impl";
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);

function lastAttr(rec: ReviewLaneRecord, key: string): string | undefined {
  for (let i = rec.history.length - 1; i >= 0; i -= 1) {
    const v = rec.history[i].attrs?.[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function reportsOf(rec: ReviewLaneRecord): ReviewLaneDetailView["reports"] {
  const out: ReviewLaneDetailView["reports"] = [];
  const shown = (p: string) => {
    const rel = relative(stateDir(), p);
    return rel && !rel.startsWith("..") ? rel : p;
  };
  for (const e of rec.history) {
    const round = Number(e.attrs?.round ?? 1) || 1;
    if (e.event === "r_map_done") {
      for (const path of strs(e.attrs?.report_md)) out.push({ round, stage: "map", label: "経路の地図", path: shown(path) });
    } else if (e.event === "r_findings") {
      const files = strs(e.attrs?.files);
      files.forEach((path, i) => out.push({ round, stage: "blind", label: files.length > 1 ? `blind ${i + 1}` : "blind", path: shown(path) }));
    } else if (e.event === "r_triage_done") {
      for (const path of strs(e.attrs?.report_md)) out.push({ round, stage: "triage", label: "判定", path: shown(path) });
    } else if (e.event === "r_confirm_done") {
      for (const path of strs(e.attrs?.files)) out.push({ round, stage: "confirm", label: "対応の確認", path: shown(path) });
    }
  }
  return out;
}

export async function buildReviewLaneDetail(id: string): Promise<ReviewLaneDetailView | null> {
  let rec: ReviewLaneRecord | null;
  try {
    rec = readReviewLane(id);
  } catch {
    return null;
  }
  if (!rec) return null;
  const st = reviewLaneState(rec);
  const drafted = [...rec.history].reverse().find((e) => e.event === "r_drafted");
  const outboundId = drafted ? String(drafted.attrs?.outbound_id ?? "") : "";
  const cost = await laneCost(rec.id, rec.history.map((e) => ({ ...e, idd_id: rec.id })));
  const round = (cost: number) => Math.round(cost * 1000) / 1000;
  const shownParts = (parts: { label: string; cost: number }[]) => parts.filter((p) => p.cost > 0).map((p) => ({ label: p.label, cost: round(p.cost) }));
  // the confirm compares against the head seen before the author's push; the PR's base stays where the copy was cut
  const base = rec.history.find((e) => e.event === "r_wt_ready")?.attrs?.base;
  const prBase = typeof base === "string" && base ? base : undefined;
  const changed = [...rec.history].reverse().find((e) => e.event === "r_head_changed")?.attrs?.previous;
  const previousHead = typeof changed === "string" && changed ? changed : undefined;
  const suggested = drafted?.attrs?.suggested ? String(drafted.attrs.suggested) : "";
  // the stages that ran on Claude Code: what they did, and the windows' use beside their spend
  const claude = claudeRunsView(runIdsOf(rec.history));
  const quota = claude ? claudeQuotaView() : undefined;
  let slotWait: ReturnType<typeof laneSlotWait>;
  try {
    slotWait = laneSlotWait(slotWaits(), rec.id);
  } catch (err) {
    // the detail shows without it
    console.warn(`[idd review detail] 上限待ちを数えられませんでした: ${String(err).slice(0, 400)}`);
  }

  return {
    kind: "review",
    iddId: rec.id,
    title: String(rec.history.find((e) => e.event === "r_wt_ready")?.attrs?.title ?? rec.title),
    group: reviewGroup(st),
    phaseLabel: reviewLaneLabel(st),
    ...(st.state === "stuck" ? { stuck: st.reason } : {}),
    since: agoLabel(elapsedLabel(rec.history[rec.history.length - 1]?.at ?? rec.created_at)),
    pr: {
      repo: rec.repo,
      number: rec.pr,
      url: rec.url,
      ...(lastAttr(rec, "head") ? { head: lastAttr(rec, "head") } : {}),
      ...(prBase ? { base: prBase } : {}),
      ...(previousHead ? { previousHead } : {}),
    },
    rounds: rec.history.filter((e) => e.event === "r_triage_done").length,
    timeline: buildReviewTimeline(rec.history),
    reports: reportsOf(rec),
    cost: { total: round(cost.total), parts: shownParts(cost.parts), subscription: shownParts(cost.subscription) },
    spend: { budget: cost.total, subscription: subscriptionTotal(cost) },
    ...(claude ? { claude: [claude] } : {}),
    ...(quota ? { quota } : {}),
    ...(outboundId ? {
      draft: {
        outboundId,
        onCard: pendingOutbound().some((o) => o.id === outboundId),
        ...(suggested ? { suggested: REVIEW_EVENT_WORD[suggested] ?? suggested } : {}),
      },
    } : {}),
    ...(slotWait ? { slotWait } : {}),
  };
}
