// A section the engine has no door for. The row keeps the prototype's place (so the sheet's shape does not
// change) but carries no sample value and no control: it says it cannot be handled yet (C-171-1).
import { WORDS } from '../../strings'

export function SettingsUnsupported() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
          <div data-settings-unsupported style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '48px', padding: '8px 14px', boxSizing: 'border-box' }}>
            <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
              <span style={{ font: '500 12.5px var(--font-sans)' }}>{WORDS.settings.notYet}</span>
              <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.notYetBody}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
