// 本文の塊を描く。段落は要素に組み立て、code の塊は枠に入れる。本文は React の子として置き、HTML には
// しない (DEC-116-8)。会話の本文と BTW の枠が同じ描き方をする。
import { Fragment } from 'react'
import type { ChatBlockView } from '../../chat/viewmodel'

export function BodyBlocks({ blocks }: { blocks: ChatBlockView[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {blocks.map((block, index) => (
        block.kind === 'code' ? <CodeBlock key={index} block={block} /> : <Paragraph key={index} block={block} />
      ))}
    </div>
  )
}

function Paragraph({ block }: { block: ChatBlockView }) {
  return (
    <div style={{ font: '400 13.5px/1.85 var(--font-sans)', textWrap: 'pretty' }}>
      {block.inlines.map((inline, index) => {
        if (inline.kind === 'break') return <br key={index} />
        if (inline.kind === 'code') {
          return (
            <span key={index} style={{ padding: '1px 5px', background: 'var(--line-soft)', borderRadius: '4px', font: '400 12px var(--font-mono)' }}>
              {inline.text}
            </span>
          )
        }
        return <Fragment key={index}>{inline.text}</Fragment>
      })}
    </div>
  )
}

function CodeBlock({ block }: { block: ChatBlockView }) {
  const copy = () => {
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator?.clipboard
    void clipboard?.writeText?.(block.text)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--code-bg)', borderRadius: '8px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', font: '400 10.5px var(--font-mono)', color: 'var(--code-head-ink)' }}>
        {block.lang}
        <span style={{ flex: '1' }} />
        <span onClick={copy} style={{ cursor: 'pointer' }}>コピー</span>
      </div>
      <div style={{ padding: '4px 14px 12px', font: '400 12px/1.7 var(--font-mono)', color: 'var(--code-ink)', whiteSpace: 'pre-wrap' }}>
        {block.text}
      </div>
    </div>
  )
}
