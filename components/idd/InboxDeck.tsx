"use client";

// intent: 1 画面 = 1 判断。判断キューを一覧ではなく重ねた札として持ち、いま処理してほしい 1 件だけを前面に置く。
// 軸は縦で統一する — 残りは下に積まれ、下へめくると次が来る。器の高さは札の中身に依らず固定し、
// めくっても枠と操作の位置が動かないようにする (動くのは中身だけ)。

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

/** 札の見出し。tip にしか使わないので、種類ごとの主題を一つ取り出せれば足りる。 */
function itemLabel(item: InboxItem): string {
  switch (item.kind) {
    case "duplicate": return item.incoming.title;
    case "question": return item.question;
    case "review": return item.target.title;
    default: return item.title;
  }
}

/* 前面から離れるほど小さくなる。減衰なので下限へ漸近し、遠い札どうしの差は潰れる
   — 「あと何枚か」ではなく「近いか遠いか」だけが読める大きさにする。 */
const MARKER_MAX = 40;
const MARKER_MIN = 20;
const MARKER_DECAY = 0.55;
const MARKER_ICON = 22;

/** 残りの札。上から下が処理順で、札束の積み方向と同じ縦に並べる。 */
function Remaining({ items, index, onJump, row }: {
  items: InboxItem[];
  index: number;
  onJump: (i: number) => void;
  row?: boolean;
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
            title={itemLabel(item)}
            aria-current={on || undefined}
            className="idd-marker"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: box, height: box, padding: 0,
              background: "transparent", border: "none",
              color: on ? "var(--text)" : d === 1 ? "var(--text-muted)" : "var(--text-dim)",
              cursor: "pointer", flexShrink: 0,
            }}
          >
            {/* 寸法ではなく倍率で変える。大きさの変化がそのまま動きになる */}
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

/** めくる操作。上が前、下が次 — 札束の積み方向にそのまま重ねる。 */
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

/** 器の高さ。画面には追従するが、札の中身では変わらない。
    下限 360 は「識別 + 操作 + 情報が最低限」入る前提 (mobile は器を持たない)。 */
const FRAME_HEIGHT = "clamp(400px, 60vh, 700px)";

/** 無地の部分を送るときの閾値。1 回の弾みで 1 枚だけ動かす。 */
const WHEEL_THRESHOLD = 90;

export function InboxDeck({ items, onDecide, onAsk, compact, variant = "frame", pendingId, decidedId, failure }: {
  items: InboxItem[];
  onDecide: DecideHandler;
  onAsk?: (item: InboxItem) => void;
  compact?: boolean;
  /** 記録中 / 記録できて抜けていく最中 / 記録できなかった札 */
  pendingId?: string | null;
  decidedId?: string | null;
  failure?: { id: string; message: string } | null;
  /** frame = 器の高さ固定・縦軸 (今) / flow = 中身なりの高さ・横軸 (前) */
  variant?: "frame" | "flow";
}) {
  const [index, setIndex] = useState(0);
  // 入ってくる向きは、直前の操作が「次」か「戻る」かで決まる
  const [dir, setDir] = useState<"next" | "prev">("next");

  // 判断が済んだ札は list から消える。末尾を処理した直後は 1 枚戻る
  const last = Math.max(0, items.length - 1);
  const at = Math.min(index, last);
  useEffect(() => { if (index > last) setIndex(last); }, [index, last]);

  const move = useCallback((d: number) => {
    setDir(d < 0 ? "prev" : "next");
    setIndex((i) => Math.min(Math.max(0, Math.min(i, last) + d), last));
  }, [last]);

  const jump = useCallback((i: number) => {
    setIndex((prev) => { setDir(i < prev ? "prev" : "next"); return i; });
  }, []);

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

  // 無地の部分でのスクロールは「めくる」。札の中は札自身のスクロールなので触らない
  const wheelRef = useRef({ acc: 0, at: 0 });
  useEffect(() => {
    if (variant !== "frame") return;
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
        <Remaining items={items} index={at} onJump={jump} row />
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
          <Flip icon="prev" label="前の札" showLabel disabled={at === 0} onClick={() => move(-1)} />
          <span style={{ flex: 1 }} />
          <Flip icon="next" label="後で見る" showLabel disabled={at >= last} onClick={() => move(1)} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
      <Remaining items={items} index={at} onJump={jump} />

      <div style={{ flex: 1, minWidth: 0, position: "relative", height: FRAME_HEIGHT, paddingBottom: behind * 8 }}>
        {/* 背後の札。次は下で待っていて、↓ で手前に来る */}
        {Array.from({ length: behind }, (_, i) => behind - i).map((n) => (
          <div
            key={n}
            aria-hidden
            className="idd-behind"
            style={{
              // 下端だけが覗く紙束。左右は前面の角丸の内側へ入れる
              // (縁を揃えると、前面の丸角の外側の隙間から背面の角が三角に覗いてしまう)
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
          {/* 記録中。待たされていることを縁を走る線だけで示す */}
          {recording ? (
            <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: 2, overflow: "hidden", borderRadius: 6 }}>
              <span className="idd-recording" style={{ position: "absolute", top: 0, height: 2, background: "var(--accent)" }} />
            </span>
          ) : null}
          {/* 記録できなかったとき。押した場所の近くで申告し、札は queue に残す */}
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
        <Flip icon="up" label="前の札" disabled={at === 0} onClick={() => move(-1)} />
        <Flip icon="down" label="後で見る" disabled={at >= last} onClick={() => move(1)} />
      </div>
    </div>
  );
}
