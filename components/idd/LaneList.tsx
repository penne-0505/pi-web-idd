"use client";

// intent: sidebar の Lanes mode。lane の索引に徹し、判断そのものは main (Inbox / lane タブ) で行う。
// 状態は語ではなく section と stage bar とアイコンで示す。上限は section 見出しの n / cap が兼ねる。

import type { DecisionKind, LaneRow, LaneSection } from "@/lib/idd-ui/types";
import { Icon, StageBar, type IconName } from "./primitives";
import { FS } from "@/lib/idd-ui/scale";

const DECISION_ICON: Record<DecisionKind, IconName> = {
  duplicate: "merge",
  question: "chat",
  go: "go",
  review: "diff",
  ship: "approve",
};

/* 視線の入口は 1 行につき 1 つ (= 題名) にする。他はすべて従で、
   群ごとに従の濃度を変えて「いま見るべき群」を先に拾えるようにする。 */
type Attention = "act" | "live" | "idle" | "done";

function attentionOf(lane: LaneRow): Attention {
  if (lane.faded) return "done";
  if (lane.decision) return "act";
  if (lane.group === "waiting") return "idle";
  return "live";
}

const TITLE: Record<Attention, { weight: number; color: string }> = {
  act: { weight: 600, color: "var(--text)" },
  live: { weight: 500, color: "var(--text)" },
  idle: { weight: 400, color: "var(--text-muted)" },
  done: { weight: 400, color: "var(--text-dim)" },
};

function Row({ lane, selected, onSelect }: { lane: LaneRow; selected?: boolean; onSelect?: (id: string) => void }) {
  const halted = lane.group === "waiting";
  const attn = attentionOf(lane);
  const title = TITLE[attn];
  return (
    <button
      onClick={onSelect ? () => onSelect(lane.iddId) : undefined}
      className="idd-row"
      style={{
        position: "relative",
        display: "flex", flexDirection: "column", gap: 3, width: "100%",
        minHeight: 54, padding: "9px 12px 9px 14px",
        background: selected ? "var(--bg-selected)" : "transparent",
        border: "none", textAlign: "left", cursor: "pointer",
      }}
    >
      {/* 判断を待っている行だけ、左端に印を置く。群を跨いで一目で拾える */}
      {attn === "act" ? (
        <span aria-hidden style={{ position: "absolute", left: 0, top: 9, bottom: 9, width: 3, borderRadius: 2, background: "var(--accent)" }} />
      ) : null}

      <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
        <span
          style={{
            flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: FS.md, fontWeight: title.weight, color: title.color,
          }}
        >
          {lane.title}
        </span>
        {lane.decision ? <Icon name={DECISION_ICON[lane.decision]} size={13} color="var(--text-muted)" /> : null}
      </span>

      {/* 従の列。濃度は群に従い、判断待ち以外では背景に近づく */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", opacity: attn === "act" ? 1 : attn === "done" ? 0.5 : 0.75 }}>
        <StageBar done={lane.stageDone} current={lane.stageCurrent} halted={halted} faded={lane.faded} />
        <span style={{ flex: 1 }} />
        {lane.blockedBy ? <Icon name="link" size={11} color="var(--text-dim)" /> : null}
        <span style={{ fontSize: FS.xs, color: "var(--text-dim)", flexShrink: 0 }}>
          {lane.blockedBy ?? (halted ? "空き待ち" : lane.elapsed)}
        </span>
      </span>
    </button>
  );
}

export function LaneList({ sections, lanes, selectedId, areaLabel, onSelect, onIntake }: {
  sections: LaneSection[];
  lanes: LaneRow[];
  selectedId?: string | null;
  areaLabel?: string;
  onSelect?: (id: string) => void;
  onIntake?: () => void;
}) {
  return (
    <div className="idd" style={{ display: "contents" }}>
      {/* 絞り込み。単一 area で運用している間は触らない */}
      <div style={{ flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <button
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 8px", borderRadius: 3,
            background: "var(--bg)", border: "1px solid var(--border)",
            color: "var(--text-muted)", fontSize: FS.sm, cursor: "pointer",
          }}
        >
          {areaLabel ?? "all areas"} ▾
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 80 }}>
        {sections.map((section, i) => {
          const rows = lanes.filter((l) => l.group === section.group);
          if (!rows.length) return null;
          return (
            <div key={section.group}>
              {i > 0 ? <div style={{ height: 1, background: "var(--border)" }} /> : null}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "20px 12px 6px 14px" }}>
                <span style={{ fontSize: FS.xs, fontWeight: 600, letterSpacing: "0.04em", color: "var(--text-muted)" }}>
                  {section.label}
                </span>
                <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>
                  {section.cap ? `${section.count} / ${section.cap}` : section.count}
                </span>
                {section.collapsed ? <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>▾</span> : null}
              </div>
              {rows.map((lane) => (
                <Row key={lane.iddId} lane={lane} selected={selectedId === lane.iddId} onSelect={onSelect} />
              ))}
            </div>
          );
        })}
      </div>

      {/* 取り込みは lane 一覧そのものを増やす操作なので、一覧の器である sidebar に属する */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", padding: "10px 12px 12px" }}>
        <button
          onClick={onIntake}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            minHeight: 34, padding: "6px 12px", borderRadius: 4,
            background: "var(--bg)", border: "1px solid var(--text-muted)",
            color: "var(--text)", fontSize: FS.md, cursor: "pointer",
          }}
        >
          <Icon name="intake" size={14} />
          今すぐ取り込む
        </button>
      </div>
    </div>
  );
}

/** Sessions ⇄ Lanes。既存 UI への追加はこの 1 行だけ。 */
export function SidebarModeSwitch({ mode, laneBadge, onChange }: {
  mode: "sessions" | "lanes";
  laneBadge?: number;
  onChange: (m: "sessions" | "lanes") => void;
}) {
  const half = (id: "sessions" | "lanes", label: string, badge?: number) => {
    const on = mode === id;
    return (
      <button
        onClick={() => onChange(id)}
        style={{
          flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          minHeight: 30, padding: "5px 10px",
          background: on ? "var(--accent)" : "var(--bg)",
          border: "none",
          borderLeft: id === "lanes" ? "1px solid var(--border)" : "none",
          color: on ? "#fff" : "var(--text-muted)",
          fontSize: FS.md, fontWeight: on ? 600 : 400, cursor: "pointer",
        }}
      >
        {label}
        {badge ? <span style={{ fontSize: FS.xs, fontWeight: 600 }}>{badge}</span> : null}
      </button>
    );
  };
  return (
    <div style={{ padding: "4px 16px 10px" }}>
      <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden" }}>
        {half("sessions", "Sessions")}
        {half("lanes", "Lanes", laneBadge)}
      </div>
    </div>
  );
}
