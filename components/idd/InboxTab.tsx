"use client";

// intent: DEC-627 — 楽観更新しない。記録中 / 成功 / 失敗を札の上で示す

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
  const [pending, setPending] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    setItems(state.items);
  }, [state.items]);

  // intent: DEC-695 — 件数は items から派生させる。更新の途中で親を触らない
  useEffect(() => {
    onCountChange?.(items.length);
  }, [items, onCountChange]);

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
        setPending(null);
        // intent: DEC-627 — 記録できていない札は queue に残す
        setFailed({ id: target, message: data?.error ?? `HTTP ${res.status}` });
        return;
      }
      setPending(null);
      setDecided(target);
      window.setTimeout(() => {
        setDecided(null);
        // intent: DEC-695 — 件数の通知は updater の外。updater は render 中に走りうる
        setItems((prev) => prev.filter((i) => i.iddId !== target));
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
