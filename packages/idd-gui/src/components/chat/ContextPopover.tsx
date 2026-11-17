// Context のピッカー。使った量は pi の値、費用は会話の値、枠は quota の口の値で、どれも engine が返したもの
// (DEC-2012、DEC-103-1)。内訳と Compact は engine に値も専用の口も無いので出さない (DEC-1802)。
import { useState } from 'react'
import type { Model } from '../../model/model'
import type { ChatSettingsView, SettingsFeatureRowView, SettingsSkillRowView } from '../../chat/settings'
import { WORDS } from '../../strings'

/** the window's size in the words the popover uses; a missing reading is an em dash, never a guessed number */
function windowLine(tokens: number | null, contextWindow: number | null): string {
  if (tokens === null || contextWindow === null) return WORDS.chat.context.none
  return `${tokens.toLocaleString()} / ${contextWindow.toLocaleString()}`
}

/**
 * One row's value line: what the open conversation's pi holds now, and — only when it differs — what the next
 * pi of this conversation will get. The switch beside it is the settings value; the two are never merged into
 * one number, and a pi whose start was not answered reads as unknown rather than as off (C-174-3). A
 * conversation whose start never reads the settings at all draws neither value: it says so in one line.
 */
function valueLine(effective: boolean | null, next: boolean, differs: boolean, applies: boolean | null): string {
  if (applies === false) return WORDS.chat.settings.notReceived
  const now = effective === null ? WORDS.chat.settings.effectiveUnknown : WORDS.chat.settings.effectiveNow(effective)
  return differs ? `${now} · ${WORDS.chat.settings.nextFrom(next)}` : now
}

/** the row's own fact: whether the settings reach this conversation's next start (on), never (off), or unknown */
function appliesMark(applies: boolean | null): string {
  return applies === null ? 'unknown' : applies ? 'on' : 'off'
}

function Switch({ on, busy, press, part, id }: { on: boolean; busy: boolean; press: () => void; part: string; id: string }) {
  return (
    <span
      data-part={part}
      data-toggle={id}
      data-on={on ? 'on' : 'off'}
      onClick={() => {
        if (!busy) press()
      }}
      style={{ flex: 'none', width: '30px', height: '17px', borderRadius: '9px', background: on ? 'var(--ink)' : 'var(--line-strong)', position: 'relative', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
    >
      <span style={{ position: 'absolute', ...(on ? { right: '2px' } : { left: '2px' }), top: '2px', width: '13px', height: '13px', borderRadius: '50%', background: 'var(--surface)' }} />
    </span>
  )
}

function SkillRow({ row, busy, applies }: { row: SettingsSkillRowView; busy: boolean; applies: boolean | null }) {
  return (
    <div data-part="settings-skill" data-skill={row.path} data-on={row.on ? 'on' : 'off'} data-effective={row.effective === null ? 'unknown' : row.effective ? 'on' : 'off'} data-applies={appliesMark(applies)} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
        <span style={{ font: '500 12px var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.name}</span>
        {row.description ? <span style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{row.description}</span> : null}
        <span data-part="settings-effective" style={{ font: '400 10px var(--font-sans)', color: row.differs && applies !== false ? 'var(--attention-text)' : 'var(--ink-3)' }}>
          {valueLine(row.effective, row.next, row.differs, applies)}
          {row.foreign ? ` · ${WORDS.chat.settings.foreign}` : ''}
        </span>
      </div>
      <Switch on={row.on} busy={busy} press={row.toggle} part="settings-skill-switch" id={row.path} />
    </div>
  )
}

function FeatureRow({ row, busy, applies }: { row: SettingsFeatureRowView; busy: boolean; applies: boolean | null }) {
  return (
    <div data-part="settings-feature" data-feature={row.key} data-on={row.on ? 'on' : 'off'} data-effective={row.effective === null ? 'unknown' : row.effective ? 'on' : 'off'} data-applies={appliesMark(applies)} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
        <span style={{ font: '500 12px var(--font-sans)' }}>{row.label}</span>
        <span style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{row.detail}</span>
        <span data-part="settings-effective" style={{ font: '400 10px var(--font-sans)', color: row.differs && applies !== false ? 'var(--attention-text)' : 'var(--ink-3)' }}>{valueLine(row.effective, row.next, row.differs, applies)}</span>
      </div>
      <Switch on={row.on} busy={busy} press={row.toggle} part="settings-feature-switch" id={row.key} />
    </div>
  )
}

/**
 * The conversation's own switch for the engine settings. The switch is the value every conversation's next pi
 * reads, so the section says so; what the open conversation's pi was started with is on every row beside it.
 */
export function ConversationSettings({ view }: { view: ChatSettingsView }) {
  return (
    <div data-part="context-settings" style={{ display: 'flex', flexDirection: 'column', gap: '9px', padding: '11px 14px 13px', borderTop: '1px solid var(--line-soft)', maxHeight: '380px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ font: '600 11.5px var(--font-sans)' }}>{WORDS.chat.settings.title}</span>
        <span style={{ flex: '1' }} />
        {view.busy ? <span data-part="settings-busy" style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>…</span> : null}
      </div>
      <span data-part="settings-scope" style={{ font: '400 10.5px/1.5 var(--font-sans)', color: 'var(--ink-2)' }}>{view.scopeNote}</span>
      {view.error ? <span data-part="settings-error" style={{ font: '400 10.5px/1.5 var(--font-sans)', color: 'var(--attention-text)' }}>{view.error}</span> : null}
      {view.loading && !view.groups.length && !view.features.length ? <span data-part="settings-loading" style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.chat.settings.loading}</span> : null}
      {view.empty ? <span data-part="settings-empty" style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.chat.settings.empty}</span> : null}
      {view.groups.map((group) => (
        <div key={group.origin} data-part="settings-group" data-origin={group.origin} style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>{group.label}</span>
          {group.rows.map((row) => <SkillRow key={row.path} row={row} busy={view.busy} applies={view.featuresApply} />)}
        </div>
      ))}
      {view.features.length ? (
        <div data-part="settings-group" data-origin="features" style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={{ font: '600 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>{WORDS.chat.settings.featureGroup}</span>
          {view.features.map((row) => <FeatureRow key={row.key} row={row} busy={view.busy} applies={view.featuresApply} />)}
        </div>
      ) : null}
      {view.path ? <span data-part="settings-file" style={{ font: '400 9.5px var(--font-mono)', color: 'var(--ink-3)', overflowWrap: 'anywhere' }}>{WORDS.chat.settings.file(view.path)}</span> : null}
    </div>
  )
}

export function ContextPopover({ m }: { m: Model }) {
  const context = m.chat.input.context
  const [open, setOpen] = useState(false)
  const percent = context.percent
  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) context.open()
        }}
        data-part="context-button"
        data-percent={percent ?? ''}
        style={{ display: 'flex', alignItems: 'center', gap: '5px', height: '24px', padding: '0 8px', borderRadius: '6px', cursor: 'pointer', background: open ? 'var(--line-soft)' : 'transparent' }}
        className="hv11"
      >
        <span style={{ position: 'relative', width: '12px', height: '12px', borderRadius: '50%', background: `conic-gradient(var(--ink) 0 ${percent ?? 0}%,var(--line) ${percent ?? 0}% 100%)` }}>
          <span style={{ position: 'absolute', inset: '3px', borderRadius: '50%', background: 'var(--bg-page)' }} />
        </span>
        <span style={{ font: '500 10.5px var(--font-mono)', color: 'var(--ink-2)' }}>{percent === null ? WORDS.chat.context.none : `${percent}%`}</span>
      </span>
      {open ? (
        <div data-part="context-popover" style={{ position: 'absolute', bottom: '32px', right: '0px', zIndex: '4', width: '300px', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', boxShadow: 'var(--shadow-pop)', animation: 'plift 120ms var(--ease-out) both', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 14px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={{ font: '600 12.5px var(--font-sans)' }}>Context</span>
              <span style={{ flex: '1' }} />
              <span data-part="context-window" style={{ font: '400 10.5px var(--font-mono)', color: 'var(--ink-2)' }}>{windowLine(context.tokens, context.contextWindow)}</span>
              <span style={{ font: '600 16px var(--font-mono)' }}>{percent === null ? WORDS.chat.context.none : `${percent}%`}</span>
            </div>
            <div style={{ height: '8px', borderRadius: '4px', overflow: 'hidden', background: 'var(--line-soft)' }}>
              <span style={{ display: 'block', width: `${percent ?? 0}%`, height: '100%', background: 'var(--ink)' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', font: '400 11px var(--font-sans)', color: 'var(--ink-2)' }}>
              <span style={{ flex: '1' }}>{WORDS.chat.context.cost}</span>
              <span data-part="context-cost" style={{ font: '400 11px var(--font-mono)', color: 'var(--ink)' }}>${context.cost.toFixed(4)}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', padding: '11px 14px 13px', borderTop: '1px solid var(--line-soft)', background: 'var(--bg-page)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={{ font: '600 11.5px var(--font-sans)' }}>Usage</span>
              <span style={{ flex: '1' }} />
              <span style={{ font: '400 10px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.chat.context.quota}</span>
            </div>
            {context.quota.length ? context.quota.map((provider) => (
              <div key={provider.provider} data-quota-provider={provider.provider} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>{provider.provider}</span>
                {provider.windows.map((window) => (
                  <div key={window.name} data-quota-window={window.name} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', font: '400 10.5px var(--font-sans)', color: 'var(--ink-2)' }}>
                      <span>{window.label}{provider.rejected ? ` · ${WORDS.chat.context.rejected}` : ''}</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(window.utilization * 100)}%</span>
                    </div>
                    <div style={{ height: '4px', borderRadius: '2px', background: 'var(--line)', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.round(window.utilization * 100)}%`, height: '100%', background: 'var(--ink-2)' }} />
                    </div>
                  </div>
                ))}
              </div>
            )) : (
              <span data-part="context-quota-empty" style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.chat.context.none}</span>
            )}
          </div>
          <ConversationSettings view={m.chatSettings} />
        </div>
      ) : null}
    </span>
  )
}
