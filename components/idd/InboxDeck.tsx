"use client";

// intent: DEC-620 — 判断キューは一覧ではなく札束 (1 画面 = 1 判断)
// intent: DEC-621 — 軸は縦。次は下から入り、判断済みは手前へ抜ける
// intent: DEC-622 — 残りは種類だけを距離減衰で示す
// intent: DEC-623 — 記録中は焦点を動かさない

import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionKind, InboxItem } from "@/lib/idd-ui/types";
import { CardFrame, Icon, type IconName } from "./primitives";
import { InboxCard, type DecideHandler } from "./cards";
import { FS } from "@/lib/idd-ui/scale";

const KIND_ICON: Record<DecisionKind, IconName> = {
  duplicate: "merge",
  question: "chat",
  go: "go",
  review: "diff",
  ship: "approve",
};

function itemLabel(item: InboxItem): string {
  switch (item.kind) {
    case "duplicate": return item.incoming.title;
    case "question": return item.question;
    case "review": return item.target.title;
    default: return item.title;
  }
}

const MARKER_MAX = 40;
const MARKER_MIN = 20;
const MARKER_DECAY = 0.55;
const MARKER_ICON = 22;

function Remaining({ items, index, onJump, row, locked }: {
  items: InboxItem[];
  index: number;
  onJump: (i: number) => void;
  row?: boolean;
  locked?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: row ? "row" : "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
      {row ? null : <span style={{ paddingBottom: 4, fontSize: FS.xs, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: FS.md, fontWeight: 600, color: "var(--text)" }}>{items.length ? index + 1 : 0}</span>
        {" / "}
        {items.length}
      </span>}
      {items.map((item, i) => {
        const on = i === index;
        const d = Math.abs(i - index);
        const box = Math.round(MARKER_MIN + (MARKER_MAX - MARKER_MIN) * MARKER_DECAY ** d);
        return (
          <button
            key={`${item.kind}-${item.iddId}`}
            onClick={() => onJump(i)}
            disabled={locked}
            title={itemLabel(item)}
            aria-current={on || undefined}
            className="idd-marker"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: box, height: box, padding: 0,
              background: "transparent", border: "none",
              color: on ? "var(--text)" : d === 1 ? "var(--text-muted)" : "var(--text-dim)",
              cursor: locked ? "default" : "pointer", flexShrink: 0,
            }}
          >
            <span style={{ display: "inline-flex", transform: `scale(${(box * 0.56) / MARKER_ICON})` }}>
              <Icon name={KIND_ICON[item.kind]} size={MARKER_ICON} color="currentColor" weight={on ? 1.6 : 1.2} />
            </span>
          </button>
        );
      })}
      {row ? (
        <>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: FS.sm, color: "var(--text-muted)" }}>
            <span style={{ fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>{items.length ? index + 1 : 0}</span>
            {" / "}
            {items.length}
          </span>
        </>
      ) : null}
    </div>
  );
}

function Flip({ icon, label, disabled, onClick, showLabel }: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  showLabel?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="idd-btn idd-btn-secondary"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        width: showLabel ? undefined : 38, height: 38, padding: showLabel ? "0 16px" : 0, borderRadius: 5,
        color: disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: FS.md,
        background: "transparent",
        border: `1px solid ${disabled ? "var(--border)" : "var(--border-strong)"}`,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1, flexShrink: 0,
      }}
    >
      {showLabel && icon === "prev" ? <Icon name={icon} size={17} color="currentColor" /> : null}
      {showLabel ? label : <Icon name={icon} size={17} color="currentColor" />}
      {showLabel && icon === "next" ? <Icon name={icon} size={17} color="currentColor" /> : null}
    </button>
  );
}

const FRAME_HEIGHT = "clamp(400px, 60vh, 700px)";

const WHEEL_THRESHOLD = 90;

export function InboxDeck({ items, onDecide, onAsk, compact, variant = "frame", pendingId, decidedId, failure }: {
  items: InboxItem[];
  onDecide: DecideHandler;
  onAsk?: (item: InboxItem) => void;
  compact?: boolean;
  pendingId?: string | null;
  decidedId?: string | null;
  failure?: { id: string; message: string } | null;
  variant?: "frame" | "flow";
}) {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<"next" | "prev">("next");

  const last = Math.max(0, items.length - 1);
  const at = Math.min(index, last);
  useEffect(() => { if (index > last) setIndex(last); }, [index, last]);

  // intent: DEC-623 — 結果が返る場所から目を離させない
  const locked = Boolean(pendingId);

  const move = useCallback((d: number) => {
    if (locked) return;
    setDir(d < 0 ? "prev" : "next");
    setIndex((i) => Math.min(Math.max(0, Math.min(i, last) + d), last));
  }, [last, locked]);

  const jump = useCallback((i: number) => {
    if (locked) return;
    setIndex((prev) => { setDir(i < prev ? "prev" : "next"); return i; });
  }, [locked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { move(-1); e.preventDefault(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { move(1); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const wheelRef = useRef({ acc: 0, at: 0 });
  useEffect(() => {
    if (variant !== "frame") return;
  // intent: DEC-640 — 札の外のホイールはめくる。札の中は札自身のスクロール
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-idd-card]")) return;
      const now = performance.now();
      const w = wheelRef.current;
      if (now - w.at > 400) w.acc = 0;
      w.acc += e.deltaY;
      if (Math.abs(w.acc) < WHEEL_THRESHOLD) return;
      move(w.acc > 0 ? 1 : -1);
      w.acc = 0;
      w.at = now;
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [move, variant]);

  const item = items[at];
  if (!item) return null;

  const behind = Math.min(2, items.length - 1 - at);
  const recording = Boolean(pendingId && pendingId === item.iddId);
  const leaving = Boolean(decidedId && decidedId === item.iddId);
  const failedHere = failure && failure.id === item.iddId ? failure.message : null;
  const cardClass = leaving ? "idd-leave" : dir === "prev" ? "idd-enter-prev" : "idd-enter-next";

  if (variant === "flow") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Remaining items={items} index={at} onJump={jump} row locked={locked} />
        <div style={{ position: "relative", paddingRight: behind * 10 }}>
          {Array.from({ length: behind }, (_, i) => behind - i).map((n) => (
            <div
              key={n}
              aria-hidden
              style={{
                position: "absolute",
                left: n * 10, right: (behind - n) * 10, top: n * 5, bottom: n * 5,
                borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border)",
              }}
            />
          ))}
          <div key={`${item.kind}-${item.iddId}`} className={cardClass} style={{ position: "relative", opacity: recording ? 0.6 : 1, pointerEvents: recording ? "none" : undefined }}>
            <InboxCard
              item={item}
              onDecide={onDecide}
              onAsk={onAsk ? () => onAsk(item) : undefined}
              compact={compact}
            />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
          <Flip icon="prev" label="前の札" showLabel disabled={locked || at === 0} onClick={() => move(-1)} />
          <span style={{ flex: 1 }} />
          <Flip icon="next" label="後で見る" showLabel disabled={locked || at >= last} onClick={() => move(1)} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
      <Remaining items={items} index={at} onJump={jump} locked={locked} />

      <div style={{ flex: 1, minWidth: 0, position: "relative", height: FRAME_HEIGHT, paddingBottom: behind * 8 }}>
        {Array.from({ length: behind }, (_, i) => behind - i).map((n) => (
          <div
            key={n}
            aria-hidden
            className="idd-behind"
            style={{
              position: "absolute",
              left: 7, right: 7, top: n * 8, bottom: (behind - n) * 8,
              borderRadius: 6,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
            }}
          />
        ))}
        <div
          key={`${item.kind}-${item.iddId}`}
          className={cardClass}
          data-idd-card
          style={{ position: "relative", height: "100%" }}
        >
          <div style={{ height: "100%", opacity: recording ? 0.6 : 1, pointerEvents: recording ? "none" : undefined, transition: "opacity var(--idd-fast) var(--idd-ease)" }}>
            <CardFrame value>
              <InboxCard
                item={item}
                onDecide={onDecide}
                onAsk={onAsk ? () => onAsk(item) : undefined}
                compact={compact}
              />
            </CardFrame>
          </div>
          {recording ? (
            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, overflow: "hidden", borderRadius: 6 }}>
              <span className="idd-recording" style={{ position: "absolute", top: 0, height: 2, background: "var(--accent)" }} />
            </span>
          ) : null}
          {failedHere ? (
            <div
              className="idd-failed"
              role="alert"
              style={{
                position: "absolute", left: 20, right: 20, bottom: 12,
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 12px", borderRadius: 5,
                background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
                fontSize: FS.sm, color: "var(--text)",
              }}
            >
              <Icon name="warn" size={14} color="var(--text)" weight={1.5} />
              記録できませんでした — {failedHere}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flexShrink: 0 }}>
        <Flip icon="up" label="前の札" disabled={locked || at === 0} onClick={() => move(-1)} />
        <Flip icon="down" label="後で見る" disabled={locked || at >= last} onClick={() => move(1)} />
      </div>
    </div>
  );
}
