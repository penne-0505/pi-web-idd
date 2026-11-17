/**
 * The point a mention adds to a send. The composer's mention picker names a lane or a card by its identity, and
 * the engine reads the values back from its own state here, so the block is the engine's answer and not a copy
 * the screen carried (C-167-5). Only the point rides along: the lane's id, title, stage and Issue, and the
 * card's kind and its ask. Facts, rationales, plans and Choice text do not (C-167-4). A name the state does not
 * hold, or a sixth mention, is refused before anything is sent (AC-002).
 */
import type { IddState } from "./state.ts";

/** the most mentions one send may carry */
export const MAX_MENTIONS = 5;

/** one mention as the composer names it: a lane by id, or a card by its lane, kind and (for a question) batch */
export interface MentionRef {
  lane: string;
  /** the card's kind; absent means the lane itself */
  kind?: string;
  /** the question batch, which is what tells one question card from another */
  batchId?: string;
}

export interface ParsedMentions {
  refs: MentionRef[];
  error: string | null;
}

const GROUP_LABEL: Record<string, string> = { judge: "判断待ち", prep: "下調べ中", impl: "実装中", waiting: "待機中", closed: "終端" };

/**
 * Read the mentions off a send body. `undefined` and `null` mean the send names none; anything else must be an
 * array of objects with a lane id, and more than five is refused.
 */
export function parseMentions(value: unknown): ParsedMentions {
  if (value === undefined || value === null) return { refs: [], error: null };
  if (!Array.isArray(value)) return { refs: [], error: "mentions must be an array" };
  const refs: MentionRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { refs: [], error: "mention の形が違います" };
    const raw = entry as { lane?: unknown; kind?: unknown; batchId?: unknown };
    if (typeof raw.lane !== "string" || !raw.lane.trim()) return { refs: [], error: "mention に lane（IDD-xxx）がありません" };
    const ref: MentionRef = { lane: raw.lane.trim() };
    if (typeof raw.kind === "string" && raw.kind.trim()) ref.kind = raw.kind.trim();
    if (typeof raw.batchId === "string" && raw.batchId.trim()) ref.batchId = raw.batchId.trim();
    refs.push(ref);
  }
  if (refs.length > MAX_MENTIONS) return { refs: [], error: `mention は 1 通 ${MAX_MENTIONS} 件までです` };
  return { refs, error: null };
}

function laneSource(source: { label?: string; url?: string } | undefined): string {
  if (!source?.label) return "";
  return `Issue: ${source.label}${source.url ? ` ${source.url}` : ""}`;
}

function cardHeadline(item: Record<string, unknown>): string {
  const kind = String(item.kind ?? "");
  if (kind === "question") {
    const open = Array.isArray(item.open) ? (item.open as Record<string, unknown>[]) : [];
    const asks = open.map((q) => {
      const options = Array.isArray(q.options) ? (q.options as { label?: string }[]).map((o) => o.label ?? "").filter(Boolean) : [];
      return `質問: ${String(q.question ?? "")}${options.length ? `（選択肢: ${options.join(" / ")}）` : ""}`;
    });
    return asks.length ? asks.join(" / ") : "質問: (問いなし)";
  }
  if (kind === "go") {
    const s = (item.summary ?? {}) as { situation?: string; action?: string; outcome?: string };
    return `GO: ${s.situation ?? ""} / ${s.action ?? ""} / ${s.outcome ?? ""}`;
  }
  return `${kind}: ${String(item.laneTitle ?? item.title ?? "")}`;
}

/**
 * Build the block from the refs and the engine's state. Every ref must still be in the state; a lane that is
 * gone, or a card that is not there, is refused with a line the composer shows.
 */
export function buildMentionBlock(refs: readonly MentionRef[], state: IddState): { block: string; error: string | null } {
  if (!refs.length) return { block: "", error: null };
  const lines: string[] = [];
  for (const ref of refs) {
    const lane = state.lanes.find((l) => l.iddId === ref.lane);
    if (!lane) return { block: "", error: `mention の lane がありません: ${ref.lane}` };
    if (!ref.kind) {
      const parts = [`- lane ${lane.iddId}「${lane.title}」`, `段: ${lane.blockedBy ?? GROUP_LABEL[lane.group] ?? lane.group}`];
      const source = laneSource(lane.source);
      if (source) parts.push(source);
      lines.push(parts.join(" "));
      continue;
    }
    const item = state.items.find((i) => {
      const rec = i as unknown as { iddId?: string; kind?: string; batchId?: string };
      if (rec.iddId !== ref.lane || rec.kind !== ref.kind) return false;
      if (ref.batchId && rec.batchId !== ref.batchId) return false;
      return true;
    });
    if (!item) return { block: "", error: `mention の card がありません: ${ref.lane} ${ref.kind}` };
    const rec = item as unknown as Record<string, unknown>;
    const stage = lane.blockedBy ?? GROUP_LABEL[lane.group] ?? lane.group;
    lines.push(`- lane ${lane.iddId}「${lane.title}」 段: ${stage} / card ${ref.kind} ${lane.iddId}: ${cardHeadline(rec)}`);
  }
  const block = [
    "[propter の記録]",
    "次の記録を参照して答えてください。要点だけを添えています。詳しくは propter_read の道具で引けます。",
    ...lines,
  ].join("\n");
  return { block, error: null };
}
