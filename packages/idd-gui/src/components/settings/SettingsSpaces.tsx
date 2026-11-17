// Spaces: the conversation spaces of a mode's workspace, from
// `/api/conversations/workspaces/:mode/spaces`. The list, the creation and the editing all carry the engine's
// own values (AC-002). The repo rows the prototype drew (worktree path, base branch, merge strategy, the lane
// count) are not drawn: this screen has no door for the repo's settings (C-171-4), and a save sends only the
// fields the person changed, so a field the sheet never read is never overwritten.
import type { Model } from '../../model/model'
import type { MemoryOption } from '../../settings/viewmodel'
import { WORDS } from '../../strings'

const FIELD_STYLE = {
  background: 'var(--bg-page)',
  border: '1px solid var(--line)',
  borderRadius: '6px',
  padding: '6px 9px',
  font: '400 12px var(--font-sans)',
  color: 'var(--ink)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
} as const

function Field({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' }}>
      <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>
        {label}
        {note ? <span style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}> · {note}</span> : null}
      </span>
      {children}
    </label>
  )
}

function MemoryChips({ options }: { options: MemoryOption[] }) {
  return (
    <span style={{ display: 'flex', gap: '1px', padding: '2px', background: 'var(--line-soft)', borderRadius: '6px', font: '500 11px var(--font-sans)', width: 'fit-content' }}>
      {options.map((option) => (
        <span
          key={option.value}
          onClick={option.press}
          style={{ padding: '3px 9px', borderRadius: '4px', cursor: 'pointer', background: option.active ? 'var(--surface)' : 'transparent', color: option.active ? 'var(--ink)' : 'var(--ink-3)' }}
          className="hv7"
        >
          {option.label}
        </span>
      ))}
    </span>
  )
}

export function SettingsSpaces({ m }: { m: Model }) {
  const { secSpaces, set } = m
  const { spaces } = set
  const { editor } = spaces
  return (
    <>
      {secSpaces ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
          {spaces.error ? (
            <span data-settings-error style={{ font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }}>{spaces.error}</span>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>{WORDS.settings.spaces.workspace}</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              {spaces.modes.map((mode, index) => (
                <div key={mode.mode} onClick={mode.press} style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '44px', padding: '8px 14px', borderBottom: index === spaces.modes.length - 1 ? undefined : '1px solid var(--bg-sidebar)', boxSizing: 'border-box', cursor: 'pointer', background: mode.active ? 'var(--line-soft)' : 'transparent' }} className="hv7">
                  <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
                    <span style={{ font: '500 12.5px var(--font-sans)' }}>{mode.label}</span>
                    <span style={{ font: '400 11px var(--font-mono)', color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mode.mode}</span>
                  </div>
                  {mode.active ? (
                    <span style={{ flex: 'none', padding: '1px 7px', borderRadius: '4px', background: 'var(--line-soft)', font: '500 10px var(--font-sans)', color: 'var(--ink-2)' }}>今</span>
                  ) : null}
                </div>
              ))}
              {spaces.workspace ? (
                <div style={{ padding: '8px 14px', font: '400 11px var(--font-mono)', color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderTop: '1px solid var(--bg-sidebar)' }}>{spaces.workspace}</div>
              ) : null}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>Spaces</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              {spaces.rows.map((row) => (
                <div key={row.id} onClick={row.press} style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '48px', padding: '8px 14px', borderBottom: '1px solid var(--bg-sidebar)', boxSizing: 'border-box', cursor: 'pointer', background: row.open ? 'var(--line-soft)' : 'transparent' }} className="hv7">
                  <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
                    <span style={{ font: '500 12.5px var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
                    <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.subtitle}</span>
                  </div>
                  <span style={{ flex: 'none', font: '500 11px var(--font-sans)', color: 'var(--sign-text-alt)' }}>{WORDS.settings.spaces.edit}</span>
                </div>
              ))}
              <div
                onClick={spaces.openNew}
                data-settings-add-space
                style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '48px', padding: '8px 14px', boxSizing: 'border-box', cursor: 'pointer', borderTop: spaces.rows.length ? '1px solid var(--bg-sidebar)' : undefined }}
                className="hv7"
              >
                <span style={{ font: '500 12.5px var(--font-sans)' }}>{spaces.addLabel}</span>
              </div>
            </div>
            {spaces.empty ? <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.spaces.empty}</span> : null}
          </div>

          {editor ? (
            <div data-settings-editor style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px' }}>
              <span style={{ font: '600 12px var(--font-sans)' }}>{editor.title}</span>
              <div style={{ display: 'grid', gridTemplateColumns: editor.idEditable ? '1fr 1fr' : '1fr', gap: '10px' }}>
                {editor.idEditable ? (
                  <Field label={WORDS.settings.spaces.id} note={WORDS.settings.spaces.idNote}>
                    <input data-settings-field="id" value={editor.idValue} onChange={(e) => spaces.setField('id', e.target.value)} style={FIELD_STYLE} />
                  </Field>
                ) : null}
                <Field label={WORDS.settings.spaces.name}>
                  <input data-settings-field="name" value={editor.name} onChange={(e) => spaces.setField('name', e.target.value)} style={FIELD_STYLE} />
                </Field>
              </div>
              <Field label={WORDS.settings.spaces.memory}>
                <MemoryChips options={editor.memoryOptions} />
              </Field>
              <Field label={WORDS.settings.spaces.references} note={WORDS.settings.spaces.referencesNote}>
                <textarea data-settings-field="references" value={editor.references} onChange={(e) => spaces.setField('references', e.target.value)} rows={3} style={{ ...FIELD_STYLE, font: '400 11.5px var(--font-mono)', resize: 'vertical' }} />
              </Field>
              <Field label={WORDS.settings.spaces.instruction}>
                <textarea data-settings-field="instruction" value={editor.instruction} onChange={(e) => spaces.setField('instruction', e.target.value)} placeholder={WORDS.settings.spaces.instructionPlaceholder} rows={4} style={{ ...FIELD_STYLE, resize: 'vertical' }} />
              </Field>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  onClick={editor.save}
                  data-settings-space-save
                  data-settings-space-dirty={editor.dirty ? 'true' : 'false'}
                  style={{ padding: '5px 11px', borderRadius: '6px', border: '1px solid var(--line-strong)', background: editor.dirty ? 'var(--ink)' : 'var(--surface)', color: editor.dirty ? 'var(--surface)' : 'var(--ink-3)', font: '500 11.5px var(--font-sans)', cursor: editor.dirty ? 'pointer' : 'default' }}
                >
                  {editor.editing === '' ? WORDS.settings.spaces.create : WORDS.settings.spaces.save}
                </span>
                <span onClick={editor.close} style={{ font: '500 11px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer' }}>{WORDS.settings.spaces.cancel}</span>
                {spaces.busy ? <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.spaces.saving}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
