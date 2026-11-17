// The Inbox's right panel: the prototype's one frame (chip, lane, state, close, tab row, body, ask row) with the
// body filled from `InboxPanelView`. The panel draws values only; the operations stay on the card's own row.
// The question stepper, the round bands and the check command lines are the prototype's own shapes, filled from
// the fields the engine returns and left empty where it returned none (DEC-103-2).
import type { InboxHandlers, InboxPanelView, PanelRoundView, PanelSectionView } from '../../inbox/viewmodel'
import { sendsConsultation } from '../../inbox/viewmodel'
import type { ConsultView } from '../../chat/viewmodel'

/** a panel drawn on its own (a test, a preview) needs no handlers: the operations stay on the card */
const NO_HANDLERS = new Proxy({}, { get: () => () => {} }) as InboxHandlers

const BAR: Record<PanelRoundView['segments'][number]['kind'], { bg: string; c: string }> = {  ok: { bg: 'var(--ok-bg)', c: 'var(--ok-text)' },
  attn: { bg: 'var(--attention-bg)', c: 'var(--attention-text)' },
  line: { bg: 'var(--line-soft)', c: 'var(--ink-2)' },
}

function RoundBands({ rounds }: { rounds: PanelRoundView[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rounds.map((r, i) => (
        <div key={`${r.label}:${i}`} style={{ display: 'flex', gap: '10px', padding: '8px 0', borderTop: i ? '1px solid var(--line-soft)' : 'none' }}>
          <span style={{ width: '22px', flex: 'none', font: '600 10.5px var(--font-mono)' }}>{r.label}</span>
          <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
              <span style={{ fontWeight: '600' }}>{r.findings}</span>
              <span style={{ color: 'var(--ink-2)' }}>{r.detail}</span>
            </div>
            {r.segments.length ? (
              <div style={{ display: 'flex', gap: '2px' }}>
                {r.segments.map((s) => (
                  <span key={s.label} style={{ flex: Math.max(1, s.flex), display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '40px', height: '16px', borderRadius: '3px', background: BAR[s.kind].bg, color: BAR[s.kind].c, font: '500 9.5px var(--font-sans)', whiteSpace: 'nowrap' }}>
                    {s.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function Section({ section, on }: { section: PanelSectionView; on: InboxHandlers }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {section.rounds?.length ? <RoundBands rounds={section.rounds} /> : null}
      {section.checks?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {section.checks.map((c, i) => (
            <div key={`${c.label}:${i}`} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 0', borderTop: i ? '1px solid var(--line-soft)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '8px', height: '8px', flex: 'none', borderRadius: '50%', background: c.ok ? 'var(--ok)' : 'var(--attention)' }} />
                <span style={{ font: '600 11.5px var(--font-mono)' }}>{c.label}</span>
              </div>
              {c.detail ? <span style={{ paddingLeft: '16px', font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{c.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {section.parts?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {section.parts.map((p, i) => (
            <div key={`${p.ref}:${i}`} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0', borderTop: i ? '1px solid var(--line-soft)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-sidebar)', font: '400 10px var(--font-mono)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{p.ref}</span>
                <span style={{ whiteSpace: 'nowrap', color: 'var(--ink-2)' }}>{p.label}</span>
              </div>
              <textarea
                data-panel-reply={p.ref}
                value={p.body}
                onChange={(e) => on.outboundReply(p.ref, { body: e.target.value })}
                style={{ minHeight: '52px', padding: '7px 9px', border: '1px solid var(--line-strong)', borderRadius: '8px', background: 'var(--surface)', resize: 'vertical', font: '400 11px/1.6 var(--font-sans)', color: 'var(--ink)' }}
              />
              <span
                data-panel-resolve={p.ref}
                onClick={() => on.outboundReply(p.ref, { resolve: !p.resolve })}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer' }}
              >
                <span style={{ width: '24px', height: '14px', borderRadius: '7px', background: p.resolve ? 'var(--ink)' : 'var(--line-strong)', position: 'relative' }}>
                  <span style={{ position: 'absolute', top: '2px', left: p.resolve ? '12px' : '2px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--surface)' }} />
                </span>
                Resolve
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {!section.rounds?.length && !section.checks?.length && !section.parts?.length ? (
        <>
          {section.heading ? <span style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-2)', paddingBottom: '4px' }}>{section.heading}</span> : null}
          {section.rows.map((r, j) => (
            <div key={`${r.label}:${j}`} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span style={{ width: '64px', flex: 'none', font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{r.label}</span>
              <span style={{ flex: '1', color: 'var(--ink)' }}>{r.value}</span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  )
}

export function InboxPanel({ panel, on = NO_HANDLERS, consult }: { panel: InboxPanelView; on?: InboxHandlers; consult?: ConsultView }) {
  const activeTab = panel.tabs.find((t) => t.active)
  const sections = activeTab ? panel.sections.filter((s) => s.tab === activeTab.label) : panel.sections
  const stepper = panel.cardKind === 'question'
  const asking = Boolean(consult?.active)
  const noteInput = panel.noteInput
  return (
    <div style={{ flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '8px', overflow: 'hidden', fontFamily: 'var(--font-sans)', color: 'var(--ink)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', height: '34px', padding: '0 12px', borderBottom: '1px solid var(--line-soft)', flex: 'none' }}>
        <span style={{ padding: '1px 7px', borderRadius: '4px', background: panel.chipBg, color: panel.chipC, font: '600 10px var(--font-mono)', whiteSpace: 'nowrap' }}>{panel.chip}</span>
        <span style={{ font: '500 11.5px var(--font-sans)' }}>{panel.lane}</span>
        {panel.state ? <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{panel.state}</span> : null}
        <span style={{ flex: '1' }} />
        {panel.sourceUrl ? <a href={panel.sourceUrl} target="_blank" rel="noreferrer" style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)', whiteSpace: 'nowrap', flex: 'none' }}>{panel.source}</a> : panel.source ? <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)', whiteSpace: 'nowrap', flex: 'none' }}>{panel.source}</span> : null}
      </div>
      {panel.tabs.length && stepper ? (
        <div style={{ display: 'flex', gap: '2px', padding: '6px 10px', borderBottom: '1px solid var(--line-soft)', flex: 'none' }}>
          {panel.tabs.map((t) => (
            <span key={t.label} onClick={t.go} style={{ flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '1px', padding: '5px 8px', borderRadius: '6px', cursor: 'pointer', background: t.active ? 'var(--line-soft)' : 'transparent' }}>
              <span style={{ display: 'flex', gap: '5px', color: t.active ? 'var(--ink)' : 'var(--ink-3)', font: '500 10.5px var(--font-sans)' }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{t.label}</span>
                <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t.note}</span>
              </span>
            </span>
          ))}
        </div>
      ) : panel.tabs.length ? (
        <div style={{ display: 'flex', gap: '14px', height: '32px', alignItems: 'flex-end', padding: '0 14px', borderBottom: '1px solid var(--line-soft)', font: '500 11px var(--font-sans)', color: 'var(--ink-3)', flex: 'none' }}>
          {panel.tabs.map((t) => (
            <span key={t.label} onClick={t.go} style={{ paddingBottom: '8px', whiteSpace: 'nowrap', cursor: 'pointer', color: t.active ? 'var(--ink)' : 'var(--ink-3)', borderBottom: t.active ? '1.5px solid var(--ink)' : 'none' }}>
              {t.label}{t.count ? ` ${t.count}` : ''}
            </span>
          ))}
        </div>
      ) : null}
      <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', overflow: 'auto', font: '400 11px/1.6 var(--font-sans)' }}>
        {panel.body ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit' }}>{panel.body}</pre> : null}
        {sections.map((s, i) => (
          <Section key={`${s.heading}:${i}`} section={s} on={on} />
        ))}
        {asking && consult ? (
          <div data-part="consult" style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', borderRadius: '9px', background: 'var(--bg-sidebar)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>{consult.heading}</span>
              <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{consult.count}</span>
              <span style={{ flex: '1' }} />
            </div>
            {consult.lines.map((line, index) => (
              <div key={index} data-consult-line={line.role} style={{ display: 'flex', flexDirection: 'column', gap: '1px', alignSelf: line.role === 'you' ? 'flex-end' : 'flex-start', maxWidth: '100%' }}>
                <span style={{ font: '500 9.5px var(--font-sans)', color: 'var(--ink-3)' }}>{line.role === 'you' ? 'あなた' : 'AI'}</span>
                <span style={{ padding: '5px 9px', borderRadius: '8px', background: line.role === 'you' ? 'var(--line-soft)' : 'var(--surface)', font: '400 11px/1.6 var(--font-sans)', whiteSpace: 'pre-wrap' }}>{line.text}</span>
              </div>
            ))}
            {consult.empty ? <span data-part="consult-empty" style={{ font: '400 10.5px/1.6 var(--font-sans)', color: 'var(--ink-3)' }}>{consult.empty}</span> : null}
            {consult.error ? <span data-part="consult-error" style={{ font: '400 10.5px/1.6 var(--font-sans)', color: 'var(--attention-text)' }}>{consult.error}</span> : null}
          </div>
        ) : null}
        {panel.choices?.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 10px 8px', borderRadius: '9px', background: 'var(--surface-warm)', boxShadow: 'inset 0 0 0 1px var(--surface-warm-line)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 4px' }}>
              <span style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>選択肢 {panel.choices.length}</span>
            </div>
            {panel.choices.map((c) => (
              <div key={c.index} style={{ display: 'flex', flexDirection: 'column', gap: '3px', padding: '7px 0 7px 8px', borderBottom: '1px solid var(--surface-warm-line)', boxShadow: 'inset 2px 0 0 var(--ink)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <span style={{ font: '500 10px var(--font-mono)', color: 'var(--ink-3)' }}>{c.index}</span>
                  <span style={{ fontWeight: '600' }}>{c.label}</span>
                  {c.badge ? <span style={{ padding: '1px 7px', borderRadius: '4px', background: c.badgeBg, color: c.badgeC, font: '600 10px var(--font-sans)', whiteSpace: 'nowrap' }}>{c.badge}</span> : null}
                </div>
                {c.description ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr)', rowGap: '1px', fontSize: '10.5px', color: 'var(--ink-2)' }}>
                    <span style={{ color: 'var(--ok-text)' }}>+</span>
                    <span>{c.description}</span>
                    {c.rationale ? <span style={{ color: 'var(--ink-3)' }}>·</span> : null}
                    {c.rationale ? <span>{c.rationale}</span> : null}
                  </div>
                ) : c.rationale ? (
                  <span style={{ fontSize: '10.5px', color: 'var(--ink-2)', paddingLeft: '17px' }}>{c.rationale}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {noteInput ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 10px 8px', minHeight: '36px', padding: '0 8px 0 12px', border: '1px solid var(--line-strong)', borderRadius: '9px', flex: 'none' }}>
          <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{noteInput.label}</span>
          <input
            data-panel-note-input
            data-note-input
            value={noteInput.value}
            placeholder={noteInput.placeholder}
            onChange={(e) => on.note(e.target.value)}
            onFocus={() => on.openNote()}
            onKeyDown={(e) => {
              // while the consultation is the one being written, Enter sends into it and never answers the card (C-154-3)
              if (!consult || !sendsConsultation(asking, { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return
              e.preventDefault()
              if (noteInput.value.trim()) consult.ask()
            }}
            style={{ flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 11.5px var(--font-sans)', color: 'var(--ink)' }}
          />
          <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{noteInput.hint}</span>
        </div>
      ) : null}
      {asking && consult ? (
        <div data-part="consult-row" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 10px 8px', minHeight: '34px', padding: '0 6px 0 11px', border: '1px solid var(--line-strong)', borderRadius: '9px', flex: 'none' }}>
          <span data-consult-keep={consult.canPromote ? 'on' : 'off'} onClick={consult.canPromote ? consult.keep : undefined} style={{ padding: '1px 6px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)', whiteSpace: 'nowrap', cursor: consult.canPromote ? 'pointer' : 'default', opacity: consult.canPromote ? 1 : 0.5 }}>{consult.labels.keep}</span>
          {consult.promoting ? <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)' }}>…</span> : null}
          {consult.promoteError ? <span data-consult-promote-error style={{ font: '400 10px/1.4 var(--font-sans)', color: 'var(--attention-text)' }}>{consult.promoteError}</span> : null}
          <span style={{ flex: '1' }} />
          <span data-consult-back onClick={consult.backToAnswer} style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)', cursor: 'pointer' }}>{consult.labels.back}</span>
        </div>
      ) : (
        <div
          data-part="ask-row"
          onClick={panel.cardKind === 'question' && consult ? consult.openAsk : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 10px 8px', minHeight: '34px', padding: '0 6px 0 11px', borderRadius: '9px', border: '1px solid var(--line-strong)', background: 'var(--surface)', flex: 'none', font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)', cursor: panel.cardKind === 'question' && consult ? 'pointer' : 'default' }}
          className={panel.cardKind === 'question' && consult ? 'hv15' : undefined}
        >
          {(consult?.labels.open) ?? 'この card について聞く'}
          <span style={{ flex: '1' }} />
          <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)' }}>会話に残せる</span>
          <span style={{ width: '24px', height: '24px', borderRadius: '7px', background: 'var(--ink-2)', color: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '600 11px var(--font-sans)' }}>↑</span>
        </div>
      )}
    </div>
  )
}
