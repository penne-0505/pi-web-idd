// Inbox: one card at a time. The card identifies the judgement; the right panel carries the detail. Everything
// drawn here comes from the engine's state `m.inbox` built (see `src/inbox/viewmodel.ts`); the operations are the
// same key meanings the current GUI uses.
import { useState } from 'react'
import type { Model } from '../model/model'
import type { ConfirmView } from '../inbox/viewmodel'
import { WORDS } from '../strings'
import { inboxView as inboxLayout } from '../styles/containers'
import { CardActions } from './inbox/CardActions'
import { InboxProgress } from './inbox/InboxProgress'
import { DuplicateCard, GoCard, PostCard, ProposalCard, QuestionCard, RequeueCard, ReviewCard, StuckCard, SubmitCard, SyncConflictCard, GenericCard } from './inbox/InboxCards'

function Card({ m }: { m: Model }) {
  const inbox = m.inbox
  const card = inbox.card
  if (!card) return null
  switch (card.cardKind) {
    case 'question':
      return <QuestionCard card={card} on={inbox.handlers} />
    case 'go':
      return <GoCard card={card} on={inbox.handlers} />
    case 'submit':
      return <SubmitCard card={card} on={inbox.handlers} />
    case 'post':
      return <PostCard card={card} on={inbox.handlers} />
    case 'review':
      return <ReviewCard card={card} on={inbox.handlers} />
    case 'stuck':
      return <StuckCard card={card} on={inbox.handlers} />
    case 'duplicate':
      return <DuplicateCard card={card} />
    case 'requeue':
      return <RequeueCard card={card} />
    case 'proposal':
      return <ProposalCard card={card} on={inbox.handlers} />
    case 'sync_conflict':
      return <SyncConflictCard card={card} />
    default:
      return <GenericCard card={card} on={inbox.handlers} />
  }
}

/**
 * The PIN as the other way to sign the card the confirm stage shows: the field and its press. The typed digits are
 * this component's own state and are cleared the moment they are handed over, and the whole component leaves with
 * the stage — so the next card asks again instead of inheriting the last one's PIN (C-182-6).
 */
function PinApprove({ pin }: { pin: ConfirmView['pin'] }) {
  const [value, setValue] = useState('')
  if (!pin.configured && !pin.error) return null
  if (pin.error) {
    return (
      <div data-pin-unreadable style={{ font: '400 11px var(--font-sans)', color: 'var(--attention-text)' }}>
        {WORDS.sign.pinUnreadable(pin.error)}
      </div>
    )
  }
  const submit = () => {
    const typed = value
    // the PIN is cleared before it leaves the page: nothing is left for the next card to reuse (C-182-6)
    setValue('')
    pin.approve(typed)
  }
  return (
    <div data-confirm-pin style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{WORDS.sign.pinLabel}</span>
      <input
        data-pin-input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        placeholder={WORDS.sign.pinInput(pin.digits)}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          if (value) submit()
        }}
        style={{ flex: '1', minWidth: '0', padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--line-strong)', background: 'var(--surface)', font: '500 12px var(--font-sans)', color: 'var(--ink)' }}
      />
      <span
        onClick={value ? submit : undefined}
        role="button"
        style={{ padding: '5px 11px', borderRadius: '999px', border: '1px solid var(--line-strong)', font: '500 11px var(--font-sans)', cursor: value ? 'pointer' : 'default', opacity: value ? '1' : '.6' }}
      >
        {WORDS.sign.pinApprove}
      </span>
    </div>
  )
}

/** the confirm stage: every line the signature will cover, in full, before the passkey or the PIN is asked (DEC-9503) */
function ConfirmStage({ m }: { m: Model }) {
  const confirm = m.inbox.confirming
  if (!confirm) return null
  return (
    <div data-confirm style={{ width: '540px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', border: '1.5px solid var(--sign)', borderRadius: '12px', background: 'var(--surface)' }}>
      <div style={{ font: '600 12px var(--font-sans)', color: confirm.sign ? 'var(--sign-text)' : 'var(--attention-text)' }}>{confirm.sign ? WORDS.card.note.sign : WORDS.card.generic.confirmHeading}</div>
      {confirm.rows.map((r) => (
        <div key={`${r.label}:${r.value}`} style={{ display: 'flex', gap: '10px', font: '400 11px/1.6 var(--font-sans)' }}>
          <span style={{ width: '96px', flex: 'none', font: '500 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{r.label}</span>
          <span style={{ flex: '1', whiteSpace: 'pre-wrap' }}>{r.value}</span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span onClick={confirm.cancel.go} style={{ padding: '5px 11px', borderRadius: '999px', border: '1px solid var(--line-strong)', font: '500 11px var(--font-sans)', cursor: 'pointer' }}>{confirm.cancel.label}</span>
        <span style={{ flex: '1' }} />
        <span onClick={confirm.approve.disabled ? undefined : confirm.approve.go} style={{ padding: '5px 11px', borderRadius: '999px', background: 'var(--sign)', color: 'var(--surface)', font: '600 11px var(--font-sans)', cursor: 'pointer', opacity: confirm.approve.disabled ? '.6' : '1' }}>{confirm.approve.label}</span>
      </div>
      {confirm.sign ? <PinApprove pin={confirm.pin} /> : null}
    </div>
  )
}

function RegisterNote({ m }: { m: Model }) {
  const { needsRegister, registerHere } = m.inbox
  if (!needsRegister) return null
  return (
    <div data-sign-note style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '400 11px var(--font-sans)', color: 'var(--ink-2)' }}>
      <span style={{ padding: '1px 7px', borderRadius: '4px', background: 'var(--line-soft)', font: '600 10px var(--font-sans)' }}>{WORDS.sign.notRegistered}</span>
      {registerHere ? (
        <span onClick={m.inbox.handlers.openSettingsKey} role="button" style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>
          {WORDS.sign.register}
        </span>
      ) : (
        <span>{WORDS.sign.tailnetNote}</span>
      )}
    </div>
  )
}

function ConnectionBanner({ m }: { m: Model }) {
  const { down, progress, handlers } = m.inbox
  if (!down) return null
  return (
    <div data-connection style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px', background: 'var(--attention-bg)', font: '400 11px var(--font-sans)', color: 'var(--attention-text)' }}>
      {WORDS.connection.down}
      <span style={{ flex: '1' }} />
      <span style={{ font: '400 10.5px var(--font-sans)' }}>{progress.attempt ? `${progress.attempt} 回目` : ''}</span>
      <span onClick={handlers.retry} style={{ cursor: 'pointer', textDecoration: 'underline' }}>{WORDS.connection.retryNow}</span>
    </div>
  )
}

export function InboxView({ m }: { m: Model }) {
  const inbox = m.inbox
  const { card, error, receipt, busy } = inbox
  return (
    <div style={inboxLayout}>
      <InboxProgress progress={inbox.progress} />
      <ConnectionBanner m={m} />
      {error ? <div data-error style={{ font: '400 11.5px var(--font-sans)', color: 'var(--attention-text)' }}>{error.text}</div> : null}
      {receipt ? (
        <div data-receipt style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>
          {receipt}
          <span onClick={inbox.handlers.clearReceipt} style={{ marginLeft: '8px', cursor: 'pointer', color: 'var(--ink-3)' }}>×</span>
        </div>
      ) : null}
      {card ? (
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'center', width: '100%', opacity: busy ? 0.85 : 1 }}>
            <Card m={m} />
          </div>
          <ConfirmStage m={m} />
          <RegisterNote m={m} />
          <CardActions actions={inbox.actions} />
        </div>
      ) : (
        <div data-empty style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', padding: '40px 0' }}>
          <div style={{ font: '600 14px var(--font-sans)' }}>{WORDS.empty.title}</div>
          <div style={{ font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>{WORDS.empty.reason}</div>
        </div>
      )}
    </div>
  )
}
