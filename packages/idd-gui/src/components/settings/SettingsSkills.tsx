// Skills · MCP · Search: the skills a conversation may turn on and the two features, all from
// `/api/conversation-settings`. A press reaches the engine and the row becomes the engine's answer (AC-001).
// The rows the engine has no door for (a file access scope, one row per MCP server) keep neither place nor
// value (C-171-2); MCP is one switch, as the engine's own setting is.
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'

function Toggle({ on, press, label }: { on: boolean; press: () => void; label: string }) {
  return (
    <span
      onClick={press}
      role="switch"
      aria-checked={on}
      aria-label={label}
      style={{ flex: 'none', width: '30px', height: '17px', borderRadius: '9px', background: on ? 'var(--ink)' : 'var(--line-strong)', position: 'relative', cursor: 'pointer' }}
      className="hv7"
    >
      <span style={{ position: 'absolute', right: on ? '2px' : undefined, left: on ? undefined : '2px', top: '2px', width: '13px', height: '13px', borderRadius: '50%', background: 'var(--surface)' }} />
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

function NameAndNote({ name, note, mono }: { name: string; note: string; mono?: boolean }) {
  return (
    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
      <span style={{ font: mono ? '500 12.5px var(--font-mono)' : '500 12.5px var(--font-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {note ? <span style={{ font: '400 11px var(--font-sans)', color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span> : null}
    </div>
  )
}

export function SettingsSkills({ m }: { m: Model }) {
  const { secSkills, set } = m
  const { skills } = set
  return (
    <>
      {secSkills ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
          {skills.error ? (
            <span data-settings-error style={{ font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }}>{skills.error}</span>
          ) : null}

          {skills.groups.map((group) => (
            <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>{group.title}</span>
              <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
                {group.rows.map((row, index) => (
                  <Row key={row.key} last={index === group.rows.length - 1}>
                    <NameAndNote name={row.name} note={row.description} mono />
                    <Toggle on={row.on} press={row.press} label={row.name} />
                  </Row>
                ))}
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }}>MCP · Web search</span>
            <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }}>
              <Row>
                <NameAndNote name={WORDS.settings.skills.mcp} note={WORDS.settings.skills.mcpNote} />
                <Toggle on={skills.mcp} press={skills.pressMcp} label={WORDS.settings.skills.mcp} />
              </Row>
              <Row last>
                <NameAndNote name={WORDS.settings.skills.webSearch} note={WORDS.settings.skills.webSearchNote} />
                <Toggle on={skills.webSearch} press={skills.pressWebSearch} label={WORDS.settings.skills.webSearch} />
              </Row>
            </div>
          </div>

          {!skills.loaded && !skills.error ? (
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.loading}</span>
          ) : null}
          {skills.empty ? (
            <span style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.settings.skills.empty}</span>
          ) : null}
          {skills.runningNote ? (
            <span data-settings-running style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{skills.runningNote}</span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
