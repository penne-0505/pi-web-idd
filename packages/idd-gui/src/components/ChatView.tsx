// 会話: ヘッダはタイトルだけ。本文は chat / idea の型でも同じ描き方にする（ゲートと Exits は engine の値を
// 描く経路をこの lane が持たないので、見本の線も文書も出さない — C-153-3）。入力欄まわりは Composer が持つ。
import type { Model } from '../model/model'
import { chatColumn } from '../styles/containers'
import { ChatConversation } from './chat/ChatConversation'
import { ChatHeader } from './chat/ChatHeader'
import { Composer } from './chat/Composer'

export function ChatView({ m }: { m: Model }) {
  return (
    <>
      <ChatHeader m={m} />
      <div style={chatColumn}>
        <ChatConversation m={m} />
        <div style={{ flex: '1' }} />
        <Composer m={m} />
      </div>
    </>
  )
}
