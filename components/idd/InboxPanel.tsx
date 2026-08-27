"use client";

// intent: DEC-620 — 種類を問わず 1 本の待ち行列にする
// intent: DEC-635 — 取り込みの結果は判断ではないので見出し行の端へ逃がす
// intent: DEC-634 — mobile では器を持たず素直に流す (variant の分岐)

import { useState } from "react";
import type { CronRun, InboxItem, UndeliveredCount } from "@/lib/idd-ui/types";
import { Icon } from "./primitives";
import { type DecideHandler } from "./cards";
import { InboxDeck } from "./InboxDeck";
import { FS, SIZE } from "@/lib/idd-ui/scale";

function CronStatus({ run, open, onToggle }: { run: CronRun; open: boolean; onToggle: () => void }) {
  const failed = run.failures.length > 0;
  return (
    <button
      onClick={onToggle}
      className="idd-btn idd-btn-quiet"
      title={`${run.startedAt} → ${run.finishedAt} の取り込み`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        minHeight: 26, padding: "0 8px", borderRadius: 4,
        background: failed ? "var(--bg-panel)" : "transparent",
        border: `1px solid ${failed ? "var(--border-strong)" : "transparent"}`,
        color: failed ? "var(--text)" : "var(--text-dim)",
        fontSize: FS.sm, cursor: "pointer", flexShrink: 0,
      }}
    >
      <Icon
        name={failed ? "warn" : "approve"}
        size={13}
        color={failed ? "var(--text)" : "var(--text-dim)"}
        weight={failed ? 1.5 : 1.2}
      />
      {run.finishedAt}
      {failed ? <span style={{ fontWeight: 600 }}>{run.failures.length}</span> : null}
      <span style={{ color: "var(--text-dim)" }}>{open ? "▴" : "▾"}</span>
    </button>
  );
}

function CronDetail({ run, onOpenLog }: { run: CronRun; onOpenLog?: () => void }) {
  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        padding: "10px 12px", borderRadius: 5,
        background: "var(--bg-panel)", border: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: FS.sm, color: "var(--text-muted)" }}>
          {run.startedAt} → {run.finishedAt}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onOpenLog} className="idd-link" style={{ background: "none", border: "none", padding: 0, fontSize: FS.xs, color: "var(--text-dim)", cursor: "pointer" }}>
          実行ログ ↗
        </button>
      </div>
      {run.failures.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {run.failures.map((f) => (
            <div key={f.iddId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 4, background: "var(--bg)" }}>
              <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>{f.iddId}</span>
              <span style={{ flex: 1, fontSize: FS.sm, color: "var(--text)" }}>{f.reason}</span>
              <span style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid var(--text-muted)", fontSize: FS.sm, color: "var(--text)" }}>再実行</span>
            </div>
          ))}
        </div>
      ) : (
        <span style={{ fontSize: FS.sm, color: "var(--text-dim)" }}>失敗なし</span>
      )}
    </div>
  );
}

// intent: DEC-664 — 判断でない滞留情報は見出し行の端へ逃がす (CronStatus と同じ扱い)
// intent: DEC-667 — 第一弾は押せない件数表示のみ (button にしない)
function UndeliveredStatus({ count }: { count: UndeliveredCount }) {
  const failed = count.failed > 0;
  return (
    <span
      title={failed ? `配送失敗 ${count.failed} 件を含む` : "配送待ちの envelope"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        minHeight: 26, padding: "0 8px", borderRadius: 4,
        background: failed ? "var(--bg-panel)" : "transparent",
        border: `1px solid ${failed ? "var(--border-strong)" : "transparent"}`,
        color: failed ? "var(--text)" : "var(--text-dim)",
        fontSize: FS.sm, flexShrink: 0,
      }}
    >
      {failed ? <Icon name="warn" size={13} color="var(--text)" weight={1.5} /> : null}
      未達 {count.total} 件
      {failed ? <span style={{ fontWeight: 600 }}>(失敗 {count.failed})</span> : null}
    </span>
  );
}

function EmptyQueue({ running }: { running: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "48px 0" }}>
      <span style={{ fontSize: FS.lg, fontWeight: 600, color: "var(--text-muted)" }}>判断待ちはありません</span>
      <span style={{ fontSize: FS.sm, color: "var(--text-dim)" }}>{running}</span>
    </div>
  );
}

export function InboxPanel({ cron, items, onDecide, onAsk, compact, runningSummary, pendingId, decidedId, failure, undelivered }: {
  cron: CronRun;
  undelivered?: UndeliveredCount;
  items: InboxItem[];
  onDecide: DecideHandler;
  onAsk?: (item: InboxItem) => void;
  compact?: boolean;
  runningSummary?: string;
  pendingId?: string | null;
  decidedId?: string | null;
  failure?: { id: string; message: string } | null;
}) {
  const [openCron, setOpenCron] = useState(cron.failures.length > 0);

  return (
    <div
      className="idd"
      style={{
        display: "flex", flexDirection: "column", gap: 24,
        padding: compact ? 14 : 24,
        width: "100%", maxWidth: SIZE.readWidth, margin: "auto", boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: FS.xl, fontWeight: 600, color: "var(--text)" }}>判断キュー</span>
        <span style={{ flex: 1 }} />
        {undelivered && undelivered.total > 0 ? <UndeliveredStatus count={undelivered} /> : null}
        <CronStatus run={cron} open={openCron} onToggle={() => setOpenCron((v) => !v)} />
      </div>

      {openCron ? <CronDetail run={cron} /> : null}

      {items.length === 0
        ? <EmptyQueue running={runningSummary ?? "稼働中の lane はありません"} />
        : (
          <InboxDeck
            items={items}
            onDecide={onDecide}
            onAsk={onAsk}
            compact={compact}
            pendingId={pendingId}
            decidedId={decidedId}
            failure={failure}
            variant={compact ? "flow" : "frame"}
          />
        )}
    </div>
  );
}
