// Model のピッカー。今の model の名は engine の応答から出し、候補は engine が返したものだけを検索して出す
// (DEC-118-1、DEC-103-1)。能力の正方形は pi の定義にある画像と推論だけ (DEC-118-2)。
import { Fragment, useState } from 'react'
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'

/** the provider a candidate belongs to, in the order the engine listed them */
function providers(m: Model): string[] {
  const out: string[] = []
  for (const option of m.chat.input.model.options) if (!out.includes(option.id.split('/')[0] ?? '')) out.push(option.id.split('/')[0] ?? '')
  return out
}

export function ModelPicker({ m }: { m: Model }) {
  const models = m.chat.input.model
  const [open, setOpen] = useState(false)
  const shown = models.options
  const groups = providers(m)

  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span
        onClick={() => setOpen(!open)}
        data-part="model-button"
        style={{ display: 'flex', alignItems: 'center', gap: '5px', height: '24px', padding: '0 8px', borderRadius: '6px', cursor: 'pointer', background: open ? 'var(--line-soft)' : 'transparent' }}
        className="hv11"
      >
        <span style={{ font: '500 11px var(--font-sans)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{models.label}</span>
        <span style={{ fontSize: '8px', color: 'var(--ink-3)' }}>▾</span>
      </span>
      {open ? (
        <div data-part="model-popover" style={{ position: 'absolute', bottom: '32px', right: '120px', zIndex: '4', width: '300px', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', boxShadow: 'var(--shadow-pop)', animation: 'plift 120ms var(--ease-out) both', overflow: 'hidden' }}>
          <input
            data-part="model-search"
            value={models.query}
            placeholder={WORDS.chat.modelSearch}
            onChange={(event) => models.setQuery(event.target.value)}
            style={{ height: '34px', padding: '0 12px', border: 'none', borderBottom: '1px solid var(--line-soft)', background: 'transparent', outline: 'none', font: '400 11.5px var(--font-sans)', color: 'var(--ink)' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', padding: '6px', maxHeight: '320px', overflow: 'auto' }}>
            {groups.map((provider) => (
              <Fragment key={provider}>
                <span style={{ padding: '6px 8px 4px', font: '500 10px var(--font-sans)', color: 'var(--ink-3)' }}>{provider}</span>
                {shown.filter((option) => (option.id.split('/')[0] ?? '') === provider).map((option) => (
                  <div
                    key={option.id}
                    data-model={option.id}
                    onClick={option.go}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '36px', padding: '4px 8px', borderRadius: '6px', cursor: 'pointer', background: option.active ? 'var(--bg-inbox)' : 'transparent' }}
                    className="hv12"
                  >
                    <div style={{ flex: '1', display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }}>
                      <span style={{ font: '500 12.5px var(--font-sans)', color: 'var(--ink)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{option.name}</span>
                      <span style={{ flex: '1' }} />
                      <span style={{ display: 'flex', gap: '3px' }}>
                        {option.capabilities.map((capability) => (
                          <span
                            key={capability}
                            title={WORDS.chat.capability[capability]}
                            data-capability={capability}
                            style={{
                              width: '18px', height: '18px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: capability === 'image' ? 'var(--cap-vision-bg)' : 'var(--cap-tool-bg)',
                              font: '600 9px/1 var(--font-mono)',
                              color: capability === 'image' ? 'var(--cap-vision-line)' : 'var(--cap-tool-line)',
                            }}
                          >
                            {capability === 'image' ? '◉' : '{}'}
                          </span>
                        ))}
                      </span>
                    </div>
                    <span style={{ font: '400 10px var(--font-mono)', color: 'var(--ink-3)' }}>{option.window}</span>
                    <span style={{ width: '12px', font: '600 12px var(--font-sans)', color: 'var(--ink)' }}>{option.active ? '✓' : ''}</span>
                  </div>
                ))}
              </Fragment>
            ))}
            {!shown.length ? <span data-part="model-empty" style={{ padding: '10px 8px', font: '400 11px var(--font-sans)', color: 'var(--ink-2)' }}>{models.empty}</span> : null}
          </div>
        </div>
      ) : null}
    </span>
  )
}
