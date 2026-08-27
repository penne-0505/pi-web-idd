"use client";

// intent: DEC-637 — 固定ラベルの操作はボタン、可変内容はリスト。押したら確定
// intent: DEC-628 — 取り返しのつかない 4 つにだけ確認を挟む

import { useEffect, useState } from "react";
import type {
  DuplicateItem, GoItem, InboxItem, QuestionItem, ReviewItem, ShipItem,
} from "@/lib/idd-ui/types";
import {
  ActionButton, Card, ConfirmGate, Field, IconButton, OptionRow, SegmentedPair,
} from "../primitives";
import {
  Actions, CollapsedFacts, Comparison, DuplicatePair, FactTable, Identity, IdList, InfoBlocks, DiffView, Meter, MissingContract, SharedItems, Subject,
} from "./parts";
import { FS } from "@/lib/idd-ui/scale";

export type DecideHandler = (action: string, payload?: Record<string, unknown>) => void;

interface CardProps<T> {
  item: T;
  onDecide: DecideHandler;
  onAsk?: () => void;
  compact?: boolean;
}

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

export function QuestionCard({ item, onDecide, compact }: CardProps<QuestionItem>) {
  const current = item.open[0];
  const [selected, setSelected] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const answered = selected !== null || other.trim().length > 0;
  const last = item.open.length === 1;
  const position = item.answeredCount + 1;

  // intent: DEC-677 — 次の問いへ移ったら入力を空にする (前の回答が残ると誤送信になる)
  useEffect(() => {
    setSelected(null);
    setOther("");
    setReason("");
  }, [current?.questionId]);

  if (!current) return null;

  return (
    <Card>
      <Identity
        phase="質問"
        chips={item.askedTotal > 1 ? [`${position} / ${item.askedTotal}`] : undefined}
        iddId={item.iddId}
        stage={{ done: 1, current: 1 }}
        subject={item.laneTitle}
        subjectWeak
        refs={item.source ? [item.source] : undefined}
      />
      <Subject text={current.question} />
      <InfoBlocks>
        <CollapsedFacts count={current.facts.length} primary={item.primaryRef} facts={current.facts} />
      </InfoBlocks>
      <div style={{ display: "flex", flexDirection: "column", gap: compact ? 10 : 6 }}>
        {current.options.map((o) => (
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
          index={current.options.length + 1}
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
          icon={last ? "go" : "down"}
          label={last ? "回答して再開させる" : "次の質問へ"}
          variant="primary"
          fullWidth={compact}
          disabled={!answered}
          onClick={() => onDecide("answer", {
            iddId: item.iddId,
            batchId: item.batchId,
            questionId: current.questionId,
            selection: selected !== null ? { index: selected } : { label: "その他" },
            reason: reason || undefined,
            notes: other || undefined,
          })}
        />
        {last ? null : (
          <span style={{ fontSize: FS.sm, color: "var(--text-dim)" }}>
            残り {item.open.length - 1}
          </span>
        )}
      </Actions>
    </Card>
  );
}

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
        {item.intentPath ? (
          <MissingContract path={item.intentPath} />
        ) : (
          <>
            <IdList label="やること (方針)" items={item.decisions.map((d) => ({ id: d.id, text: d.text }))} />
            <IdList label="満たすべき条件" items={item.criteria.map((c) => ({ id: c.id, text: c.text }))} />
          </>
        )}
      </InfoBlocks>
      <Actions compact={compact}>
        <span style={{ display: "flex", gap: 12, width: compact ? "100%" : undefined }}>
          <ActionButton icon="go" label="GO" variant="primary" minWidth={92} fullWidth={compact} disabled={Boolean(item.intentPath)} onClick={() => onDecide("s1_go", { iddId: item.iddId })} />
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

export function ShipCard({ item, onDecide, onAsk, compact }: CardProps<ShipItem>) {
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.pr.title);
  const [body, setBody] = useState(() => item.pr.body.map((b) => `- ${b.text}`).join("\n"));
  const edited = title !== item.pr.title || body !== item.pr.body.map((b) => `- ${b.text}`).join("\n");
  // intent: DEC-694 — 内部語彙が残っているかは編集中も判定し続ける (直したことがその場で分かる)
  const leftover = /\b(DEC|INV|QA|AC|IDD)-[\w.]+/;
  const flaggedLines = body.split("\n").filter((l) => leftover.test(l));

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
        <div style={{ flexShrink: 0, borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            <span style={{ flex: 1, fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }}>提出される内容</span>
            {flaggedLines.length ? (
              <span style={{ fontSize: FS.xs, color: "var(--text)" }}>内部語彙 {flaggedLines.length}</span>
            ) : null}
            {edited ? <span style={{ fontSize: FS.xs, color: "var(--text-muted)" }}>編集済み</span> : null}
            <IconButton
              icon={editing ? "approve" : "diff"}
              title={editing ? "編集を終える" : "文面を直す"}
              size={compact ? 44 : 30}
              onClick={() => setEditing((v) => !v)}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, maxHeight: 260, overflowY: "auto" }}>
            {editing ? (
              <>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{
                    padding: "8px 10px", borderRadius: 4,
                    background: "var(--bg)", border: "1px solid var(--border-strong)",
                    color: "var(--text)", fontSize: FS.lg, fontWeight: 600, fontFamily: "inherit",
                  }}
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={Math.min(14, body.split("\n").length + 2)}
                  style={{
                    padding: "8px 10px", borderRadius: 4, resize: "vertical",
                    background: "var(--bg)", border: "1px solid var(--border-strong)",
                    color: "var(--text)", fontSize: FS.md, fontFamily: "inherit", lineHeight: 1.6,
                  }}
                />
              </>
            ) : (
              <>
                <span style={{ fontSize: FS.lg, fontWeight: 600, color: "var(--text)" }}>{title}</span>
                {body.split("\n").filter(Boolean).map((line, i) => (
                  leftover.test(line) ? (
                    <div key={`${line}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 3, background: "var(--bg-panel)", borderLeft: "3px solid var(--accent)" }}>
                      <span style={{ flex: 1, fontSize: FS.md, color: "var(--text)" }}>{line}</span>
                      <span style={{ fontSize: FS.xs, fontWeight: 600, color: "var(--text)" }}>内部語彙</span>
                    </div>
                  ) : (
                    <span key={`${line}-${i}`} style={{ fontSize: FS.md, color: "var(--text)" }}>{line}</span>
                  )
                ))}
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: FS.xs, fontWeight: 600, color: "var(--text-muted)" }}>commit {item.pr.commits.length} 件</span>
                  {item.pr.commits.map((c) => <span key={c} style={{ fontSize: FS.xs, color: "var(--text-dim)" }}>{c}</span>)}
                </div>
              </>
            )}
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
          consequences={[item.branch.repo, `${item.branch.to} ← ${item.branch.from}`, "PR を作成", `commit ${item.pr.commits.length}`, ...(edited ? ["文面は編集済み"] : [])]}
          confirmLabel="出す"
          compact={compact}
          onConfirm={() => onDecide("s4_verify_clean", {
            iddId: item.iddId,
            ...(edited ? { pr: { title, body } } : {}),
          })}
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

export function InboxCard({ item, onDecide, onAsk, compact }: CardProps<InboxItem>) {
  switch (item.kind) {
    case "duplicate": return <DuplicateCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "question": return <QuestionCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "go": return <GoCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "review": return <ReviewCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
    case "ship": return <ShipCard item={item} onDecide={onDecide} onAsk={onAsk} compact={compact} />;
  }
}
