// Settings: the section's title and the way out. The lane stages section no longer offers to open lanes.toml —
// this screen has no door for that file, so the button would be a control that does nothing (C-171-1).
import type { Model } from '../../model/model'

export function SettingsHeader({ m }: { m: Model }) {
  const { closeSettings, secTitle } = m
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ font: '600 17px var(--font-sans)' }}>
          {secTitle}
        </span>
        <span style={{ flex: '1' }} />
        <span onClick={closeSettings} title="Close (Esc)" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px', borderRadius: '6px', cursor: 'pointer', font: '400 14px var(--font-sans)', color: 'var(--ink-2)' }} className="hv7">
          ×
          <span style={{ padding: '0 5px', border: '1px solid var(--line-strong)', borderBottomWidth: '2px', borderRadius: '3px', font: '500 9.5px/15px var(--font-mono)', color: 'var(--ink-3)' }}>
            Esc
          </span>
        </span>
      </div>
    </>
  )
}
