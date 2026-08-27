"use client";

// intent: DEC-624 — 情報ブロックは card 側の 1 本のスクロールに乗る (入れ子にしない)
// intent: DEC-625 — 主題は識別に属する
// intent: DEC-629 — 重複確認は「関係」を形で示す

import { useContext, useState } from "react";
import type { ReactNode } from "react";
import type { CriterionState, DiffLine, SourceRef, StateFact } from "@/lib/idd-ui/types";
import { CardFrame, Chip, CriterionMark, Icon, IconButton, RefChip, StageBar } from "../primitives";
import { FS } from "@/lib/idd-ui/scale";

export function Identity({ phase, chips, iddId, stage, subject, subjectWeak, refs }: {
  phase: string;
  chips?: string[];
  iddId: string;
  stage?: { done: number; current: number | null };
  subject?: string;
  subjectWeak?: boolean;
  refs?: SourceRef[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Chip label={phase} strong />
        {chips?.map((c) => <Chip key={c} label={c} />)}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{iddId}</span>
        {stage ? <StageBar done={stage.done} current={stage.current} /> : null}
      </div>
      {subject ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, fontSize: subjectWeak ? 11 : 13, fontWeight: subjectWeak ? 400 : 600, color: subjectWeak ? "var(--text-muted)" : "var(--text)" }}>
            {subject}
          </span>
          {refs?.map((r) => <RefChip key={r.label} source={r} />)}
        </div>
      ) : null}
    </div>
  );
}

export function InfoBlocks({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>;
}

export function Actions({ children, compact }: { children: ReactNode; compact?: boolean }) {
  const framed = useContext(CardFrame);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        gap: compact ? 12 : 16,
        marginTop: framed ? 0 : 8,
        flexWrap: compact ? "nowrap" : "wrap",
      }}
    >
      {children}
    </div>
  );
}
Actions.__hud = true;

Identity.__head = true;

export function Subject({ text }: { text: string }) {
  return <span style={{ fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>{text}</span>;
}
Subject.__head = true;

function commonSpans(a: string, b: string): [number, number][] {
  const spans: [number, number][] = [];
  const walk = (as: number, ae: number, bs: number, be: number) => {
    if (ae - as < 2 || be - bs < 2) return;
    let best = { ai: -1, bi: -1, len: 0 };
    for (let i = as; i < ae; i++) {
      for (let j = bs; j < be; j++) {
        let k = 0;
        while (i + k < ae && j + k < be && a[i + k] === b[j + k]) k++;
        if (k > best.len) best = { ai: i, bi: j, len: k };
      }
    }
    if (best.len < 2) return;
    spans.push([best.ai, best.ai + best.len]);
    walk(as, best.ai, bs, best.bi);
    walk(best.ai + best.len, ae, best.bi + best.len, be);
  };
  walk(0, a.length, 0, b.length);
  return spans.sort((x, y) => x[0] - y[0]);
}

function Marked({ text, against }: { text: string; against?: string }) {
  if (!against) return <>{text}</>;
  const spans = commonSpans(text, against);
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach(([from, to], i) => {
    if (from > at) out.push(<span key={`p${i}`}>{text.slice(at, from)}</span>);
    out.push(
      <span key={`m${i}`} style={{ borderBottom: "2px solid var(--border-strong)", paddingBottom: 1 }}>
        {text.slice(from, to)}
      </span>,
    );
    at = to;
  });
  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);
  return <>{out}</>;
}

export function Comparison({ rows, mark }: {
  rows: { label: string; title: string; ref: SourceRef; muted?: boolean }[];
  mark?: boolean;
}) {
  const other = (i: number) => (mark && rows.length === 2 ? rows[1 - i].title : undefined);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((r, i) => (
        <div
          key={r.label}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 10px", borderRadius: 4,
            background: r.muted ? "var(--bg-panel)" : "var(--bg)",
            border: "1px solid var(--border)",
          }}
        >
          <span style={{ width: 46, flexShrink: 0, fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>{r.label}</span>
          <span style={{ flex: 1, fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>
            <Marked text={r.title} against={other(i)} />
          </span>
          <RefChip source={r.ref} />
        </div>
      ))}
    </div>
  );
}

export function DuplicatePair({ incoming, existing, similarity }: {
  incoming: { title: string; ref: SourceRef };
  existing: { title: string; ref: SourceRef; stage?: { done: number; current: number | null } };
  similarity: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 12px", borderRadius: 5,
          background: "var(--bg)", border: "1px dashed var(--border-strong)",
        }}
      >
        <span style={{ flex: 1, fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>
          <Marked text={incoming.title} against={existing.title} />
        </span>
        <RefChip source={incoming.ref} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 12px", height: 34 }}>
        <span style={{ position: "relative", width: 22, height: "100%", flexShrink: 0 }} aria-hidden>
          <span style={{ position: "absolute", left: 10.5, top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
          <span style={{ position: "absolute", left: 3, top: "50%", marginTop: -8, background: "var(--bg)", padding: "1px 0" }}>
            <Icon name="merge" size={16} color="var(--text-muted)" weight={1.4} />
          </span>
        </span>
        <Meter value={similarity} label={`${Math.round(similarity * 100)}% 意味が近い`} width={96} />
      </div>

      <div
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 12px", borderRadius: 5,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
        }}
      >
        <span style={{ flex: 1, fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>
          <Marked text={existing.title} against={incoming.title} />
        </span>
        {existing.stage ? <StageBar done={existing.stage.done} current={existing.stage.current} /> : null}
        <RefChip source={existing.ref} />
      </div>
    </div>
  );
}

// intent: DEC-630 — 根拠は文章ではなく共通する具体物の列で出す (自由文は ⓘ へ)

export function SharedItems({ items, hint }: { items: string[]; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>共通</span>
      {items.map((it) => (
        <span
          key={it}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "4px 10px", borderRadius: 4,
            background: "var(--bg-panel)", border: "1px solid var(--border)",
            fontSize: FS.sm, color: "var(--text)",
          }}
        >
          {it}
        </span>
      ))}
      {hint ? <span title={hint} style={{ fontSize: FS.sm, color: "var(--text-dim)", cursor: "help" }}>ⓘ</span> : null}
    </div>
  );
}

export function Meter({ value, label, width = 110 }: { value: number; label: string; width?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width, height: 7, borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
        <span style={{ display: "block", width: `${Math.round(value * 100)}%`, height: "100%", background: "var(--accent)" }} />
      </span>
      <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

// intent: DEC-674 — 契約が空の GO は判断材料が無い。空欄ではなく、どこが空かを示して GO を止める
export function MissingContract({ path }: { path: string }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", borderRadius: 5,
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
      }}
    >
      <Icon name="warn" size={15} color="var(--text)" weight={1.5} />
      <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: FS.md, fontWeight: 600, color: "var(--text)" }}>下調べの成果物が無い</span>
        <span style={{ fontSize: FS.sm, color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}>{path}</span>
      </span>
    </div>
  );
}

export function FactTable({ facts }: { facts: StateFact[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {facts.map((f) => (
        <div key={f.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 76, flexShrink: 0, fontSize: FS.sm, color: "var(--text-muted)" }}>{f.label}</span>
          <span style={{ fontSize: FS.md, fontWeight: 600, color: "var(--text)" }}>{f.value}</span>
          <span style={{ flex: 1 }} />
          {f.ref ? <RefChip source={f.ref} /> : null}
        </div>
      ))}
    </div>
  );
}

export function CollapsedFacts({ count, primary, facts }: {
  count: number;
  primary?: SourceRef;
  facts?: StateFact[];
}) {
  const [open, setOpen] = useState(false);
  const openable = Boolean(facts?.length);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignSelf: "flex-start", maxWidth: "100%" }}>
      <button
        onClick={openable ? () => setOpen((v) => !v) : undefined}
        className={openable ? "idd-btn idd-btn-quiet" : undefined}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start",
          padding: "6px 10px", borderRadius: 4,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          cursor: openable ? "pointer" : "default",
        }}
      >
        <span style={{ fontSize: FS.xs, color: "var(--text-muted)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>現状</span>
        <span style={{ fontSize: FS.sm, color: "var(--text-muted)" }}>{count}</span>
        {primary ? <RefChip source={primary} /> : null}
      </button>
      {open && facts?.length ? <FactTable facts={facts} /> : null}
    </div>
  );
}

export function IdList({ label, right, items }: {
  label: string;
  right?: ReactNode;
  items: { id: string; text: string; state?: CriterionState }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it) => {
          const done = it.state === "done";
          const open = it.state && it.state !== "done";
          return (
            <div
              key={it.id}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 8px", borderRadius: 3,
                background: open ? "var(--bg-panel)" : "transparent",
              }}
            >
              {it.state ? <CriterionMark state={it.state} /> : null}
              <span style={{ width: 34, flexShrink: 0, fontSize: FS.xs, color: done ? "var(--text-dim)" : "var(--text-muted)" }}>{it.id}</span>
              <span style={{ flex: 1, fontSize: FS.md, fontWeight: open ? 600 : 400, color: done ? "var(--text-dim)" : "var(--text)" }}>{it.text}</span>
              {open ? (
                <span style={{ padding: "1px 5px", borderRadius: 2, border: "1px solid var(--text-muted)", background: "var(--bg)", fontSize: FS.xxs, fontWeight: 600, color: "var(--text)" }}>
                  未確認
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// intent: DEC-626 — 自前の枠を持つブロックは自分の器を持ち、card のスクロールで切られない

const DIFF_MAX_HEIGHT = 220;

export function DiffView({ file, fileIndex, fileTotal, before, after, unified, onOpenAll, onStep }: {
  file: string;
  fileIndex: number;
  fileTotal: number;
  before: DiffLine[];
  after: DiffLine[];
  unified?: boolean;
  onOpenAll?: () => void;
  onStep?: (delta: number) => void;
}) {
  const row = (l: DiffLine, key: string) => (
    <div
      key={key}
      style={{
        display: "flex", alignItems: "flex-start", gap: 8,
        padding: "3px 8px",
        background: l.marker ? "var(--bg-panel)" : "var(--bg)",
      }}
    >
      {l.lineNo ? <span style={{ width: 16, flexShrink: 0, fontSize: FS.xxs, color: "var(--text-dim)" }}>{l.lineNo}</span> : null}
      <span style={{ width: 8, flexShrink: 0, fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>{l.marker ?? " "}</span>
      <span style={{ flex: 1, fontSize: FS.xs, color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}>{l.code}</span>
    </div>
  );
  const pane = (label: string, lines: DiffLine[], bordered: boolean) => (
    <div style={{ flex: 1, minWidth: 0, borderLeft: bordered ? "1px solid var(--border)" : undefined }}>
      <div style={{ position: "sticky", top: 0, zIndex: 1, padding: "5px 8px", background: "var(--bg-hover)", fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>{label}</div>
      {lines.map((l, i) => row(l, `${label}-${i}`))}
    </div>
  );
  return (
    <div style={{ flexShrink: 0, borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
        <Icon name="diff" size={13} color="var(--text-muted)" />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>{file}</span>
        <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{fileIndex} / {fileTotal}</span>
        {onStep ? (
          <span style={{ display: "flex", gap: 4 }}>
            <IconButton icon="up" title="前のファイル" size={26} onClick={() => onStep(-1)} />
            <IconButton icon="down" title="次のファイル" size={26} onClick={() => onStep(1)} />
          </span>
        ) : null}
      </div>
      <div style={{ maxHeight: DIFF_MAX_HEIGHT, overflowY: "auto" }}>
        {unified ? (
          <div>
            {[...before.filter((l) => l.marker === "-"), ...after].map((l, i) => row(l, `u-${i}`))}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-start" }}>
            {pane("現在 (upstream)", before, false)}
            {pane("この lane", after, true)}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 10px", borderTop: "1px solid var(--border)" }}>
        <button
          onClick={onOpenAll}
          className="idd-link" style={{ background: "none", border: "none", padding: 0, fontSize: FS.xs, color: "var(--text-muted)", cursor: onOpenAll ? "pointer" : "default" }}
        >
          全差分をタブで開く ↗
        </button>
      </div>
    </div>
  );
}
