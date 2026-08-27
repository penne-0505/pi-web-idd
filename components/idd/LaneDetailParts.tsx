"use client";

// intent: DEC-632 — lane detail の小部品。Inbox の card と同じ語彙を使う

import type { ReactNode } from "react";
import type { CriterionState } from "@/lib/idd-ui/types";
import { CriterionMark } from "./primitives";
import { FS } from "@/lib/idd-ui/scale";

export function SectionHead({ label, right, icon }: { label: string; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {icon}
      <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

export function IdList({ label, right, items }: {
  label: string;
  right?: ReactNode;
  items: { id: string; text: string; state?: CriterionState }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHead label={label} right={right} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it) => {
          const done = it.state === "done";
          const active = it.state === "doing";
          return (
            <div
              key={it.id}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 8px", borderRadius: 3,
                background: active ? "var(--bg-panel)" : "transparent",
              }}
            >
              {it.state ? <CriterionMark state={it.state} /> : null}
              <span style={{ width: 34, flexShrink: 0, fontSize: FS.xs, color: done ? "var(--text-dim)" : "var(--text-muted)" }}>{it.id}</span>
              <span style={{ flex: 1, fontSize: FS.md, fontWeight: active ? 600 : 400, color: done ? "var(--text-dim)" : "var(--text)" }}>{it.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
