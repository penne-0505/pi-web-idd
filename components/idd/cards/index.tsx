"use client";

// intent: 判断 card 5 種。Figma `02 morning inbox` の確定形。
// 共通規約: 固定ラベルの操作はアイコン付きボタン / 押したら確定 / 無操作と同じ操作は置かない。

import { useState } from "react";
import type {
  DuplicateItem, GoItem, InboxItem, QuestionItem, ReviewItem, ShipItem,
} from "@/lib/idd-ui/types";
import {
  ActionButton, Card, ConfirmGate, Field, IconButton, OptionRow, SegmentedPair,
} from "../primitives";
import {
  Actions, CollapsedFacts, Comparison, DuplicatePair, FactTable, Identity, IdList, InfoBlocks, DiffView, Meter, SharedItems, Subject,
} from "./parts";
import { FS } from "@/lib/idd-ui/scale";

/** 押下 = 1 判断 = 1 件の記録。payload は 04 の対応表に対応する。 */
export type DecideHandler = (action: string, payload?: Record<string, unknown>) => void;

interface CardProps<T> {
  item: T;
  onDecide: DecideHandler;
  onAsk?: () => void;
  compact?: boolean;
}

/* ── 重複確認 ─────────────────────────────────────────────── */

export function DuplicateCard({ item, onDecide, onAsk, compact }: CardProps<DuplicateItem>) {
  return (
    <Card>
      <Identity phase="重複確認" iddId={item.reviewId} />
      <InfoBlocks>
        <DuplicatePair incoming={item.incoming} existing={item.existing} similarity={item.similarity} />
        {item.shared?.length ? <SharedItems items={item.shared} hint={item.reason} /> : null}
      </InfoBlocks>
      <Actions compact={compact}>
        <SegmentedPair
          fullWidth={compact}
          items={[
            { icon: "merge", label: "まとめる", onClick: () => onDecide("merge", { reviewId: item.reviewId }) },
            { icon: "branch", label: "分ける", onClick: () => onDecide("anyway_go", { reviewId: item.reviewId }) },
          ]}
        />
        <span style={{ flex: compact ? undefined : 1 }} />
        <span style={{ display: "flex", gap: 8, justifyContent: compact ? "flex-end" : undefined }}>
          <ConfirmGate
            trigger={{ icon: "discard", label: "起票を取り消す (Linear / GitHub も閉じる)", iconOnly: true, size: compact ? 44 : 34 }}
            consequences={[item.incoming.ref.label, "起票を閉じる"]}
            confirmLabel="取り消す"
            compact={compact}
            onConfirm={() => onDecide("delete", { reviewId: item.reviewId })}
          >
            <IconButton icon="chat" title="重複の内容を聞く" size={compact ? 44 : 34} onClick={onAsk} />
          </ConfirmGate>
        </span>
      </Actions>
    </Card>
  );
}

/* ── 質問 ─────────────────────────────────────────────────── */

export function QuestionCard({ item, onDecide, compact }: CardProps<QuestionItem>) {
  const [selected, setSelected] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const answered = selected !== null || other.trim().length > 0;

  return (
    <Card>
      <Identity
        phase="質問"
        iddId={item.iddId}
        stage={{ done: 1, current: 1 }}
        subject={item.laneTitle}
        subjectWeak
        refs={item.source ? [item.source] : undefined}
      />
      <Subject text={item.question} />
      <InfoBlocks>
        <CollapsedFacts count={item.facts.length} primary={item.primaryRef} />
      </InfoBlocks>
      <div style={{ display: "flex", flexDirection: "column", gap: compact ? 10 : 6 }}>
        {item.options.map((o) => (
          <OptionRow
            key={o.index}
            label={o.label}
            index={o.index}
            selected={selected === o.index}
            onClick={() => { setSelected(o.index); setOther(""); }}
          />
        ))}
        <OptionRow
          label="その他"
          index={item.options.length + 1}
          selected={other.trim().length > 0}
          onClick={() => setSelected(null)}
        >
          <input
            value={other}
            onChange={(e) => { setOther(e.target.value); setSelected(null); }}
            placeholder="ここに独自の回答を入力してください"
            style={{
              minHeight: 40, padding: "8px 10px", borderRadius: 4,
              background: "var(--bg)", border: "1px solid var(--border)",
              color: "var(--text)", fontSize: FS.sm, fontFamily: "inherit", width: "100%",
            }}
          />
        </OptionRow>
      </div>
      <Field label="理由" hint="任意だが推奨。判断の意図がそのまま DEC に反映される" rows={2} value={reason} onChange={setReason} />
      <Actions compact={compact}>
        <ActionButton
          icon="go"
          label="回答して再開させる"
          variant="primary"
          fullWidth={compact}
          disabled={!answered}
          onClick={() => onDecide("answer", {
            iddId: item.iddId,
            batchId: item.batchId,
            selection: selected !== null ? { index: selected } : { label: "その他" },
            reason: reason || undefined,
            notes: other || undefined,
          })}
        />
      </Actions>
    </Card>
  );
}

/* ── GO 待ち ──────────────────────────────────────────────── */

export function GoCard({ item, onDecide, onAsk, compact }: CardProps<GoItem>) {
  return (
    <Card>
      <Identity
        phase="GO 待ち"
        chips={item.priorityTop ? ["最優先"] : undefined}
        iddId={item.iddId}
        stage={{ done: 2, current: null }}
        subject={item.title}
        refs={item.source ? [item.source] : undefined}
      />
      <InfoBlocks>
        <IdList label="やること (方針)" items={item.decisions.map((d) => ({ id: d.id, text: d.text }))} />
        <IdList label="満たすべき条件" items={item.criteria.map((c) => ({ id: c.id, text: c.text }))} />
      </InfoBlocks>
      <Actions compact={compact}>
        <span style={{ display: "flex", gap: 12, width: compact ? "100%" : undefined }}>
          <ActionButton icon="go" label="GO" variant="primary" minWidth={92} fullWidth={compact} onClick={() => onDecide("s1_go", { iddId: item.iddId })} />
          <ActionButton icon="abort" label="中止" minWidth={92} fullWidth={compact} onClick={() => onDecide("s1_defer", { iddId: item.iddId })} />
        </span>
        <span style={{ flex: compact ? undefined : 1 }} />
        <span style={{ display: "flex", justifyContent: compact ? "flex-end" : undefined }}>
          <IconButton icon="chat" title="下調べの内容を聞く" size={compact ? 44 : 34} onClick={onAsk} />
        </span>
      </Actions>
    </Card>
  );
}

/* ── 差分確認 ─────────────────────────────────────────────── */

export function ReviewCard({ item, onDecide, onAsk, compact }: CardProps<ReviewItem>) {
  const [instruction, setInstruction] = useState("");
  return (
    <Card>
      <Identity
        phase="差分確認"
        chips={item.handoffNote ? [item.handoffNote] : undefined}
        iddId={item.iddId}
        stage={{ done: 3, current: 3 }}
      />
      <InfoBlocks>
        <Comparison
          rows={[
            { label: "対象", title: item.target.title, ref: item.target.ref },
            ...(item.conflictWith ? [{ label: "衝突相手", title: item.conflictWith.title, ref: item.conflictWith.ref, muted: true }] : []),
          ]}
        />
        {item.diff ? (
          <DiffView
            file={item.diff.file}
            fileIndex={item.diff.fileIndex}
            fileTotal={item.diff.fileTotal}
            before={item.diff.before}
            after={item.diff.after}
            unified={compact}
          />
        ) : null}
        <IdList label="満たすべき条件" items={item.criteria} />
      </InfoBlocks>
      <Actions compact={compact}>
        <ConfirmGate
          trigger={{ icon: "approve", label: "承認", minWidth: 110 }}
          consequences={[item.target.title, "提出へ進む"]}
          confirmLabel="承認"
          compact={compact}
          onConfirm={() => onDecide("s3_ok", { iddId: item.iddId })}
        >
        {compact ? null : <span style={{ width: 1, alignSelf: "stretch", background: "var(--bg-hover)" }} />}
        <div style={{ display: "flex", flexDirection: compact ? "row" : "column", gap: compact ? 12 : 8 }}>
          <ActionButton icon="back" label="実装へ戻す" variant="quiet" minWidth={128} fullWidth={compact} onClick={() => onDecide("s3_reject", { iddId: item.iddId, nextStage: "s2_retry", feedback: instruction })} />
          <ActionButton icon="backDeep" label="方針へ戻す" variant="quiet" minWidth={128} fullWidth={compact} onClick={() => onDecide("s3_reject", { iddId: item.iddId, nextStage: "s1_rethink", feedback: instruction })} />
        </div>
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="戻すときの指示"
          data-compact={compact ? "1" : undefined}
          style={{
            flex: 1, minWidth: 160, alignSelf: "stretch",
            padding: "8px 10px", borderRadius: 5,
            background: "var(--bg)", border: "1px solid var(--border)",
            color: "var(--text)", fontSize: FS.sm, fontFamily: "inherit",
          }}
        />
        <IconButton icon="chat" title="衝突の内容を聞く" onClick={onAsk} />
        </ConfirmGate>
      </Actions>
    </Card>
  );
}

/* ── 提出前確認 ───────────────────────────────────────────── */

export function ShipCard({ item, onDecide, onAsk, compact }: CardProps<ShipItem>) {
  const [instruction, setInstruction] = useState("");
  return (
    <Card>
      <Identity
        phase="提出前確認"
        chips={item.handoffNote ? [item.handoffNote] : undefined}
        iddId={item.iddId}
        stage={{ done: 4, current: 4 }}
        subject={item.title}
        refs={item.source ? [item.source] : undefined}
      />
      <InfoBlocks>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 4, background: "var(--bg-panel)", border: "1px solid var(--border)" }}>
          <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>{item.branch.to}</span>
          <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>← {item.branch.from}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{item.branch.repo}</span>
        </div>
        {/* 差分と同じく自前の器を持つ。card 側のスクロールで途中から切られない */}
        <div style={{ flexShrink: 0, borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            <span style={{ flex: 1, fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>提出される内容</span>
            <span style={{ fontSize: FS.xs, color: "var(--text-muted)" }}>lane 内の元の記述と比べる ↗</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, maxHeight: 220, overflowY: "auto" }}>
            <span style={{ fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>{item.pr.title}</span>
            {item.pr.body.map((b) => (
              b.flagged ? (
                <div key={b.text} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 3, background: "var(--bg-panel)", borderLeft: "3px solid var(--accent)" }}>
                  <span style={{ flex: 1, fontSize: FS.md, color: "var(--text)" }}>{b.text}</span>
                  <span style={{ fontSize: FS.xs, fontWeight: 600, color: "var(--text)" }}>元: {b.flagged.original}</span>
                </div>
              ) : (
                <span key={b.text} style={{ fontSize: FS.md, color: "var(--text)" }}>{b.text}</span>
              )
            ))}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>commit {item.pr.commits.length} 件</span>
              {item.pr.commits.map((c) => <span key={c} style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{c}</span>)}
            </div>
          </div>
        </div>
        <IdList
          label="verifier の検査"
          items={item.checks.map((c, i) => ({ id: `#${i + 1}`, text: c.label, state: c.ok ? "done" as const : "todo" as const }))}
        />
      </InfoBlocks>
      <Actions compact={compact}>
        <ConfirmGate
          trigger={{ icon: "approve", label: "このまま出す", minWidth: 150 }}
          consequences={[item.branch.repo, `${item.branch.to} ← ${item.branch.from}`, "PR を作成", `commit ${item.pr.commits.length}`]}
          confirmLabel="出す"
          compact={compact}
          onConfirm={() => onDecide("s4_verify_clean", { iddId: item.iddId })}
        >
        {compact ? null : <span style={{ width: 1, alignSelf: "stretch", background: "var(--bg-hover)" }} />}
        <div style={{ display: "flex", flexDirection: compact ? "row" : "column", gap: compact ? 12 : 8 }}>
          <ActionButton icon="back" label="直させる" variant="quiet" minWidth={124} fullWidth={compact} onClick={() => onDecide("s4_revise", { iddId: item.iddId, instruction })} />
          <ActionButton icon="branch" label="切り出す" variant="quiet" minWidth={124} fullWidth={compact} onClick={() => onDecide("s4_sub_todo", { iddId: item.iddId, instruction })} />
        </div>
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="直させる / 切り出す ときの指示"
          style={{
            flex: 1, minWidth: 160, alignSelf: "stretch",
            padding: "8px 10px", borderRadius: 5,
            background: "var(--bg)", border: "1px solid var(--border)",
            color: "var(--text)", fontSize: FS.sm, fontFamily: "inherit",
          }}
        />
        <IconButton icon="chat" title="指摘の内容を聞く" onClick={onAsk} />
        </ConfirmGate>
      </Actions>
    </Card>
  );
}

/* ── 振り分け ─────────────────────────────────────────────── */

export function InboxCard({ item, onDecide, onAsk, compact }: CardProps<InboxItem>) {
  switch (item.kind) {
    case "duplicate": return <DuplicateCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "question": return <QuestionCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "go": return <GoCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "review": return <ReviewCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "ship": return <ShipCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
  }
}
