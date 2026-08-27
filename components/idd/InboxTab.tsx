"use client";

// intent: Inbox タブの中身。いまは fixture で駆動し、slice 5 で API に差し替える。
// 判断は 1 押下 = 1 件の記録なので、記録が成功するまで queue から消さない (楽観更新しない)。

import { useCallback, useEffect, useState } from "react";
import { useIddState } from "@/hooks/useIddState";
import type { InboxItem } from "@/lib/idd-ui/types";
import { InboxPanel } from "./InboxPanel";
import type { DecideHandler } from "./cards";
import { FS, SIZE } from "@/lib/idd-ui/scale";

export function InboxTab({ compact, onCountChange, onOpenLane }: {
  compact?: boolean;
  onCountChange?: (n: number) => void;
  onOpenLane?: (iddId: string) => void;
}) {
  const state = useIddState();
  const [items, setItems] = useState<InboxItem[]>(state.items);
  // 記録できたかどうかは札ごとの状態。押した場所の近くで返す
  const [pending, setPending] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    setItems(state.items);
    onCountChange?.(state.items.length);
  }, [state.items, onCountChange]);

  const decide: DecideHandler = useCallback(async (action, payload) => {
    const target = String(payload?.iddId ?? payload?.reviewId ?? "");
    setFailed(null);
    setPending(target);
    try {
      const res = await fetch("/api/idd/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        // 記録できていない。card は queue に残したまま、押した状態にもしない
        setPending(null);
        setFailed({ id: target, message: data?.error ?? `HTTP ${res.status}` });
        return;
      }
      // 記録できてから抜けていく。抜ける間だけ list に残す
      setPending(null);
      setDecided(target);
      window.setTimeout(() => {
        setDecided(null);
        setItems((prev) => {
          const next = prev.filter((i) => i.iddId !== target);
          onCountChange?.(next.length);
          return next;
        });
        state.refresh();
      }, 180);
    } catch (e) {
      setPending(null);
      setFailed({ id: target, message: String(e) });
    }
  }, [onCountChange, state]);

  return (
    <div
      data-idd-pending={pending ?? undefined}
      style={{
        height: "100%", overflowY: "auto", background: "var(--bg)",
        // 縦にも中央へ。margin:auto を使うので、画面より高いときも上が切れない
        display: "flex", flexDirection: "column",
      }}
    >
      <InboxPanel
        cron={state.cron}
        items={items}
        onDecide={decide}
        onAsk={(item) => onOpenLane?.(item.iddId)}
        compact={compact}
        pendingId={pending}
        decidedId={decided}
        failure={failed}
        runningSummary="実装中 2 · 下調べ中 1 · 次の取り込みは明朝 5:30"
      />
    </div>
  );
}
