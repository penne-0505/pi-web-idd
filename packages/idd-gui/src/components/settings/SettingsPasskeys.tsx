// The passkeys section: the keys the engine has registered, the press that registers another one, and — on the
// local screen — the registrations a tailnet page added that wait for approval. Every row is the engine's answer
// (DEC-103-1). There is no list of the operations that ask for a signature and no switch for it: the engine decides
// that per approval (C-172-3). There is no press that removes a key either, because the engine has no door for it.
import { useEffect, useRef, useState } from 'react'
import type { Model } from '../../model/model'
import type { PasskeysView } from '../../settings/passkeys'
import { WORDS } from '../../strings'

const LABEL: React.CSSProperties = { font: '600 11px var(--font-sans)', color: 'var(--ink-2)' }
const LIST: React.CSSProperties = { display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden' }
const NOTE: React.CSSProperties = { font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }
const ERR: React.CSSProperties = { font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }
const INPUT: React.CSSProperties = { flex: '1', minWidth: '0', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--line-strong)', background: 'var(--surface)', font: '500 12px var(--font-sans)', color: 'var(--ink)' }

function Row({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', minHeight: '48px', padding: '8px 14px', borderBottom: last ? undefined : '1px solid var(--bg-sidebar)', boxSizing: 'border-box' }}>
      {children}
    </div>
  )
}

function NameAndNote({ name, note }: { name: string; note: string }) {
  return (
    <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }}>
      <span style={{ font: '500 12.5px var(--font-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {note ? <span style={{ ...NOTE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span> : null}
    </div>
  )
}

function Press({ label, on, disabled }: { label: string; on: () => void; disabled: boolean }) {
  return (
    <span
      onClick={disabled ? undefined : on}
      role="button"
      style={{ flex: 'none', padding: '5px 11px', borderRadius: '6px', border: '1px solid var(--line-strong)', background: 'var(--surface)', font: '500 11.5px var(--font-sans)', color: 'var(--ink)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? '.6' : '1', whiteSpace: 'nowrap' }}
      className="hv7"
    >
      {label}
    </span>
  )
}

/**
 * The PIN beside the keys (C-182-7): whether one is set, the two presses that set or clear it, and the two fields
 * the new PIN is typed into twice. The fields are this component's own state and are emptied the moment the press
 * hands the PIN to the derivation: a PIN left in the page is a card the next visit signs without the confirmation
 * (C-182-6). Setting and clearing sign with a registered key, so both are refused while an operation is in flight.
 */
function PinBlock({ pin }: { pin: PasskeysView['pin'] }) {
  const [open, setOpen] = useState(false)
  const [first, setFirst] = useState('')
  const [again, setAgain] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const wasBusy = useRef(false)
  // the operation ended (either way): the notice says how, so the fields close instead of waiting for a second press
  useEffect(() => {
    if (wasBusy.current && !pin.busy && open) {
      setOpen(false)
      setFirst('')
      setAgain('')
    }
    wasBusy.current = pin.busy
  }, [pin.busy, open])
  const close = () => {
    setOpen(false)
    setFirst('')
    setAgain('')
    setLocalError(null)
  }
  const submit = () => {
    if (first !== again) {
      setLocalError(WORDS.settings.passkeys.pinMismatch)
      return
    }
    const typed = first
    // the PIN is cleared here and handed over in the same press: it is not kept for the next card (C-182-6)
    setFirst('')
    setAgain('')
    setLocalError(null)
    pin.set(typed)
  }
  return (
    <div data-settings-pin style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <span style={LABEL}>{WORDS.settings.passkeys.pinTitle}</span>
      {pin.error ? <span data-settings-pin-error style={ERR}>{WORDS.settings.passkeys.pinUnreadable(pin.error)}</span> : null}
      <div style={LIST}>
        <Row last={!open}>
          <NameAndNote name={WORDS.settings.passkeys.pinTitle} note={pin.lockedNote ? `${pin.note} · ${pin.lockedNote}` : pin.note} />
          <Press
            label={pin.setLabel}
            on={() => {
              setOpen(true)
              setLocalError(null)
            }}
            disabled={pin.busy}
          />
          {pin.clearLabel ? <Press label={pin.clearLabel} on={pin.clear} disabled={pin.busy} /> : null}
        </Row>
        {open ? (
          <Row last>
            <div style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  data-pin-input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={first}
                  placeholder={WORDS.settings.passkeys.pinInput(pin.digits)}
                  onChange={(event) => setFirst(event.target.value)}
                  style={INPUT}
                />
                <input
                  data-pin-again
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={again}
                  placeholder={WORDS.settings.passkeys.pinAgain}
                  onChange={(event) => setAgain(event.target.value)}
                  style={INPUT}
                />
              </div>
              {localError ? <span style={ERR}>{localError}</span> : null}
            </div>
            <Press label={pin.busy ? WORDS.settings.passkeys.pinSigning : WORDS.settings.passkeys.pinSubmit} on={submit} disabled={pin.busy} />
            <Press label={WORDS.settings.passkeys.pinCancel} on={close} disabled={pin.busy} />
          </Row>
        ) : null}
      </div>
    </div>
  )
}

export function SettingsPasskeys({ m }: { m: Model }) {
  const { secKey, set } = m
  const pk = set.passkeys
  return (
    <>
      {secKey ? (
        <div data-settings-passkeys style={{ display: 'flex', flexDirection: 'column', gap: '20px', animation: 'pfade 120ms both' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={LABEL}>Passkeys</span>
            {/* an unreadable list is its reason, never a count and never "none registered" (C-172-1) */}
            {pk.error ? <span data-settings-error style={ERR}>{WORDS.sign.unreadable(pk.error)}</span> : null}
            {pk.loaded ? (
              <div style={LIST}>
                {pk.rows.map((row, index) => (
                  <Row key={row.key} last={index === pk.rows.length - 1 && !pk.firstKeyNote}>
                    <NameAndNote name={row.title} note={row.note} />
                  </Row>
                ))}
                {pk.firstKeyNote ? (
                  <Row last>
                    <span style={NOTE}>{pk.firstKeyNote}</span>
                  </Row>
                ) : null}
              </div>
            ) : !pk.error ? (
              <span style={NOTE}>{WORDS.settings.loading}</span>
            ) : null}
            <div style={LIST}>
              <Row last>
                <div
                  onClick={pk.busy ? undefined : pk.add}
                  role="button"
                  style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0', cursor: pk.busy ? 'default' : 'pointer' }}
                >
                  <span style={{ font: '500 12.5px var(--font-sans)', color: pk.busy ? 'var(--ink-3)' : 'var(--ink)' }}>{pk.addLabel}</span>
                </div>
              </Row>
            </div>
            {pk.notice ? (
              <div data-settings-passkey-result style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={pk.notice.failed ? ERR : { font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{pk.notice.text}</span>
                {pk.notice.detail ? <span style={NOTE}>{pk.notice.detail}</span> : null}
              </div>
            ) : null}
          </div>

          <PinBlock pin={pk.pin} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={LABEL}>{WORDS.settings.passkeys.pendingTitle}</span>
            {/* the pending list is readable from the local screen alone: another page is told why, not zero rows */}
            {pk.pendingError ? <span data-settings-pending-error style={ERR}>{WORDS.settings.passkeys.pendingUnreadable(pk.pendingError)}</span> : null}
            {pk.pendingLoaded ? (
              <div style={LIST}>
                {pk.pending.length ? (
                  pk.pending.map((row, index) => (
                    <Row key={row.key} last={index === pk.pending.length - 1}>
                      <NameAndNote name={row.title} note={`${row.host} · ${row.note}`} />
                      <Press label={row.approveLabel} on={row.approve} disabled={row.approveDisabled} />
                    </Row>
                  ))
                ) : (
                  <Row last>
                    <span style={NOTE}>{WORDS.settings.passkeys.pendingEmptyNote}</span>
                  </Row>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}
