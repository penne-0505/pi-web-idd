// Appearance: the three rows whose meaning is decided are wired (Font size, Reduce motion, Arrow keys send
// cards); they take effect at once and are kept in this browser (C-171-5, C-171-6). The rows whose meaning is
// not decided — the dark theme, Density, Sidebar sort — keep the prototype's place and say they cannot be
// handled yet, and pressing them changes nothing: a dark palette has no values to compare, Density is not drawn
// in the prototype, and a sidebar order the screen chose would disagree with the engine (C-171-6).
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'

function Toggle({ on, press, label }: { on: boolean; press: () => void; label: string }) {
  return (
    <span
      onClick={press}
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-appearance-toggle={label}
      style={{ flex: 'none', width: '30px', height: '17px', borderRadius: '9px', background: on ? 'var(--ink)' : 'var(--line-strong)', position: 'relative', cursor: 'pointer' }}
      className="hv7"
    >
      <span style={{ position: 'absolute', right: on ? '2px' : undefined, left: on ? undefined : '2px', top: '2px', width: '13px', height: '13px', borderRadius: '50%', background: 'var(--surface)' }} />
    </span>
  )
}

/** the options of a row that is not wired yet: the prototype's own labels, none of which may be pressed */
function NotYetChips({ options }: { options: string[] }) {
  return (
    <span style={{ display: 'flex', gap: '1px', padding: '2px', background: 'var(--line-soft)', borderRadius: '6px', font: '500 11px var(--font-sans)' }}>
      {options.map((option, index) => (
        <span key={option} style={{ padding: '3px 9px', borderRadius: '4px', background: index === 0 ? 'var(--surface)' : 'transparent', color: index === 0 ? 'var(--ink)' : 'var(--ink-3)' }}>
          {option}
        </span>
      ))}
    </span>
  )
}

function Row({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '48px', padding: '8px 14px', borderBottom: last ? undefined : '1px solid var(--bg-sidebar)', boxSizing: 'border-box' }}>
      {children}
    </div>
  )
}

function Label({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
      <span style={{ font: '500 12.5px var(--font-sans)' }}>{title}</span>
      {note ? <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{note}</span> : null}
    </div>
  )
}

function NotYet() {
  return <span data-appearance-not-yet style={{ flex: 'none', padding: '1px 7px', borderRadius: '4px', background: 'var(--bg-sidebar)', font: '500 10px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.notYet}</span>
}

export function SettingsAppearance({ m }: { m: Model }) {
  const { secView, ap } = m
  return (
    <>
      {secView ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>Appearance</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              <Row>
                <Label title={WORDS.settings.appearance.theme} />
                <NotYetChips options={[WORDS.settings.appearance.themeLight, WORDS.settings.appearance.themeDark, WORDS.settings.appearance.themeSystem]} />
                <NotYet />
              </Row>
              <Row>
                <Label title={WORDS.settings.appearance.density} />
                <NotYetChips options={[WORDS.settings.appearance.densityComfortable, WORDS.settings.appearance.densityDefault, WORDS.settings.appearance.densityCompact]} />
                <NotYet />
              </Row>
              <Row last>
                <Label title={WORDS.settings.appearance.font} />
                <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="range"
                    min={12}
                    max={16}
                    step={1}
                    value={ap.fontPx}
                    onChange={(e) => ap.setFont(Number(e.target.value))}
                    aria-label={WORDS.settings.appearance.font}
                    style={{ width: '140px', accentColor: 'var(--ink)' }}
                  />
                  <span data-appearance-font style={{ font: '400 11px var(--font-mono)', color: 'var(--ink-2)', width: '34px' }}>{ap.fontPx}px</span>
                </span>
              </Row>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>Motion</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              <Row last>
                <Label title={WORDS.settings.appearance.reduceMotion} note={WORDS.settings.appearance.reduceMotionNote} />
                <Toggle on={ap.reduceMotion} press={ap.toggleMotion} label={WORDS.settings.appearance.reduceMotion} />
              </Row>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>Inbox</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              <Row>
                <Label title={WORDS.settings.appearance.arrowKeys} note={WORDS.settings.appearance.arrowKeysNote} />
                <Toggle on={ap.arrowKeys} press={ap.toggleArrowKeys} label={WORDS.settings.appearance.arrowKeys} />
              </Row>
              <Row last>
                <Label title={WORDS.settings.appearance.sidebarSort} />
                <NotYetChips options={[WORDS.settings.appearance.sidebarWait, WORDS.settings.appearance.sidebarSeverity]} />
                <NotYet />
              </Row>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
