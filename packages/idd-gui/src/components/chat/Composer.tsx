// 入力欄とその下の行。描く値は engine が返したもので、押した操作は engine の会話の口に届く (C-153-3)。
// Enter は送り、Shift + Enter は行を書き、変換中の Enter は何もしない (DEC-116-6)。順番待ちの札は engine の
// queue をそのまま並べ、編集・取消・割り込みはそれぞれの口に届く (DEC-116-5、INV-116-1)。
import { useRef, type KeyboardEvent } from 'react'
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'
import { composerDraftChange, composerKey } from '../../chat/keys'
import { ContextPopover } from './ContextPopover'
import { EffortSlider } from './EffortSlider'
import { ModelPicker } from './ModelPicker'

export function Composer({ m }: { m: Model }) {
  const input = m.chat.input
  const fileInput = useRef<HTMLInputElement | null>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const intent = composerKey({ key: event.key, shift: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })
    if (intent !== 'send') return
    event.preventDefault()
    if (input.canSend) input.send()
  }

  // typing `@` where a mention starts opens the picker; the `@` itself stays in the draft, so an address or a
  // handle written with `@` reaches the send with its `@` intact
  const onDraftChange = (value: string) => {
    const change = composerDraftChange(input.draft, value)
    if (change.openPicker) input.mentions.openPicker()
    input.setDraft(change.draft)
  }

  const addFiles = (files: FileList | null) => {
    const list = files ? Array.from(files) : []
    const read: { data: string; mimeType: string }[] = []
    let waiting = list.length
    if (!waiting) return
    for (const file of list) {
      if (!file.type.startsWith('image/')) {
        waiting -= 1
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        if (comma >= 0) read.push({ data: result.slice(comma + 1), mimeType: file.type })
        waiting -= 1
        if (!waiting) input.attach.add(read)
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div style={{ width: '100%', maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 24px 18px', boxSizing: 'border-box' }}>
      {input.mentions.open ? (
        <div data-part="mention-picker" style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '9px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ font: '500 11px var(--font-sans)', color: 'var(--ink-3)' }}>{input.mentions.labels.title}</span>
            <input data-part="mention-search" value={input.mentions.query} placeholder={input.mentions.labels.search} onChange={(event) => input.mentions.setQuery(event.target.value)} style={{ flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 12px var(--font-sans)', color: 'var(--ink)' }} />
            <span data-part="mention-close" onClick={input.mentions.close} style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>×</span>
          </div>
          <div style={{ maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {input.mentions.loading && !input.mentions.options.length ? (
              <span style={{ padding: '4px 2px', font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>…</span>
            ) : input.mentions.options.length ? (
              input.mentions.options.map((option) => (
                <div key={option.key} data-mention-option={option.key} data-mention-active={option.active ? '1' : '0'} onClick={option.choose} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 6px', borderRadius: '6px', cursor: 'pointer', background: option.active ? 'var(--line-soft)' : 'transparent' }} className="hv7">
                  <span style={{ font: '500 12px var(--font-sans)', color: 'var(--ink)' }}>{option.label}</span>
                  <span style={{ flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{option.hint}</span>
                </div>
              ))
            ) : (
              <span style={{ padding: '4px 2px', font: '400 11px var(--font-sans)', color: 'var(--ink-3)' }}>{input.mentions.labels.empty}</span>
            )}
          </div>
        </div>
      ) : null}
      {input.mentions.chosen.length ? (
        <div data-part="composer-mentions" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {input.mentions.chosen.map((chip) => (
            <span key={chip.key} data-mention={chip.key} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 6px 3px 9px', background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '7px', font: '400 11.5px var(--font-sans)', color: 'var(--ink-2)' }}>
              {chip.label}
              <span data-mention-remove={chip.key} onClick={chip.remove} title={WORDS.chat.mentions.remove} style={{ cursor: 'pointer', color: 'var(--ink-3)' }}>×</span>
            </span>
          ))}
        </div>
      ) : null}
      {input.mentions.error ? (
        <div data-part="composer-mention-error" style={{ font: '400 11px var(--font-sans)', color: 'var(--attention-text)' }}>{input.mentions.error}</div>
      ) : null}
      {input.queue.map((chip) => (
        <div key={chip.id} data-queue={chip.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px 5px 10px', background: 'var(--surface)', border: '1px dashed var(--line-strong)', borderRadius: '7px', font: '400 12px var(--font-sans)', color: 'var(--ink-2)', animation: 'plift 120ms var(--ease-out) both' }}>
          <span style={{ flex: 'none', font: '500 10px var(--font-sans)', color: 'var(--ink-3)' }}>{chip.label}</span>
          {chip.editing ? (
            <>
              <input data-queue-edit={chip.id} value={chip.edited} onChange={(event) => chip.setEdited(event.target.value)} style={{ flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 12px var(--font-sans)', color: 'var(--ink)' }} />
              <span onClick={chip.confirmEdit} style={{ cursor: 'pointer', color: 'var(--ink)' }}>{WORDS.chat.queueConfirm}</span>
              <span onClick={chip.cancelEdit} style={{ cursor: 'pointer' }}>{WORDS.chat.queueCancel}</span>
            </>
          ) : (
            <>
              <span data-queue-text={chip.id} style={{ flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{chip.text}</span>
              <span style={{ display: 'flex', gap: '2px' }}>
                <span title={WORDS.chat.queueEdit} data-queue-edit-open={chip.id} onClick={chip.startEdit} style={{ width: '24px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', cursor: 'pointer' }} className="hv7">✎</span>
                <span title={WORDS.chat.queueCancel} data-queue-cancel={chip.id} onClick={chip.cancel} style={{ width: '24px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', font: '400 14px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer' }} className="hv7">×</span>
                <span title={WORDS.chat.queueSteer} data-queue-steer={chip.id} onClick={chip.steer} style={{ width: '24px', height: '22px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.5px', borderRadius: '5px', cursor: 'pointer' }} className="hv10">
                  <span style={{ width: '10px', height: '1.5px', background: 'var(--attention-alt)' }} />
                  <span style={{ width: '0', height: '0', borderLeft: '4.5px solid transparent', borderRight: '4.5px solid transparent', borderBottom: '6px solid var(--attention-alt)' }} />
                </span>
              </span>
            </>
          )}
        </div>
      ))}
      {input.attach.images.length ? (
        <div data-part="composer-attachments" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '2px 0' }}>
          {input.attach.images.map((image, index) => (
            <span key={`${index}:${image.mimeType}`} data-attachment={index} style={{ position: 'relative', width: '44px', height: '44px', borderRadius: '7px', overflow: 'hidden', border: '1px solid var(--line)' }}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <span data-attachment-remove={index} onClick={() => input.attach.remove(index)} title={WORDS.chat.attach.remove} style={{ position: 'absolute', top: '0', right: '0', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', font: '400 11px var(--font-sans)', color: 'var(--ink-2)', cursor: 'pointer' }}>×</span>
            </span>
          ))}
        </div>
      ) : null}
      {input.notice ? (
        <div data-part="composer-notice" style={{ font: '400 11px var(--font-sans)', color: 'var(--attention-text)' }}>{input.notice}</div>
      ) : null}
      {input.notices.length ? (
        <div data-part="composer-notices" style={{ display: 'flex', flexDirection: 'column', gap: '2px', font: '400 11px var(--font-sans)', color: 'var(--attention-text)' }}>
          {input.notices.map((line, index) => <span key={index} data-notice={index}>{line}</span>)}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', marginTop: '4px', padding: '7px 10px 7px 14px', background: 'var(--surface)', border: '1px solid var(--line-strong)', borderRadius: '12px' }}>
        <textarea
          data-part="composer-input"
          rows={1}
          value={input.draft}
          placeholder={input.placeholder}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          style={{ flex: '1', minWidth: '0', minHeight: '32px', padding: '5px 0', border: 'none', outline: 'none', background: 'transparent', resize: 'none', font: '400 13px/1.7 var(--font-sans)', color: 'var(--ink)' }}
        />
        {input.streaming ? (
          <span onClick={input.stop} data-part="composer-stop" style={{ flex: 'none', minWidth: '44px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '9px', background: 'var(--line-soft)', font: '600 11.5px var(--font-sans)', color: 'var(--ink)', cursor: 'pointer' }} className="hv11">
            {WORDS.chat.stop}
          </span>
        ) : (
          <span onClick={() => input.canSend && input.send()} data-part="composer-send" data-percent={input.context.percent ?? ''} style={{ position: 'relative', width: '32px', height: '32px', flex: 'none', borderRadius: '9px', background: 'var(--ink-2)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', opacity: input.canSend ? 1 : 0.7 }}>
            <span style={{ position: 'absolute', left: '0', right: '0', bottom: '0', height: `${input.context.percent ?? 0}%`, background: 'var(--ink)' }} />
            <span style={{ position: 'relative', width: '9px', height: '9px', background: 'var(--surface)', borderRadius: '2px' }} />
          </span>
        )}
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '10px', padding: '2px 2px 0', font: '400 11px var(--font-sans)', color: 'var(--ink-2)' }}>
        <span
          title={WORDS.chat.mentions.hint}
          data-part="composer-mention"
          onClick={() => (input.mentions.open ? input.mentions.close() : input.mentions.openPicker())}
          style={{ position: 'relative', width: '26px', height: '26px', flex: 'none', borderRadius: '7px', border: '1px solid var(--line)', background: 'var(--surface)', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 12px var(--font-sans)', color: input.mentions.chosen.length ? 'var(--ink)' : 'var(--ink-2)' }}
          className="hv15"
        >
          {WORDS.chat.mentions.open}
        </span>
        <span
          title={input.attach.allowed ? WORDS.chat.attach.title : WORDS.chat.attach.notAllowed}
          data-part="composer-attach"
          onClick={() => input.attach.allowed && fileInput.current?.click()}
          style={{ position: 'relative', width: '26px', height: '26px', flex: 'none', borderRadius: '7px', border: '1px solid var(--line)', background: 'var(--surface)', boxSizing: 'border-box', cursor: input.attach.allowed ? 'pointer' : 'not-allowed', opacity: input.attach.allowed ? 1 : 0.5 }}
          className="hv15"
        >
          <span style={{ position: 'absolute', left: '50%', top: '50%', width: '10px', height: '1.5px', margin: '-0.75px 0 0 -5px', background: 'var(--ink-2)' }} />
          <span style={{ position: 'absolute', left: '50%', top: '50%', width: '1.5px', height: '10px', margin: '-5px 0 0 -0.75px', background: 'var(--ink-2)' }} />
        </span>
        <input ref={fileInput} type="file" accept="image/*" multiple onChange={(event) => addFiles(event.target.files)} style={{ display: 'none' }} data-part="composer-file" />
        {input.types.length ? (
          <span data-part="type-switch" data-type={input.type} style={{ display: 'flex', gap: '2px', padding: '2px', background: 'var(--line-soft)', borderRadius: '7px' }}>
            {input.types.map((option) => (
              <span
                key={option.name}
                data-type-option={option.name}
                onClick={option.go}
                style={{ padding: '3px 10px', borderRadius: '5px', font: '500 11px var(--font-sans)', cursor: 'pointer', background: option.active ? 'var(--surface)' : 'transparent', color: option.active ? 'var(--ink)' : 'var(--ink-3)' }}
              >
                {option.label}
              </span>
            ))}
          </span>
        ) : null}
        <span style={{ flex: '1' }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <ModelPicker m={m} />
          <EffortSlider m={m} />
          <ContextPopover m={m} />
        </span>
      </div>
    </div>
  )
}
