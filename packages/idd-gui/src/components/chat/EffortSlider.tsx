// Effort のピッカー。段は今の model が受ける段だけで、当たっている値は engine が返したもの (DEC-118-3)。
// 押したときにだけ口を呼び、掴んでいる間は何も送らない。
import { useState } from 'react'
import type { Model } from '../../model/model'

export function EffortSlider({ m }: { m: Model }) {
  const effort = m.chat.input.effort
  const [open, setOpen] = useState(false)
  const levels = effort.levels
  const at = Math.max(0, levels.findIndex((level) => level.active))
  const ratio = levels.length > 1 ? at / (levels.length - 1) : 1

  return (
    <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <span
        onClick={() => setOpen(!open)}
        data-part="effort-button"
        style={{ display: 'flex', alignItems: 'center', gap: '5px', height: '24px', padding: '0 8px', borderRadius: '6px', cursor: 'pointer', background: open ? 'var(--line-soft)' : 'transparent' }}
        className="hv11"
      >
        <span style={{ display: 'flex', alignItems: 'flex-end', gap: '1.5px', height: '10px' }}>
          {levels.slice(0, 3).map((level, index) => (
            <span key={level.name} style={{ width: '2.5px', height: `${4 + index * 3}px`, borderRadius: '1px', background: index <= at ? 'var(--ink)' : 'var(--line-strong)' }} />
          ))}
        </span>
        <span style={{ font: '500 11px var(--font-sans)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{effort.label}</span>
      </span>
      {open && levels.length ? (
        <div data-part="effort-popover" style={{ position: 'absolute', bottom: '32px', right: '60px', zIndex: '4', width: '280px', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', boxShadow: 'var(--shadow-pop)', animation: 'plift 120ms var(--ease-out) both', overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px 16px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={{ font: '600 12.5px var(--font-sans)' }}>Effort</span>
              <span style={{ flex: '1' }} />
              <span style={{ font: '600 13px var(--font-sans)' }}>{effort.label}</span>
            </div>
            <div style={{ padding: '0 7px' }}>
              <div style={{ position: 'relative', height: '18px' }}>
                <span style={{ position: 'absolute', left: '0', right: '0', top: '7px', height: '4px', borderRadius: '2px', background: 'var(--line)' }} />
                <span style={{ position: 'absolute', left: '0', top: '7px', height: '4px', borderRadius: '2px', background: 'var(--ink)', width: `${ratio * 100}%` }} />
                {levels.map((level, index) => (
                  <span
                    key={level.name}
                    data-effort={level.name}
                    onClick={level.go}
                    style={{ position: 'absolute', left: `${levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0}%`, top: '0', width: '18px', height: '18px', marginLeft: '-9px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: index <= at ? 'var(--ink)' : 'var(--mute-2)' }} />
                  </span>
                ))}
                <span style={{ position: 'absolute', left: `${ratio * 100}%`, top: '1px', width: '16px', height: '16px', marginLeft: '-8px', borderRadius: '50%', background: 'var(--surface)', boxShadow: '0 0 0 1.5px var(--ink),var(--dial-shadow)', pointerEvents: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', font: '500 10.5px var(--font-sans)' }}>
              {levels.map((level, index) => (
                <span
                  key={level.name}
                  onClick={level.go}
                  style={{ width: '36px', textAlign: index === 0 ? 'left' : index === levels.length - 1 ? 'right' : 'center', color: level.active ? 'var(--ink)' : 'var(--ink-3)', cursor: 'pointer' }}
                >
                  {level.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </span>
  )
}
