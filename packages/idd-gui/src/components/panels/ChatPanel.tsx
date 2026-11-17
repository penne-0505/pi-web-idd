// 会話の右パネル: BTW の枠だけを出す。engine に口があるのは枝を切る口と格上げの口だけで、内蔵ブラウザ・
// ファイル・記録の 3 枠は値を返す口が無いので並べない (C-153-2、DEC-9186)。枝は開いた会話から切り、
// 「会話として残す」を押したときだけ一覧の会話になる (DEC-1846)。
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'
import type { ChatBodyItemView } from '../../chat/viewmodel'
import { BodyBlocks } from '../chat/BodyText'

function BtwLine({ item }: { item: ChatBodyItemView }) {
  if (item.kind === 'user') {
    return <div data-part="btw-user" style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '6px 10px', background: 'var(--bg-sidebar)', borderRadius: '8px', whiteSpace: 'pre-wrap' }}>{item.text}</div>
  }
  if (item.kind === 'assistant') {
    return (
      <div data-part="btw-assistant">
        <BodyBlocks blocks={item.blocks} />
      </div>
    )
  }
  if (item.kind === 'thinking') return <div data-part="btw-thinking" style={{ color: 'var(--ink-3)', font: '400 10.5px/1.6 var(--font-sans)', whiteSpace: 'pre-wrap' }}>{item.text}</div>
  // a tool bundle is one folded line, as in the body: the count and names, plus the failure mark (DEC-116-9)
  if (item.kind === 'tools' && item.tool) {
    return (
      <div data-part="btw-tools" data-failed={item.tool.failed} style={{ display: 'flex', alignItems: 'center', gap: '8px', font: '400 10.5px var(--font-sans)', color: item.tool.failed ? 'var(--attention-text)' : 'var(--ink-3)' }}>
        <span style={{ fontSize: '9px' }}>▸</span>
        {item.tool.label}
        {item.tool.running ? <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--ink-3)', animation: 'pulse 1.6s infinite' }} /> : null}
        {item.tool.failed ? <span>{WORDS.chat.toolFailed}</span> : null}
      </div>
    )
  }
  return <div data-part="btw-line" style={{ font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>{item.text}</div>
}

export function ChatPanel({ m }: { m: Model }) {
  const panel = m.chat.panel
  const { keepBranch, keepStream } = m
  if (!panel.open) return null
  return (
    <>
      <div data-part="btw" style={{ flex: '1.05', display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '32px', flex: 'none', padding: '0 10px', borderBottom: '1px solid var(--line-soft)' }}>
          <span style={{ font: '600 10px var(--font-mono)', color: 'var(--attention-text)' }}>{panel.title}</span>
          <span data-part="btw-from" style={{ font: '500 12px var(--font-sans)', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{panel.from}</span>
          <span style={{ flex: '1' }} />
          <span data-part="btw-close" title={panel.labels.close} onClick={panel.close} style={{ font: '400 13px var(--font-sans)', color: 'var(--ink-3)', cursor: 'pointer' }} className="hv8">×</span>
        </div>
        <div style={{ flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', overflow: 'auto', font: '400 12px/1.7 var(--font-sans)' }}>
          {panel.error ? <div data-part="btw-error" style={{ color: 'var(--attention-text)', font: '400 11px var(--font-sans)' }}>{panel.error}</div> : null}
          {!panel.items.length && !panel.error ? <div data-part="btw-empty" style={{ color: 'var(--ink-3)', font: '400 11px var(--font-sans)' }}>{panel.labels.empty}</div> : null}
          {panel.items.map((item) => <BtwLine key={item.key} item={item} />)}
          {keepStream ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '-4px', font: '400 10.5px var(--font-sans)', color: 'var(--ink-3)' }}>
              <span style={{ flex: '1', height: '1px', background: 'var(--line-soft)' }} />
              <span
                data-part="btw-keep"
                onClick={panel.canPromote ? panel.promote : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '3px 9px', borderRadius: '999px', border: '1px solid var(--line-strong)', color: 'var(--ink-2)', cursor: panel.canPromote ? 'pointer' : 'default', opacity: panel.canPromote ? 1 : 0.5 }}
                className="hv13"
              >
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                  <span style={{ width: '1.4px', height: '4px', background: 'currentColor' }} />
                  <span style={{ width: '8px', height: '4px', border: '1.4px solid currentColor', borderBottom: 'none', borderRadius: '4px 4px 0 0', boxSizing: 'border-box' }} />
                </span>
                {panel.labels.keep}
              </span>
            </div>
          ) : null}
          {panel.promoteError ? <div data-part="btw-promote-error" style={{ color: 'var(--attention-text)', font: '400 10.5px var(--font-sans)' }}>{panel.promoteError}</div> : null}
          {panel.promoted ? <div data-part="btw-kept" style={{ color: 'var(--ink-3)', font: '400 10.5px var(--font-sans)' }}>{panel.labels.kept}</div> : null}
          <div style={{ flex: '1' }} />
          {panel.hasParent ? (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 6px 6px 10px', border: '1px solid var(--line-strong)', borderRadius: '9px' }}>
            <input
              data-part="btw-input"
              value={panel.draft}
              placeholder={panel.labels.ask}
              onChange={(event) => panel.setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (panel.draft.trim()) panel.ask()
              }}
              style={{ flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', font: '400 11.5px var(--font-sans)', color: 'var(--ink)' }}
            />
            <span
              data-part="btw-send"
              data-mode={panel.streaming ? 'stop' : 'send'}
              // while the branch is answering the same position stops it and sends nothing (C-158-4); the box keeps its words
              onClick={() => {
                if (panel.streaming) panel.stop()
                else if (panel.draft.trim()) panel.ask()
              }}
              style={{ width: '24px', height: '24px', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '7px', background: panel.sending ? 'var(--line-strong)' : 'var(--ink)', color: 'var(--surface)', font: '600 13px var(--font-sans)', cursor: 'pointer' }}
            >
              {panel.streaming ? '■' : '↑'}
            </span>
            {keepBranch ? (
              <span
                data-part="btw-keep-branch"
                title={panel.labels.keep}
                onClick={panel.canPromote ? panel.promote : undefined}
                style={{ position: 'absolute', right: '4px', top: '-28px', width: '26px', height: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '7px', background: 'var(--surface)', border: '1px solid var(--line-strong)', boxSizing: 'border-box', cursor: panel.canPromote ? 'pointer' : 'default', opacity: panel.canPromote ? 1 : 0.5 }}
                className="hv14"
              >
                <span style={{ position: 'relative', width: '12px', height: '12px' }}>
                  <span style={{ position: 'absolute', left: '2px', top: '0', width: '1.6px', height: '12px', background: 'var(--ink-2)' }} />
                  <span style={{ position: 'absolute', left: '2px', top: '3px', width: '8px', height: '7px', border: '1.6px solid var(--ink-2)', borderLeft: 'none', borderBottom: 'none', borderRadius: '0 6px 0 0', boxSizing: 'border-box' }} />
                </span>
              </span>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
