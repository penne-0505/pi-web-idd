// 会話の本文。畳んだ列をそのまま描く: 発言は吹き出し、道具は 1 行に畳み、code の塊は枠に入れる。どの値も
// engine が返したもので、見本の文字は無い (DEC-116-1)。本文は React の子として置き、HTML にはしない
// (DEC-116-8)。続く呼び出しは 1 行に畳み、失敗はその行に出す (DEC-116-9)。
import { Fragment } from 'react'
import type { Model } from '../../model/model'
import { WORDS } from '../../strings'
import type { ChatBodyItemView } from '../../chat/viewmodel'
import { BodyBlocks } from './BodyText'

/** one line across the body: a compaction mark, a shown context utterance or a gate record */
function LineRow({ text, gate }: { text: string; gate?: boolean }) {
  return (
    <div data-part={gate ? 'chat-gate' : 'chat-line'} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span style={{ flex: "1", height: gate ? "2px" : "1px", background: gate ? 'var(--ink)' : 'var(--line-soft)' }} />
      {gate ? <span style={{ width: "9px", height: "9px", background: "var(--ink)", transform: "rotate(45deg)" }} /> : null}
      <span style={{ font: gate ? '500 11px var(--font-sans)' : '400 11px var(--font-sans)', color: gate ? 'var(--ink)' : 'var(--ink-3)' }}>{text}</span>
      <span style={{ flex: "1", height: gate ? "2px" : "1px", background: gate ? 'var(--ink)' : 'var(--line-soft)' }} />
    </div>
  )
}

function Item({ item }: { item: ChatBodyItemView }) {
  if (item.kind === 'user') {
    return (
      <div data-part="chat-user" style={{ alignSelf: "flex-end", maxWidth: "70%", padding: "10px 14px", background: "var(--line-soft)", borderRadius: "12px 12px 4px 12px", font: "400 13px/1.7 var(--font-sans)", whiteSpace: "pre-wrap" }}>
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div data-part="chat-assistant" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <BodyBlocks blocks={item.blocks} />
        {item.caret ? <span data-part="chat-caret" style={{ display: "inline-block", width: "7px", height: "15px", background: "var(--ink)", verticalAlign: "-2px", animation: "pulse 1s infinite" }} /> : null}
      </div>
    )
  }
  if (item.kind === 'thinking') {
    return (
      <div data-part="chat-thinking" style={{ font: "400 11.5px/1.7 var(--font-sans)", color: "var(--ink-3)", whiteSpace: "pre-wrap" }}>
        {item.text}
      </div>
    )
  }
  if (item.kind === 'tools' && item.tool) {
    return (
      <div data-part="chat-tools" data-failed={item.tool.failed} style={{ display: "flex", alignItems: "center", gap: "8px", font: "400 11.5px var(--font-sans)", color: item.tool.failed ? "var(--attention-text)" : "var(--ink-3)" }}>
        <span style={{ fontSize: "9px" }}>▸</span>
        {item.tool.label}
        {item.tool.running ? <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--ink-3)", animation: "pulse 1.6s infinite" }} /> : null}
        {item.tool.failed ? <span>{WORDS.chat.toolFailed}</span> : null}
      </div>
    )
  }
  if (item.kind === 'gate') return <LineRow text={item.text} gate />
  return <LineRow text={item.text} />
}

export function ChatConversation({ m }: { m: Model }) {
  const body = m.chat.body
  return (
    <>
      <div style={{ width: "100%", maxWidth: "720px", display: "flex", flexDirection: "column", gap: "18px", padding: "28px 24px 0", boxSizing: "border-box" }}>
        {body.error ? (
          <div data-part="chat-error" style={{ font: "400 12.5px/1.7 var(--font-sans)", color: "var(--attention-text)" }}>{body.error}</div>
        ) : null}
        {body.partial ? (
          <div data-part="chat-partial" style={{ font: "400 11px var(--font-sans)", color: "var(--ink-3)" }}>{body.partial}</div>
        ) : null}
        {!body.error && !body.items.length ? (
          <div data-part="chat-empty" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "20px 0" }}>
            {body.pick ? <div style={{ font: "600 13.5px var(--font-sans)" }}>{body.pick}</div> : null}
            {body.empty ? <div style={{ font: "400 11.5px var(--font-sans)", color: "var(--ink-2)" }}>{body.empty}</div> : null}
          </div>
        ) : null}
        {body.items.map((item) => <Item key={item.key} item={item} />)}
      </div>
    </>
  )
}
