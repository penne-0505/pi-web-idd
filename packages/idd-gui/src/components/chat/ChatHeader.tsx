// 会話: ヘッダはタイトルだけ。タイトルは一覧が返した会話の名で、名の無い会話は 無題 (DEC-116-1)。
import type { Model } from '../../model/model'

export function ChatHeader({ m }: { m: Model }) {
  const { title } = m.chat.list
  return (
    <>
      <div style={{ height: "46px", flex: "none", display: "flex", alignItems: "center", gap: "14px", padding: "0 24px", borderBottom: "1px solid var(--line-soft)" }}>
        <span data-part="chat-title" style={{ font: "600 13.5px var(--font-sans)", minWidth: "0", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {title}
        </span>
        <span style={{ flex: "1" }} />
        <span style={{ font: "500 14px var(--font-sans)", color: "var(--ink-3)" }}>
          ⋯
        </span>
      </div>
    </>
  )
}
