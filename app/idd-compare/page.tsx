"use client";

// intent: 札束の 2 案を並べて見比べるためだけの面。判断は記録しない。比較が終わったら消す。

import { MOCK_INBOX } from "@/lib/idd-ui/fixtures";
import { InboxDeck } from "@/components/idd/InboxDeck";
import { FS } from "@/lib/idd-ui/scale";

const noop = async () => {};

function Column({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: FS.xl, fontWeight: 600, color: "var(--text)" }}>{title}</span>
        <span style={{ fontSize: FS.sm, color: "var(--text-dim)" }}>{note}</span>
      </div>
      {children}
    </div>
  );
}

export default function IddComparePage() {
  return (
    <div style={{ height: "100vh", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 40, padding: 24 }}>
        <Column title="A  中身なり" note="前の案 · 高さは札次第 / 横軸">
          <InboxDeck items={MOCK_INBOX} onDecide={noop} variant="flow" />
        </Column>
        <Column title="B  器を固定" note="今の案 · 高さ固定・操作は底に固定 / 縦軸">
          <InboxDeck items={MOCK_INBOX} onDecide={noop} variant="frame" />
        </Column>
      </div>
    </div>
  );
}
