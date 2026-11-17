// The Inbox's left sidebar: what the card cannot hold — the deck's puts-off, the holds, the ignore list and the
// running lanes — every row from `InboxSidebarView`, which the engine's state built. The put-off and sleeping
// cards come back from here (DEC-9187); the ignore list takes an Issue back off it. A section with no row is not
// drawn at all, heading included (C-154-9), and every long title stays on one line with its full text on hover and
// a short identity beside the mark (C-154-8).
import type { CSSProperties, ReactNode } from 'react'
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'

const HEADING: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', padding: '18px 8px 6px', font: '500 10.5px var(--font-sans)', color: 'var(--ink-2)' }
/** the first heading has no section above it, so it keeps the smaller top space the prototype gives it */
const HEADING_FIRST: CSSProperties = { ...HEADING, padding: '2px 8px 6px' }
const TITLE: CSSProperties = { flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }
const NUM: CSSProperties = { flex: 'none', font: '500 10px var(--font-mono)', color: 'var(--ink-3)' }
const ACTION: CSSProperties = { flex: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }

function Section({ title, first, aside, children }: { title: string; first?: boolean; aside?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div style={first ? HEADING_FIRST : HEADING}>
        {title}
        <span style={{ flex: '1' }} />
        {aside}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>{children}</div>
    </>
  )
}

export function InboxSidebar({ m }: { m: Model }) {
  const { goLanes } = m
  const s = m.inbox.sidebar
  return (
    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', padding: '10px 8px 0', overflow: 'auto' }}>
      {s.next.length ? (
        <Section title="次に来るもの" first aside={<span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>待ち時間</span>}>
          {s.next.map((n, i) => (
            <div key={`${n.ref}:${i}`} onClick={n.go} title={n.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '34px', padding: '0 8px', borderRadius: '6px', background: i === 0 ? 'var(--surface)' : 'transparent', boxShadow: i === 0 ? '0 0 0 1px var(--ink)' : 'none', font: i === 0 ? '500 12px var(--font-sans)' : '400 12px var(--font-sans)', cursor: 'pointer' }} className={i === 0 ? undefined : 'hv2'}>
              <span style={{ width: '16px', height: '16px', flex: 'none', borderRadius: '4px', background: n.markBg, color: n.markC, font: '700 9px/16px var(--font-mono)', textAlign: 'center' }}>{n.mark}</span>
              <span style={NUM}>{n.num}</span>
              <span data-sidebar-title style={TITLE}>{n.title}</span>
              <span style={{ display: 'flex', width: '28px', height: '3px', flex: 'none', borderRadius: '2px', background: 'var(--line)', overflow: 'hidden' }}>
                <span style={{ width: `${Math.round(Math.min(1, Math.max(0, n.progress)) * 100)}%`, background: n.progress >= 1 ? 'var(--attention)' : 'var(--ink-2)' }} />
              </span>
            </div>
          ))}
        </Section>
      ) : null}

      {s.later.length ? (
        <Section title={WORDS.sidebar.later}>
          {s.later.map((l) => (
            <div key={l.key} title={l.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 8px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)' }}>
              <span style={{ width: '16px', flex: 'none', textAlign: 'center', font: '500 10px var(--font-mono)' }}>{l.kind}</span>
              <span style={NUM}>{l.num}</span>
              <span data-sidebar-title style={TITLE}>{l.title}</span>
              <span onClick={l.wake} style={{ ...ACTION, color: 'var(--ink-2)', textDecoration: 'underline' }}>{WORDS.sidebar.wake}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {s.holds.length ? (
        <Section title={WORDS.sidebar.holds}>
          {s.holds.map((h, i) => (
            <div key={`${h.ref}:${i}`} title={h.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 8px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>
              <span style={NUM}>{h.ref}</span>
              <span data-sidebar-title style={TITLE}>{h.title}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {s.ignores.length ? (
        <Section title={WORDS.sidebar.ignores}>
          {s.ignores.map((g, i) => (
            <div key={`${g.ref}:${i}`} title={g.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 8px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>
              <span style={NUM}>{g.ref}</span>
              <span data-sidebar-title style={TITLE}>{g.title}</span>
              <span onClick={g.unignore} style={{ ...ACTION, textDecoration: 'underline' }}>{WORDS.sidebar.unignore}</span>
            </div>
          ))}
        </Section>
      ) : null}

      {s.running.length ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '22px 8px 6px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--ok)', animation: 'pulse 1.6s infinite' }} />
            <span style={{ font: '500 11px var(--font-sans)' }}>{WORDS.empty.runningTitle}</span>
            <span style={{ font: '500 11px var(--font-mono)', color: 'var(--ink-3)' }}>{s.running.length}</span>
          </div>
          <div onClick={goLanes} style={{ display: 'flex', flexDirection: 'column', gap: '1px', cursor: 'pointer', paddingBottom: '10px' }}>
            {s.running.map((r) => (
              <div key={r.id} title={r.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '28px', padding: '0 8px', borderRadius: '5px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }} className="hv2">
                <span style={NUM}>{r.num}</span>
                <span data-sidebar-title style={TITLE}>{r.title}</span>
                <span style={{ flex: 'none', font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{r.note}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {s.answered.length ? (
        <Section title="今日答えたもの">
          {s.answered.map((a, i) => (
            <div key={`${a.title}:${i}`} title={a.title} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '30px', padding: '0 8px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)' }}>
              <span style={{ width: '16px', flex: 'none', textAlign: 'center', font: '500 10px var(--font-mono)' }}>{a.mark}</span>
              <span style={NUM}>{a.num}</span>
              <span data-sidebar-title style={TITLE}>{a.title}</span>
              <span style={{ flex: 'none', padding: '1px 6px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{a.kind}</span>
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  )
}
