"use client";

// intent: DEC-638 — 状態は語ではなく形と濃度で示す
// intent: DEC-637 — 固定ラベルの操作はアイコン付きボタン、主と対は同寸
// intent: DEC-636 — 選択は枠の濃度のみ。地は hover が使う channel
// intent: DEC-624 — 器つきの card は上 (識別+主題) / 中 (流れる) / 下 (操作) の 3 面

import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { CriterionState, SourceRef } from "@/lib/idd-ui/types";
import { FS } from "@/lib/idd-ui/scale";

export const ICON_PATHS = {
  merge: "M 3 2 L 3 6 C 3 9 6 10 8 10 M 13 2 L 13 6 C 13 9 10 10 8 10 M 8 10 L 8 14",
  branch: "M 8 2 L 8 6 M 8 6 C 8 9 5 10 3 10 L 3 14 M 8 6 C 8 9 11 10 13 10 L 13 14",
  discard: "M 3 4.5 L 13 4.5 M 6 4.5 L 6 2.5 L 10 2.5 L 10 4.5 M 4.5 4.5 L 5.2 13.5 L 10.8 13.5 L 11.5 4.5",
  go: "M 2.5 8 L 12 8 M 8.5 4.5 L 12 8 L 8.5 11.5",
  abort: "M 4 4 L 12 12 M 12 4 L 4 12",
  approve: "M 3 8.5 L 6.5 12 L 13 4",
  back: "M 4.5 5 L 12 5 C 13.1 5 14 5.9 14 7 L 14 9.5 C 14 10.6 13.1 11.5 12 11.5 L 3 11.5 M 7.5 2 L 4.5 5 L 7.5 8",
  backDeep: "M 4.5 5 L 12 5 C 13.1 5 14 5.9 14 7 L 14 9.5 C 14 10.6 13.1 11.5 12 11.5 L 3 11.5 M 7.5 2 L 4.5 5 L 7.5 8 M 11 2 L 8 5 L 11 8",
  diff: "M 2.5 4.5 L 6.5 4.5 M 2.5 8 L 5.5 8 M 2.5 11.5 L 7 11.5 M 9.5 4.5 L 13.5 4.5 M 9.5 8 L 13.5 8 M 9.5 11.5 L 11.5 11.5",
  chat: "M 2 4 C 2 2.9 2.9 2 4 2 L 12 2 C 13.1 2 14 2.9 14 4 L 14 9 C 14 10.1 13.1 11 12 11 L 7 11 L 4 14 L 4 11 C 2.9 11 2 10.1 2 9 Z",
  link: "M 6 9.5 C 4.5 8 4.5 6.5 6 5 L 8 3 C 9.5 1.5 11.5 1.5 13 3 C 14.5 4.5 14.5 6.5 13 8 L 12 9 M 10 6.5 C 11.5 8 11.5 9.5 10 11 L 8 13 C 6.5 14.5 4.5 14.5 3 13 C 1.5 11.5 1.5 9.5 3 8 L 4 7",
  up: "M 8 3 L 8 13 M 4 7 L 8 3 L 12 7",
  down: "M 8 13 L 8 3 M 4 9 L 8 13 L 12 9",
  prev: "M 13 8 L 3 8 M 7 4 L 3 8 L 7 12",
  next: "M 3 8 L 13 8 M 9 4 L 13 8 L 9 12",
  intake: "M 8 2 L 8 10 M 4.5 6.5 L 8 10 L 11.5 6.5 M 3 13 L 13 13",
  warn: "M 8 2 L 14.5 13.5 L 1.5 13.5 Z M 8 6.5 L 8 9.5 M 8 11.4 L 8 11.5",
  branchName: "M 4 3 L 4 13 M 4 6 C 4 6 8 6 10 6 M 10 6 L 10 3 M 10 6 L 10 9",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 16, color = "var(--text)", weight = 1.3 }: {
  name: IconName;
  size?: number;
  color?: string;
  weight?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path d={ICON_PATHS[name]} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Chip({ label, strong, title }: { label: string; strong?: boolean; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 6px", borderRadius: 3, flexShrink: 0,
        background: strong ? "var(--accent)" : "var(--bg)",
        border: `1px solid ${strong ? "var(--accent)" : "var(--border)"}`,
        color: strong ? "#fff" : "var(--text-muted)",
        fontSize: FS.xs, fontWeight: strong ? 600 : 400, whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export function RefChip({ source, onOpen }: { source: SourceRef; onOpen?: (s: SourceRef) => void }) {
  return (
    <button
      onClick={onOpen ? () => onOpen(source) : undefined}
      title={source.url}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        padding: "2px 6px", borderRadius: 3, flexShrink: 0,
        background: "var(--bg)", border: "1px solid var(--text-muted)",
        color: "var(--text)", fontSize: FS.xs,
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      {source.label}
      <span style={{ color: "var(--text-dim)", fontSize: FS.xxs }}>↗</span>
    </button>
  );
}

export function KeyChip({ n }: { n: number | string }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        minWidth: 16, padding: "1px 5px", borderRadius: 3, flexShrink: 0,
        background: "var(--bg)", border: "1px solid var(--border)",
        color: "var(--text-dim)", fontSize: FS.xs,
      }}
    >
      {n}
    </span>
  );
}

export function RequiredChip({ required }: { required?: boolean }) {
  return (
    <span
      style={{
        padding: "1px 5px", borderRadius: 2, flexShrink: 0,
        background: required ? "var(--accent)" : "var(--bg)",
        border: `1px solid ${required ? "var(--accent)" : "var(--border)"}`,
        color: required ? "#fff" : "var(--text-muted)",
        fontSize: FS.xxs, fontWeight: required ? 600 : 400,
      }}
    >
      {required ? "必須" : "任意"}
    </span>
  );
}

export function StageBar({ done, current, halted, faded }: {
  done: number;
  current?: number | null;
  halted?: boolean;
  faded?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 2, flexShrink: 0 }} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => {
        const isDone = i < done;
        const isCurrent = current === i;
        const style: CSSProperties = {
          width: 9, height: 4, borderRadius: 1,
          border: "1px solid var(--border)",
          background: isDone ? (faded ? "var(--text-dim)" : "var(--accent)") : isCurrent && !halted ? "var(--text-muted)" : "var(--bg)",
        };
        if (isCurrent && halted) {
          style.background = "transparent";
          style.borderStyle = "dashed";
          style.borderColor = "var(--text-muted)";
        }
        return <span key={i} style={style} />;
      })}
    </span>
  );
}

export function CriterionMark({ state }: { state: CriterionState }) {
  if (state === "done") return <Icon name="approve" size={12} color="var(--text-dim)" />;
  if (state === "doing") {
    return (
      <span style={{ position: "relative", width: 12, height: 12, flexShrink: 0 }} aria-hidden>
        <span style={{ position: "absolute", inset: 1, borderRadius: "50%", border: "1.3px solid var(--text)" }} />
        <span style={{ position: "absolute", inset: 3.5, borderRadius: "50%", background: "var(--text)" }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: 10, height: 10, margin: 1, borderRadius: "50%", border: "1.3px solid var(--border)", flexShrink: 0 }}
    />
  );
}

export function LiveDot() {
  return <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />;
}

export type ButtonVariant = "primary" | "secondary" | "quiet";

export function ActionButton({ icon, label, variant = "secondary", disabled, minWidth, fullWidth, onClick }: {
  icon?: IconName;
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  minWidth?: number;
  fullWidth?: boolean;
  onClick?: () => void;
}) {
  const primary = variant === "primary";
  const quiet = variant === "quiet";
  const fg = disabled ? "#fff" : primary ? "#fff" : "var(--text)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`idd-btn idd-btn-${variant}`}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        minWidth, width: fullWidth ? "100%" : undefined, flex: fullWidth ? 1 : undefined,
        minHeight: quiet ? 40 : 44,
        padding: quiet ? "8px 12px" : "11px 18px",
        borderRadius: 6,
        background: disabled ? "var(--text-dim)" : primary ? "var(--accent)" : "var(--bg)",
        border: `1px solid ${disabled ? "var(--text-dim)" : primary ? "var(--accent)" : "var(--border)"}`,
        color: fg,
        fontSize: quiet ? FS.sm : FS.md,
        fontWeight: primary ? 600 : 400,
        cursor: disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {icon ? <Icon name={icon} size={quiet ? 14 : 18} color={fg} weight={primary ? 1.4 : 1.3} /> : null}
      {label}
    </button>
  );
}

// intent: DEC-628 — undo を持たない代わりの緩衝材。popup にせず操作面をその場で差し替える

export function ConfirmGate({ trigger, consequences, confirmLabel, onConfirm, compact, children }: {
  trigger: { icon?: IconName; label: string; variant?: ButtonVariant; minWidth?: number; iconOnly?: boolean; size?: number };
  consequences: string[];
  confirmLabel?: string;
  onConfirm: () => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!armed) return;
    box.current?.querySelector("button")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  if (!armed) {
    return (
      <>
        {trigger.iconOnly && trigger.icon ? (
          <IconButton icon={trigger.icon} title={trigger.label} size={trigger.size} tone="var(--text-muted)" onClick={() => setArmed(true)} />
        ) : (
          <ActionButton
            icon={trigger.icon}
            label={trigger.label}
            variant={trigger.variant ?? "primary"}
            minWidth={trigger.minWidth}
            fullWidth={compact}
            onClick={() => setArmed(true)}
          />
        )}
        {children}
      </>
    );
  }

  return (
    <div
      ref={box}
      className="idd-enter-next"
      style={{
        display: "flex", alignItems: "center", gap: 12, width: "100%",
        flexDirection: compact ? "column" : "row", alignSelf: "stretch",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: 1 }}>
        <Icon name="up" size={13} color="var(--text-muted)" />
        {consequences.map((c) => (
          <span
            key={c}
            style={{
              padding: "4px 10px", borderRadius: 4,
              background: "var(--bg-panel)", border: "1px solid var(--border)",
              fontSize: FS.sm, color: "var(--text)", whiteSpace: "nowrap",
            }}
          >
            {c}
          </span>
        ))}
      </span>
      <span style={{ display: "flex", gap: 10, width: compact ? "100%" : undefined }}>
        <ActionButton
          icon={trigger.icon}
          label={confirmLabel ?? trigger.label}
          variant="primary"
          minWidth={trigger.minWidth}
          fullWidth={compact}
          onClick={() => { setArmed(false); onConfirm(); }}
        />
        <ActionButton label="やめる" variant="quiet" minWidth={88} fullWidth={compact} onClick={() => setArmed(false)} />
      </span>
    </div>
  );
}

export function IconButton({ icon, title, onClick, tone = "var(--text)", size = 34 }: {
  icon: IconName;
  title: string;
  onClick?: () => void;
  tone?: string;
  size?: number;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="idd-btn idd-btn-secondary"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, padding: 0, borderRadius: 4,
        background: "var(--bg)", border: "1px solid var(--border)",
        cursor: "pointer", flexShrink: 0,
      }}
    >
      <Icon name={icon} size={16} color={tone} />
    </button>
  );
}

export function SegmentedPair({ items, fullWidth }: {
  items: { icon: IconName; label: string; onClick?: () => void }[];
  fullWidth?: boolean;
}) {
  return (
    <div style={{ display: fullWidth ? "flex" : "inline-flex", width: fullWidth ? "100%" : undefined, borderRadius: 6, border: "1px solid var(--border)", overflow: "hidden", background: "var(--bg)" }}>
      {items.map((it, i) => (
        <button
          key={it.label}
          onClick={it.onClick}
          className="idd-btn idd-btn-seg"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
            flex: fullWidth ? 1 : undefined,
            minHeight: 44, padding: "10px 16px",
            background: "var(--bg)", border: "none",
            borderLeft: i > 0 ? "1px solid var(--border)" : "none",
            color: "var(--text)", fontSize: FS.lg, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          <Icon name={it.icon} size={16} />
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function OptionRow({ label, index, selected, onClick, children }: {
  label: string;
  index?: number | string;
  selected?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className={onClick ? "idd-option" : undefined}
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        padding: children ? "9px 10px 10px 12px" : "0 10px 0 12px",
        minHeight: 44, borderRadius: 4,
        background: "var(--bg)",
        border: `1px solid ${selected ? "var(--border-strong)" : "var(--border)"}`,
        cursor: onClick ? "pointer" : "default",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, fontSize: FS.md, color: "var(--text)" }}>{label}</span>
        {index !== undefined ? <KeyChip n={index} /> : null}
      </div>
      {children}
    </div>
  );
}

export function Field({ label, required, hint, placeholder, rows = 1, value, onChange }: {
  label: string;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  rows?: number;
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
        <RequiredChip required={required} />
        {hint ? <span title={hint} style={{ fontSize: FS.sm, color: "var(--text-dim)", cursor: "help" }}>ⓘ</span> : null}
      </div>
      <textarea
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        style={{
          minHeight: rows > 1 ? 44 : 40, resize: "vertical",
          padding: "8px 10px", borderRadius: 4,
          background: "var(--bg)", border: "1px solid var(--border)",
          color: "var(--text)", fontSize: FS.sm, fontFamily: "inherit",
        }}
      />
    </div>
  );
}

export function SectionLabel({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}

export function Divider({ vertical }: { vertical?: boolean }) {
  return vertical
    ? <span aria-hidden style={{ width: 1, alignSelf: "stretch", background: "var(--bg-hover)" }} />
    : <span aria-hidden style={{ height: 1, width: "100%", background: "var(--border)" }} />;
}

const CARD_PAD = 20;

export const CardFrame = createContext(false);

type Marked = { __head?: boolean; __hud?: boolean };

export function Card({ children }: { children: ReactNode }) {
  const framed = useContext(CardFrame);

  if (!framed) {
    return (
      <div
        style={{
          display: "flex", flexDirection: "column", gap: 16,
          padding: 16, borderRadius: 6,
          background: "var(--bg)", border: "1px solid var(--border)",
        }}
      >
        {children}
      </div>
    );
  }

  const all = Children.toArray(children);
  const mark = (c: unknown, key: keyof Marked) => isValidElement(c) && Boolean((c.type as Marked)?.[key]);
  const head = all.filter((c) => mark(c, "__head"));
  const hud = all.filter((c) => mark(c, "__hud"));
  const body = all.filter((c) => !mark(c, "__head") && !mark(c, "__hud"));

  return (
    <div
      style={{
        height: "100%", boxSizing: "border-box",
        display: "flex", flexDirection: "column",
        borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {head.length ? (
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 12, padding: CARD_PAD }}>
          {head}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, padding: head.length ? `0 ${CARD_PAD}px ${CARD_PAD}px` : CARD_PAD }}>
        {head.length ? (
          <div
            aria-hidden
            style={{
              position: "sticky", top: 0, flexShrink: 0, zIndex: 1,
              height: 12, marginBottom: -12, marginLeft: -CARD_PAD, marginRight: -CARD_PAD,
              background: "linear-gradient(to top, transparent, var(--bg))",
              pointerEvents: "none",
            }}
          />
        ) : null}
        {body}
        <div
          aria-hidden
          style={{
            position: "sticky", bottom: -CARD_PAD, flexShrink: 0,
            height: CARD_PAD + 8, marginTop: "auto",
            marginBottom: -CARD_PAD, marginLeft: -CARD_PAD, marginRight: -CARD_PAD,
            background: "linear-gradient(to bottom, transparent, var(--bg))",
            pointerEvents: "none",
          }}
        />
      </div>
      {hud.length ? (
        <div
          style={{
            flexShrink: 0, padding: `22px ${CARD_PAD}px`,
            background: "var(--bg)",
            borderTop: "1px solid var(--border)",
            boxShadow: "0 -8px 14px -10px rgba(0,0,0,0.35)",
          }}
        >
          {hud}
        </div>
      ) : null}
    </div>
  );
}
