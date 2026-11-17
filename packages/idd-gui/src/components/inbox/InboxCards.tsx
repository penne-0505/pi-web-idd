/**
 * The Inbox's cards: one component per kind of judgement, drawn in the prototype's own shapes (G1–G8) and filled
 * from `InboxCardView`, which the engine's state built. The prototype's sample words are gone: every lane name,
 * title, count and list row printed here comes from the view model, and a value the engine did not return is left
 * empty. The one-line inputs are the card's own draft, held by the store so a poll cannot erase it (DEC-9506).
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CardFieldView, DiffFileView, InboxCardView, InboxHandlers, PurposeView, RowView, StatView } from '../../inbox/viewmodel'
import { sendsConsultation } from '../../inbox/viewmodel'
import { WORDS } from '../../strings'

const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '20px 22px',
  background: 'var(--surface)',
  border: '1.5px solid var(--ink)',
  borderRadius: '16px',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-sans)',
  color: 'var(--ink)',
}

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  font: '400 10.5px var(--font-sans)',
  color: 'var(--ink-3)',
}

const CHIP: CSSProperties = {
  padding: '1px 7px',
  borderRadius: '4px',
  font: '600 10px var(--font-mono)',
  whiteSpace: 'nowrap',
}

const ASK: CSSProperties = { font: '600 15px/1.45 var(--font-sans)', textWrap: 'pretty' }

const ROW: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: '10px' }
const ROW_LABEL: CSSProperties = { width: '56px', flex: 'none', font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)' }
const ROW_VALUE: CSSProperties = { flex: '1', font: '400 12px/1.6 var(--font-sans)' }

// rows whose values can be a whole Project body: the rows scroll inside the card at a height the screen can hold, so
// the card never grows past the viewport and the actions under it stay on screen
const ROWS_SCROLL: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: 'min(46vh, 360px)', overflowY: 'auto', minHeight: '0' }
const ROW_VALUE_LONG: CSSProperties = { ...ROW_VALUE, minWidth: '0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const FINDING_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', height: '30px', font: '400 11.5px var(--font-sans)' }

function Header({ card }: { card: InboxCardView }) {
  return (
    <div style={HEADER}>
      <span style={{ ...CHIP, background: card.chipBg, color: card.chipC, display: 'flex', alignItems: 'center', gap: '5px', flex: 'none' }}>
        {card.sign ? <span style={{ width: '9px', height: '9px', border: `1.7px solid ${card.chipC}`, borderRadius: '50%', boxSizing: 'border-box', flex: 'none' }} /> : null}
        {card.chip}
      </span>
      {/* the lane's long title stays on one line and yields to the source link and age (C-154-8) */}
      <span data-card-heading title={card.lane} style={{ color: 'var(--ink-2)', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{card.lane}</span>
      <span style={{ flex: '1', minWidth: '0' }} />
      {card.sourceUrl ? <a href={card.sourceUrl} target="_blank" rel="noreferrer" style={{ font: '400 10px var(--font-mono)', color: 'inherit', whiteSpace: 'nowrap', flex: 'none' }}>{card.source}</a> : card.source ? <span style={{ font: '400 10px var(--font-mono)', whiteSpace: 'nowrap', flex: 'none' }}>{card.source}</span> : null}
      <span style={{ font: '400 10px var(--font-mono)', flex: 'none' }}>{card.age}</span>
    </div>
  )
}

/** why the engine holds the card's main operation now: said once, with no key promised beside it (C-265-4) */
function HeldNote({ card }: { card: InboxCardView }) {
  return card.heldReason ? <div data-held-reason="true" style={{ font: '500 11.5px/1.5 var(--font-sans)', color: 'var(--attention-text)' }}>{WORDS.card.generic.held(card.heldReason)}</div> : null
}

function useNoteFocus(open: boolean) {
  const ref = useRef<HTMLInputElement>(null)
  // ← opens the card's one line while the input is already mounted: focus follows the opening (AC-004)
  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])
  return ref
}

/** the bare input every card line shares: the box around it carries the border */
const LINE_INPUT = { flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 11.5px var(--font-sans)', color: 'var(--ink)' } as const

function NoteInput({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  const ref = useNoteFocus(card.noteOpen)
  if (!card.notePlaceholder) return null
  // while the box is 聞く's consultation, Enter sends the same talk the right panel's input sends, and never the
  // card's answer (C-154-3). The IME conversion's Enter belongs to the input, so it sends nothing
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!sendsConsultation(card.asking, { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return
    e.preventDefault()
    if (card.noteValue.trim()) on.ask()
  }
  // the prototype's two forms: the question's own row carries its label and help, every other card opens the plain
  // 続ける前に一言 input (DEC-9189)
  if (card.cardKind !== 'question') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: '32px', padding: '0 10px', border: '1px solid var(--line)', borderRadius: '8px' }}>
        <input
          ref={ref}
          data-note-input
          value={card.noteValue}
          placeholder={card.notePlaceholder}
          onChange={(e) => on.note(e.target.value)}
          onFocus={() => on.openNote()}
          onKeyDown={onKeyDown}
          style={LINE_INPUT}
        />
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '36px', padding: '0 8px 0 12px', border: '1px solid var(--line-strong)', borderRadius: '9px' }}>
      <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{card.noteLabel}</span>
      <input
        ref={ref}
        data-note-input
        value={card.noteValue}
        placeholder={card.notePlaceholder}
        onChange={(e) => on.note(e.target.value)}
        onFocus={() => on.openNote()}
        onKeyDown={onKeyDown}
        style={LINE_INPUT}
      />
      {/* the help stays on one line: the panel's column is narrow, and a broken word reads as noise (AC-003) */}
      <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{card.noteHint}</span>
    </div>
  )
}

/** the GO's reason line: apart from the revise's, shown only on a GO the engine takes with a reason */
function ReasonInput({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  const open = card.reason?.open ?? false
  const ref = useNoteFocus(open)
  if (!card.reason || !open) return null
  const reason = card.reason
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: '32px', padding: '0 10px', border: '1px solid var(--line-strong)', borderRadius: '8px' }}>
      <input
        ref={ref}
        data-note-input
        data-reason-input
        value={reason.value}
        placeholder={reason.placeholder}
        onChange={(e) => on.reason(e.target.value)}
        onFocus={() => on.openReason()}
        style={LINE_INPUT}
      />
    </div>
  )
}

function Rows({ rows, scrollable }: { rows: RowView[]; scrollable?: boolean }) {
  if (!rows.length) return null
  return (
    <div style={scrollable ? ROWS_SCROLL : { display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((r) => (
        <div key={`${r.label}:${r.value}`} {...selfReportedProps(r.selfReported, ROW)}>
          <span style={ROW_LABEL}>{r.label}</span>
          <span style={scrollable ? ROW_VALUE_LONG : ROW_VALUE}>{r.value}</span>
          {r.selfReported ? <SelfMark /> : null}
        </div>
      ))}
    </div>
  )
}

function Findings({ items, sends }: { items: NonNullable<InboxCardView['findings']>; sends?: InboxCardView['sends'] }) {
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* the findings scroll inside their own box, so a long list never pushes the sends or the note out of the window */}
      <div data-finding-list style={{ display: 'flex', flexDirection: 'column', maxHeight: '42vh', minHeight: 0, overflowY: 'auto' }}>
      {items.map((f, i) => (
        <div key={`${f.severity}:${f.claim}`} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: f.options ? '6px 0' : undefined, borderTop: i ? '1px solid var(--line-soft)' : 'none' }}>
          <div style={{ ...FINDING_ROW, borderTop: 'none' }}>
            <span style={{ width: f.judged ? '88px' : '44px', flex: 'none', font: '500 10px var(--font-mono)', color: f.severity === 'must' || f.judged === 'must' ? 'var(--attention-text)' : 'var(--ink)' }}>
              {f.judged ? `${f.judged} → ${f.severity}` : f.severity}
            </span>
            <span style={{ flex: '1' }}>{f.claim}</span>
            <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{f.where}</span>
          </div>
          {f.options ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', font: '400 10.5px var(--font-sans)' }}>
              {f.options.map((o) => (
                <button
                  key={o.action}
                  type="button"
                  data-finding-option={o.action}
                  data-finding-selected={o.selected ? 'true' : undefined}
                  onClick={o.pick}
                  style={{ padding: '2px 8px', border: `1px solid ${o.selected ? 'var(--ink)' : 'var(--line-strong)'}`, borderRadius: '10px', background: o.selected ? 'var(--ink)' : 'transparent', color: o.selected ? 'var(--surface)' : 'var(--ink-2)', font: 'inherit', cursor: 'pointer' }}
                >
                  {o.label}
                </button>
              ))}
              <span style={{ marginLeft: 'auto', color: f.fixes ? 'var(--ok)' : 'var(--ink-3)' }}>{f.state}</span>
            </div>
          ) : null}
        </div>
      ))}
      </div>
      {sends ? (
        <div data-finding-sends style={{ marginTop: '6px', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: '8px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>
          <span style={{ color: 'var(--ink-3)' }}>{sends.heading}　</span>
          {sends.refs.length ? <span style={{ font: '500 10.5px var(--font-mono)' }}>{sends.refs.join('　')}</span> : <span>{sends.empty}</span>}
        </div>
      ) : null}
    </div>
  )
}

export function QuestionCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '460px', flex: 'none' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {card.choices.map((c) => (
          <div
            key={c.index}
            data-choice={c.index}
            data-choice-selected={c.selected ? 'true' : undefined}
            onClick={() => on.select(c.index)}
            style={{ display: 'flex', alignItems: 'center', gap: '10px', height: '38px', padding: '0 11px', borderRadius: '9px', border: `1.5px solid ${c.selected ? 'var(--ink)' : 'var(--line)'}`, cursor: 'pointer', opacity: c.dim ? '.7' : '1' }}
          >
            <span style={{ width: '18px', height: '18px', flex: 'none', borderRadius: '5px', border: `1px solid ${c.selected ? 'var(--ink)' : 'var(--line-strong)'}`, font: '500 10px/16px var(--font-mono)', textAlign: 'center', boxSizing: 'border-box', background: c.selected ? 'var(--ink)' : 'transparent', color: c.selected ? 'var(--surface)' : 'var(--ink-2)' }}>{c.index}</span>
            <span style={{ flex: '1', font: '600 12px var(--font-sans)' }}>{c.label}</span>
            {c.badge ? <span style={{ padding: '1px 7px', borderRadius: '4px', background: c.badgeBg, color: c.badgeC, font: '600 10px var(--font-sans)', whiteSpace: 'nowrap' }}>{c.badge}</span> : null}
          </div>
        ))}
      </div>
      <NoteInput card={card} on={on} />
    </div>
  )
}

const FIELD_HEADING: CSSProperties = { font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)' }
const SELF_MARK: CSSProperties = { padding: '0 5px', borderRadius: '4px', border: '1px dashed var(--line-strong)', font: '500 9.5px var(--font-sans)', color: 'var(--ink-2)', whiteSpace: 'nowrap', flex: 'none' }
const SELF_EDGE: CSSProperties = { paddingLeft: '8px', borderLeft: '2px dashed var(--line-strong)' }

function SelfMark() {
  return <span title={WORDS.go.selfReportedHint} style={SELF_MARK}>{WORDS.go.selfReported}</span>
}

/** a line that rests on an agent's own account carries the dashed edge and the attribute the tests and the CSS read */
function selfReportedProps(selfReported: boolean | undefined, style: CSSProperties) {
  return { 'data-self-reported': selfReported ? 'true' : undefined, style: selfReported ? { ...style, ...SELF_EDGE } : style }
}

/**
 * The fields after the first, each under its heading. Words that rest on what an agent wrote about its own work
 * wear a mark and a dashed line, so they are not read with the same face as the records' facts.
 */
function Fields({ fields }: { fields: CardFieldView[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {fields.map((f) => (
        <div key={f.key} data-field={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={FIELD_HEADING}>{f.heading}</span>
          {f.lines.map((l, i) => (
            <div key={`${i}:${l.text}`} {...selfReportedProps(l.selfReported, { display: 'flex', alignItems: 'baseline', gap: '8px' })}>
              {l.selfReported ? <SelfMark /> : null}
              <span style={{ flex: '1', font: '400 12px/1.6 var(--font-sans)' }}>
                {l.link && /^https?:\/\//.test(l.link) ? <a href={l.link} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{l.text}</a> : l.text}
                {l.link && !/^https?:\/\//.test(l.link) ? <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--ink-3)' }}> {l.link}</span> : null}
                {l.source ? <span style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>　{l.source}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const JUDGE_FIELD: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid var(--line-strong)', borderRadius: '8px', background: 'var(--surface)', font: '400 11.5px/1.5 var(--font-sans)', color: 'var(--ink)' }
const JUDGE_PRESS: CSSProperties = { padding: '3px 10px', borderRadius: '999px', border: '1px solid var(--line-strong)', font: '500 10.5px var(--font-sans)', cursor: 'pointer', whiteSpace: 'nowrap' }

/**
 * One Purpose the GO press confirms, with the two judgments the engine allows on it. The inputs are this row's own
 * state, keyed by the sentence it shows, so a rewrite that lands (the sentence changed) starts the row afresh. The
 * inputs are text fields outside the card's one line, so no key reaches the card while one is focused (C-143-4).
 */
function PurposeRow({ p, on }: { p: PurposeView; on: InboxHandlers }) {
  const [mode, setMode] = useState<'view' | 'restate' | 'withdraw'>('view')
  const [statement, setStatement] = useState(p.statement)
  const [grounds, setGrounds] = useState('')
  const w = WORDS.go.purpose
  const sendable = mode === 'restate' ? statement.trim() !== '' && statement.trim() !== p.statement.trim() : grounds.trim() !== ''
  return (
    <li data-go-purpose={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '3px', listStyle: 'none' }}>
      <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{p.id}{p.name ? ` · ${p.name}` : ''}</span>
      <span data-go-purpose-statement={p.id} style={{ font: '500 12px/1.6 var(--font-sans)', whiteSpace: 'pre-wrap' }}>{p.statement}</span>
      {p.history ? <span style={{ font: '400 10.5px/1.5 var(--font-sans)', color: 'var(--ink-3)' }}>{p.history}</span> : null}
      {p.origin ? <span style={{ font: '400 10.5px/1.5 var(--font-sans)', color: 'var(--ink-3)' }}>{p.origin}</span> : null}
      {mode === 'view' && (p.canRestate || p.canWithdraw) ? (
        <span style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
          {p.canRestate ? <span role="button" data-go-purpose-restate={p.id} onClick={() => { setStatement(p.statement); setMode('restate') }} style={JUDGE_PRESS}>{w.restate}</span> : null}
          {p.canWithdraw ? <span role="button" data-go-purpose-withdraw={p.id} onClick={() => setMode('withdraw')} style={JUDGE_PRESS}>{w.withdraw}</span> : null}
        </span>
      ) : null}
      {mode !== 'view' ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' }}>
          {mode === 'restate' ? (
            <textarea value={statement} rows={3} aria-label={w.statementLabel(p.id)} onChange={(e) => setStatement(e.target.value)} style={{ ...JUDGE_FIELD, resize: 'vertical' }} />
          ) : (
            <input value={grounds} placeholder={w.groundsPlaceholder} aria-label={w.groundsPlaceholder} onChange={(e) => setGrounds(e.target.value)} style={JUDGE_FIELD} />
          )}
          <span style={{ display: 'flex', gap: '8px' }}>
            <span
              role="button"
              data-go-purpose-send={p.id}
              onClick={() => {
                if (!sendable) return
                if (mode === 'restate') on.purposeRestate(p.id, statement.trim())
                else on.purposeWithdraw(p.id, grounds.trim())
              }}
              style={{ ...JUDGE_PRESS, opacity: sendable ? '1' : '.5', cursor: sendable ? 'pointer' : 'default' }}
            >
              {mode === 'restate' ? w.restateSend : w.withdrawSend}
            </span>
            <span role="button" onClick={() => setMode('view')} style={JUDGE_PRESS}>{w.cancel}</span>
          </span>
        </span>
      ) : null}
    </li>
  )
}

/** the Purposes the GO press will confirm, in full: the card shows what the press confirms, and only that (DEC-112-1, C-265-4) */
function GoPurposes({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  if (!card.purposes?.length) return null
  return (
    <div data-go-purposes style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: '1px solid var(--line-strong)', borderRadius: '10px', background: 'var(--bg-sidebar)' }}>
      <span style={{ font: '600 11.5px var(--font-sans)' }}>{WORDS.go.purposes}</span>
      <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {card.purposes.map((p) => <PurposeRow key={`${p.id}:${p.statement}`} p={p} on={on} />)}
      </ul>
    </div>
  )
}

export function GoCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      {card.waiting ? <div data-waiting="true" style={{ font: '500 11.5px/1.5 var(--font-sans)', color: 'var(--attention-text)' }}>{card.waiting}</div> : null}
      {/* the first field is the question itself, drawn as the card's heading line */}
      <div style={ASK} data-field={card.fields ? 'decide' : undefined}>{card.ask}</div>
      <Rows rows={card.rows} />
      <GoPurposes card={card} on={on} />
      {card.fields ? <Fields fields={card.fields.slice(1)} /> : null}
      {card.fieldsRaw ? <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.go.rawNote}</span> : null}
      {card.reasonNeeded ? <div data-reason-needed="true" style={{ font: '500 11.5px/1.5 var(--font-sans)', color: 'var(--attention-text)' }}>{card.reasonNeeded}</div> : null}
      <HeldNote card={card} />
      <NoteInput card={card} on={on} />
      <ReasonInput card={card} on={on} />
    </div>
  )
}

function StatCell({ stat }: { stat: StatView }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '11px 12px 12px', background: 'var(--surface)' }}>
      <span style={{ font: '500 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>{stat.label}</span>
      <div style={{ display: 'flex', alignItems: 'flex-end', minHeight: '40px' }}>
        {stat.kind === 'rounds' ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
            {Array.from({ length: Math.max(0, Math.min(stat.rounds ?? 0, 12)) }, (_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                <span style={{ font: '600 10px var(--font-mono)', color: 'var(--ink)', minHeight: '12px' }} />
                <span style={{ width: '14px', height: '32px', borderRadius: '3px 3px 0 0', background: 'var(--ink)' }} />
                <span style={{ font: '400 9px var(--font-mono)', color: 'var(--ink-3)' }}>R{i + 1}</span>
              </div>
            ))}
          </div>
        ) : stat.kind === 'leftovers' ? (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
            {[{ n: stat.leftovers, label: '後回し', kind: 'left' as const }, { n: stat.rejected, label: '棄却', kind: 'rejected' as const }].map((g) => (
              <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', width: '42px' }}>
                  {Array.from({ length: Math.max(0, Math.min(g.n, 12)) }, (_, i) => (
                    <span key={i} style={{ width: '9px', height: '9px', borderRadius: '2px', boxSizing: 'border-box', border: g.kind === 'left' ? '1.5px solid var(--ink)' : '1px solid var(--mute-1)', background: g.kind === 'rejected' ? 'repeating-linear-gradient(135deg,var(--mute-1) 0 1.5px,transparent 1.5px 3px)' : 'transparent' }} />
                  ))}
                </div>
                <span style={{ font: '500 9.5px var(--font-sans)', color: g.kind === 'left' ? 'var(--ink)' : 'var(--ink-2)' }}>{g.label} {g.n}</span>
              </div>
            ))}
          </div>
        ) : (
          <span style={{ position: 'relative', width: '44px', height: '44px', flex: 'none', borderRadius: '50%', background: 'var(--line)' }} />
        )}
      </div>
    </div>
  )
}

/** a stack of `gap` and a line of type: the batch card's small pieces are named by these two, not styled one by one */
const stack = (gap: string, extra?: CSSProperties): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap, ...extra })
const type = (font: string, color?: string, extra?: CSSProperties): CSSProperties => ({ font, color, ...extra })
const ATTENTION = 'var(--attention-text)'
const NOWRAP: CSSProperties = { whiteSpace: 'nowrap' }
const NOTICE: CSSProperties = { padding: '8px 10px', borderRadius: '9px', background: 'var(--attention-bg)', border: '1px solid var(--attention-border)' }
const CODE: CSSProperties = { margin: '4px 0 0', padding: '8px 10px', borderRadius: '7px', background: 'var(--bg-sidebar)', overflow: 'auto', maxHeight: '240px', whiteSpace: 'pre' }

type BatchView = NonNullable<InboxCardView['batch']>

/** one lane of a batch card, with the switch that takes it off the one signature */
function BatchLane({ lane: l, first, running }: { lane: BatchView['lanes'][number]; first: boolean; running: boolean }) {
  const track: CSSProperties = { width: '24px', height: '14px', flex: 'none', borderRadius: '7px', background: l.on ? 'var(--ink)' : 'var(--line-strong)', position: 'relative', cursor: running ? 'default' : 'pointer' }
  const knob: CSSProperties = { position: 'absolute', top: '2px', left: l.on ? '12px' : '2px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--surface)' }
  const idTag: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-sidebar)', ...type('400 10px var(--font-mono)', 'var(--ink-2)'), ...NOWRAP }
  const titleCell: CSSProperties = { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', ...type('400 11.5px var(--font-sans)'), ...NOWRAP }
  return (
    <div data-batch-lane={l.iddId} data-batch-on={l.on ? 'on' : 'off'} style={{ ...stack('8px', { flexDirection: 'row', alignItems: 'center', padding: '7px 0', opacity: l.on ? 1 : 0.55 }), borderTop: first ? 'none' : '1px solid var(--line-soft)' }}>
      <span title={l.on ? WORDS.batch.laneOff : WORDS.batch.laneOn} onClick={running ? undefined : l.toggle} style={track}><span style={knob} /></span>
      <span style={idTag}>{l.iddId}</span>
      <span style={titleCell} title={l.title}>{l.title}</span>
      <span style={type('400 10px var(--font-mono)', 'var(--ink-3)')}>{l.head}</span>
      {l.close ? <span style={{ ...type('400 10px var(--font-sans)', 'var(--ink-2)'), ...NOWRAP }}>{l.close}</span> : null}
      <span style={{ ...type('500 10px var(--font-sans)', 'var(--ink-2)'), ...NOWRAP }}>{l.on ? WORDS.batch.on : WORDS.batch.off}</span>
    </div>
  )
}

/** what the signed batch before this one did after the signature: the changes it made, with their grounds and diff */
function BatchConverted({ converted }: { converted: BatchView['converted'] }) {
  return (
    <div data-batch-converted style={stack('3px')}>
      <span style={type('600 11px var(--font-sans)')}>{WORDS.batch.rows.converted}</span>
      {converted.map((c, i) => (
        <div key={`${c.iddId}${i}`} data-batch-conversion={c.iddId} style={stack('3px')}>
          <span style={type('400 10.5px/1.5 var(--font-sans)', 'var(--ink-2)')}>{c.iddId} · {c.kind} · {c.files.join(', ')} — {c.rationale}</span>
          {c.diff ? (
            <details data-batch-diff>
              <summary style={{ ...type('500 10.5px var(--font-sans)', 'var(--ink-2)'), cursor: 'pointer' }}>{WORDS.batch.rows.diff}</summary>
              <pre style={{ ...CODE, ...type('400 10.5px/1.5 var(--font-mono)') }}>{c.diff}</pre>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * The lanes of a batch card, each with the switch that takes it off the one signature, and below them what the signed
 * batch before it did: the lanes it left out with why, and the changes it made after the signature with their grounds
 * (C-247-1, C-247-6).
 */
function BatchLanes({ batch }: { batch: BatchView }) {
  const note = type('400 10.5px/1.5 var(--font-sans)', ATTENTION)
  const forecasts = batch.lanes.filter((l) => l.forecast)
  return (
    <div data-batch-card style={stack('6px')}>
      {batch.running ? <span data-batch-running style={type('500 11px var(--font-sans)', ATTENTION)}>{batch.running}</span> : null}
      <div style={stack('0px')}>
        {batch.lanes.map((l, i) => <BatchLane key={l.iddId} lane={l} first={i === 0} running={Boolean(batch.running)} />)}
      </div>
      {forecasts.length ? (
        <div style={stack('2px')}>
          {forecasts.map((l) => <span key={l.iddId} style={type('400 10.5px/1.5 var(--font-mono)', ATTENTION)}>{l.iddId}: {l.forecast}</span>)}
        </div>
      ) : null}
      {batch.dropped.length ? (
        <div data-batch-dropped style={{ ...stack('3px'), ...NOTICE }}>
          <span style={type('600 11px var(--font-sans)', ATTENTION)}>{WORDS.batch.rows.dropped}</span>
          {batch.dropped.map((d) => <span key={d.iddId} style={note}>{d.iddId}: {d.reason}</span>)}
        </div>
      ) : null}
      {batch.converted.length ? <BatchConverted converted={batch.converted} /> : null}
      {batch.rebuildFailed.length ? (
        <div data-batch-rebuild-failed style={{ ...NOTICE, ...stack('3px') }}>
          <span style={type('600 11px var(--font-sans)', ATTENTION)}>{WORDS.batch.rows.rebuildFailed}</span>
          {batch.rebuildFailed.map(({ iddId, what }, i) => <span key={`${iddId}${i}`} style={note}>{`${iddId}: ${what}`}</span>)}
        </div>
      ) : null}
      {batch.stopped ? <span data-batch-stopped style={note}>{WORDS.batch.rows.stopped}: {batch.stopped}</span> : null}
    </div>
  )
}

export function SubmitCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  const d = card.destination
  return (
    <div style={{ ...CARD, width: '540px', flex: 'none' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {card.checkWarnings?.length ? (
        <div data-card-warnings style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 10px', borderRadius: '9px', background: 'var(--attention-bg)', border: '1px solid var(--attention-border)' }}>
          <span style={{ font: '600 11px var(--font-sans)', color: 'var(--attention-text)' }}>{WORDS.ship.nonBlocking}</span>
          {card.checkWarnings.map((w) => (
            <span key={w.name} style={{ font: '400 10.5px/1.5 var(--font-mono)', color: 'var(--attention-text)' }}>{w.name}: {w.reason}</span>
          ))}
        </div>
      ) : null}
      {d ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0', padding: '12px 14px', borderRadius: '11px', background: 'var(--sign-bg)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <span style={{ font: '500 11px var(--font-mono)', color: 'var(--sign-text)' }}>{d.from}</span>
            <span style={{ display: 'flex', gap: '3px' }}>
              {Array.from({ length: d.dots }, (_, i) => <span key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--sign)' }} />)}
            </span>
          </div>
          <div style={{ flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', padding: '0 10px' }}>
            <span style={{ font: '600 10px var(--font-sans)', color: 'var(--sign-text)' }}>{d.label}</span>
            <span style={{ position: 'relative', width: '100%', height: '2px', background: 'var(--sign)' }}>
              <span style={{ position: 'absolute', right: '-1px', top: '-4px', width: '0', height: '0', borderLeft: '7px solid var(--sign)', borderTop: '5px solid transparent', borderBottom: '5px solid transparent' }} />
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
            <span style={{ font: '600 11.5px var(--font-mono)', color: 'var(--sign-text)' }}>{d.repo}</span>
            <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-2)' }}>{d.line}</span>
          </div>
        </div>
      ) : null}
      {card.checks?.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
          {card.checks.map((c) => (
            <span key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '16px', padding: '0 8px 0 4px', borderRadius: '8px', background: c.ok ? 'var(--ok-bg)' : 'var(--attention-bg)', whiteSpace: 'nowrap' }}>
              <span style={{ width: '8px', height: '8px', flex: 'none', borderRadius: '50%', background: c.ok ? 'var(--ok)' : 'var(--attention)' }} />
              <span style={{ font: '500 10px var(--font-mono)', color: c.ok ? 'var(--ok-text)' : 'var(--attention-text)' }}>{c.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      {card.checks?.some((c) => c.reason) ? (
        <div data-card-check-reasons style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {card.checks.filter((c) => c.reason).map((c) => (
            <span key={c.label} style={{ font: '400 10.5px/1.5 var(--font-mono)', color: c.ok ? 'var(--ink-2)' : 'var(--attention-text)' }}>{c.label}: {c.reason}</span>
          ))}
        </div>
      ) : null}
      {card.stats ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '1px', background: 'var(--line)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
          {card.stats.map((s) => (
            <StatCell key={s.label} stat={s} />
          ))}
        </div>
      ) : null}
      {card.batch ? <BatchLanes batch={card.batch} /> : null}
      <Rows rows={card.rows} />
      <NoteInput card={card} on={on} />
    </div>
  )
}

export function PostCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  const d = card.destination
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {d ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 11px', borderRadius: '9px', background: 'var(--external-bg)', font: '400 11px var(--font-mono)', color: 'var(--external)' }}>
          <span style={{ font: '600 10.5px var(--font-sans)' }}>{d.label}</span>
          {d.line}
          <span style={{ flex: '1' }} />
          {card.parts?.length ? <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--ink-2)' }}>{card.parts.filter((p) => !p.posted).length} 件</span> : null}
        </div>
      ) : null}
      {card.parts?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {card.parts.map((p, i) => (
            <div key={p.ref} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 0', borderTop: i ? '1px solid var(--line-soft)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-sidebar)', font: '400 10px var(--font-mono)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{p.ref}</span>
                <span style={{ whiteSpace: 'nowrap', color: 'var(--ink-2)' }}>{p.label}</span>
                <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{p.quote}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: '64px', padding: '8px 10px 6px', border: '1px solid var(--line-strong)', borderRadius: '8px', boxSizing: 'border-box', font: '400 11.5px/1.7 var(--font-sans)' }}>
                <textarea
                  value={p.body}
                  onChange={(e) => on.outboundReply(p.ref, { body: e.target.value })}
                  style={{ flex: '1', resize: 'vertical', border: 'none', outline: 'none', background: 'transparent', font: 'inherit', color: 'inherit' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>
                <span onClick={() => on.outboundReply(p.ref, { resolve: !p.resolve })} style={{ width: '24px', height: '14px', borderRadius: '7px', background: p.resolve ? 'var(--ink)' : 'var(--line-strong)', position: 'relative', cursor: 'pointer' }}>
                  <span style={{ position: 'absolute', top: '2px', left: p.resolve ? '12px' : '2px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--surface)' }} />
                </span>
                Resolve
              </div>
            </div>
          ))}
        </div>
      ) : card.body ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {card.body.title ? <div style={{ font: '600 12px var(--font-sans)' }}>{card.body.title}</div> : null}
          <textarea
            value={card.body.text}
            onChange={(e) => on.outboundField({ body: e.target.value })}
            style={{ minHeight: '90px', padding: '8px 10px', border: '1px solid var(--line-strong)', borderRadius: '8px', background: 'var(--surface)', font: '400 11.5px/1.7 var(--font-sans)', color: 'var(--ink)', resize: 'vertical' }}
          />
        </div>
      ) : null}
      <NoteInput card={card} on={on} />
    </div>
  )
}

export function ReviewCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {card.body ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {card.body.title ? <div style={{ font: '600 12px var(--font-sans)' }}>{card.body.title}</div> : null}
          <textarea
            value={card.body.text}
            onChange={(e) => on.outboundField({ body: e.target.value })}
            style={{ minHeight: '90px', padding: '8px 10px', border: '1px solid var(--line-strong)', borderRadius: '8px', background: 'var(--surface)', font: '400 11.5px/1.7 var(--font-sans)', color: 'var(--ink)', resize: 'vertical' }}
          />
        </div>
      ) : null}
      <NoteInput card={card} on={on} />
    </div>
  )
}

export function StuckCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {card.bars && card.counts ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '1px', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
            {card.bars.map((b, i) => <span key={i} style={{ flex: Math.max(1, b.flex), background: b.kind === 'ok' ? 'var(--ok)' : b.kind === 'attn' ? 'var(--attention)' : 'var(--line-strong)' }} />)}
          </div>
          <div style={{ display: 'flex', gap: '14px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>
            <span>直した {card.counts.fixed}</span>
            <span style={{ color: 'var(--attention-text)' }}>残り {card.counts.remaining}</span>
            <span style={{ color: 'var(--ink-3)' }}>棄却 {card.counts.rejected}</span>
          </div>
        </div>
      ) : null}
      <Findings items={card.findings ?? []} sends={card.sends} />
      <NoteInput card={card} on={on} />
    </div>
  )
}

export function DuplicateCard({ card }: { card: InboxCardView }) {
  return (
    <div style={{ ...CARD, width: '420px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {card.boxes ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '8px' }}>
          {card.boxes.map((b) => (
            <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: '3px', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: '9px' }}>
              <span style={{ font: '500 10px var(--font-sans)', color: 'var(--ink-3)' }}>{b.label}</span>
              <span style={{ font: '500 10px var(--font-mono)', color: 'var(--ink-2)' }}>{b.id}</span>
              <span style={{ font: '500 12px var(--font-sans)' }}>{b.title}</span>
            </div>
          ))}
        </div>
      ) : null}
      <Rows rows={card.rows} />
    </div>
  )
}

export function RequeueCard({ card }: { card: InboxCardView }) {
  return (
    <div style={{ ...CARD, width: '420px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      {card.previous ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '9px', background: 'var(--surface-sunk)', font: '400 11.5px/1.65 var(--font-sans)' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <span style={{ font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)', width: '44px' }}>前回</span>
            <span>{[card.previous.outcome, card.previous.at].filter(Boolean).join(' · ')}</span>
          </div>
          {card.previous.reason ? (
            <div style={{ display: 'flex', gap: '10px' }}>
              <span style={{ font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)', width: '44px' }}>理由</span>
              <span>{card.previous.reason}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <Rows rows={card.rows} />
    </div>
  )
}

/** a proposal waits for the user's answer: what is now, what is proposed, why, and when it takes effect */
export function ProposalCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      <Rows rows={card.rows} />
      <NoteInput card={card} on={on} />
    </div>
  )
}

/** a conflict with an outside tracker: the three values and nothing to answer; it closes at the sync that finds the sides agreeing */
export function SyncConflictCard({ card }: { card: InboxCardView }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      <Rows rows={card.rows} scrollable />
      {card.note ? <div style={{ font: '400 11px/1.7 var(--font-sans)', color: 'var(--ink-3)' }}>{card.note}</div> : null}
    </div>
  )
}

const DIFF_SIDE: CSSProperties = { flex: '1', minWidth: '0', margin: '0', padding: '8px 10px', border: '1px solid var(--line-soft)', borderRadius: '8px', font: '400 10.5px/1.5 var(--font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 'min(32vh, 260px)', overflowY: 'auto' }
const DIFF_STEP: CSSProperties = { padding: '2px 8px', border: '1px solid var(--line-soft)', borderRadius: '6px', background: 'transparent', color: 'var(--ink-2)', font: '500 10.5px var(--font-sans)', cursor: 'pointer' }

/** the files of a review's diff, one at a time; moving to the next stays inside the card (DEC-703) */
function DiffReader({ files }: { files: DiffFileView[] }) {
  const [at, setAt] = useState(0)
  const index = Math.min(at, files.length - 1)
  const file = files[index]
  const words = WORDS.card.generic.diff
  return (
    <div data-diff-reader style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '500 11px var(--font-mono)', color: 'var(--ink-2)' }}>
        <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.file}>{file.file}</span>
        <span data-diff-position style={{ color: 'var(--ink-3)' }}>{words.position(index + 1, files.length)}</span>
        <button type="button" data-diff-prev style={DIFF_STEP} disabled={index === 0} onClick={() => setAt(index - 1)}>{words.prev}</button>
        <button type="button" data-diff-next style={DIFF_STEP} disabled={index >= files.length - 1} onClick={() => setAt(index + 1)}>{words.next}</button>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        {file.before ? <pre data-diff-before aria-label={words.before} style={DIFF_SIDE}>{file.before}</pre> : null}
        {file.after ? <pre data-diff-after aria-label={words.after} style={DIFF_SIDE}>{file.after}</pre> : null}
      </div>
    </div>
  )
}

/**
 * Any card the screen has no shape of its own for: the engine's judgment as the heading, its materials as rows, and the
 * operations in the row below. A kind added to the engine is drawn and answered here without a change to the screen (C-265-3).
 */
export function GenericCard({ card, on }: { card: InboxCardView; on: InboxHandlers }) {
  return (
    <div style={{ ...CARD, width: '540px' }}>
      <Header card={card} />
      <div style={ASK}>{card.ask}</div>
      <Rows rows={card.material ?? []} scrollable />
      {card.diffs?.length ? <DiffReader key={card.diffs.map((d) => d.file).join('|')} files={card.diffs} /> : null}
      {card.note ? <div style={{ font: '400 11.5px/1.7 var(--font-sans)', color: 'var(--ink-2)' }}>{card.note}</div> : null}
      <HeldNote card={card} />
      {card.notePlaceholder ? <NoteInput card={card} on={on} /> : null}
    </div>
  )
}
