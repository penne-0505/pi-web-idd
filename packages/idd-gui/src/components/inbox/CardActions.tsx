// The card's operation row: the same four positions the prototype fixes (left / read / later / right), filled from
// the key meanings the Inbox's own `keymap` decided. The right end can be split: the second button is the ⇧→
// operation (a stuck card's 自分で直す) and shows no key of its own (q3 / q5).
import type { ActionRow, CardActionView } from '../../inbox/viewmodel'

function KeyCap({ children }: { children: string }) {
  return (
    <span style={{ padding: '0 5px', border: '1px solid var(--line-strong)', borderBottomWidth: '2px', borderRadius: '3px', font: '500 9.5px/15px var(--font-mono)', color: 'var(--ink-2)' }}>{children}</span>
  )
}

function LeftButton({ b }: { b: CardActionView }) {
  return (
    <span onClick={b.disabled ? undefined : b.go} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 16px', font: '500 12.5px var(--font-sans)', cursor: 'pointer', whiteSpace: 'nowrap', opacity: b.disabled ? '.5' : '1' }} className="hv5">
      {b.key ? <KeyCap>{b.key}</KeyCap> : null}
      {b.label}
    </span>
  )
}

export function CardActions({ actions }: { actions: ActionRow }) {
  const read = actions.middle
  const right = actions.right
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' }}>
      {actions.left.length || read.length ? (
        <span style={{ display: 'flex', alignItems: 'stretch', borderRadius: '999px', border: '1px solid var(--line-strong)', background: 'var(--surface)', overflow: 'hidden' }}>
          {actions.left.map((b, i) => (
            <span key={`${b.label}:${i}`} style={{ display: 'flex', alignItems: 'stretch' }}>
              {i ? <span style={{ width: '1px', background: 'var(--line)' }} /> : null}
              <LeftButton b={b} />
            </span>
          ))}
          {read.map((b, i) => (
            <span key={`${b.label}:r${i}`} style={{ display: 'flex', alignItems: 'center' }}>
              {actions.left.length || i ? <span style={{ width: '1px', background: 'var(--line)' }} /> : null}
              <span onClick={b.disabled ? undefined : b.go} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 10px', font: '500 12.5px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {b.label}
                {/* only the first reading operation shows the space key; a second one (聞く) shows none, like a split */}
                {i === 0 ? (
                  <span title="Space" style={{ display: 'inline-flex', alignItems: 'flex-end', justifyContent: 'center', width: '22px', height: '17px', paddingBottom: '3px', boxSizing: 'border-box', border: '1px solid var(--line-strong)', borderBottomWidth: '2px', borderRadius: '3px' }}>
                    <span style={{ width: '10px', height: '4px', border: '1.3px solid var(--ink-2)', borderTop: 'none', boxSizing: 'border-box' }} />
                  </span>
                ) : null}
              </span>
            </span>
          ))}
        </span>
      ) : null}
      {actions.later ? (
        <span onClick={actions.later.disabled ? undefined : actions.later.go} style={{ display: 'flex', flex: 'none', alignItems: 'center', gap: '6px', padding: '9px 10px', font: '500 12.5px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer', opacity: actions.later.disabled ? '.5' : '1', whiteSpace: 'nowrap' }}>
          {actions.later.label}
          {actions.later.key ? <KeyCap>{actions.later.key}</KeyCap> : null}
        </span>
      ) : null}
      {right.length ? (
        <span style={{ display: 'flex', alignItems: 'stretch', borderRadius: '999px', background: right[0].disabled ? 'var(--mute-2)' : right[0].sign ? 'var(--sign)' : 'var(--ink)', color: 'var(--surface)', overflow: 'hidden' }}>
          {right.map((b, i) => (
            <span key={`${b.label}:p${i}`} style={{ display: 'flex', alignItems: 'stretch' }}>
              {i ? <span style={{ width: '1px', background: 'var(--key-line-on-dark)' }} /> : null}
              <span onClick={b.disabled ? undefined : b.go} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 22px', font: '600 12.5px var(--font-sans)', cursor: 'pointer', whiteSpace: 'nowrap', opacity: b.disabled ? '.7' : '1' }}>
                {/* the ring marks the operation that reaches a signature; a disabled or non-signing one wears none (C-154-1) */}
                {i === 0 && b.sign && !b.disabled ? <span style={{ width: '10px', height: '10px', border: '1.8px solid var(--surface)', borderRadius: '50%', boxSizing: 'border-box' }} /> : null}
                {b.label}
                {b.key ? <KeyCap>{b.key}</KeyCap> : null}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  )
}
