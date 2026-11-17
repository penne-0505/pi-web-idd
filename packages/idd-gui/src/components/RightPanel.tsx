// 右パネル: Inbox は card の種類で中身が替わる（`m.inbox.panel` が engine の値から組む）。相談は質問の card
// の右パネルの中で続く（C-153-1）。会話は BTW の枠だけを出す（C-153-2）。
import type { Model } from '../model/model'
import { rightPanel } from '../styles/containers'
import { ChatPanel } from './panels/ChatPanel'
import { InboxPanel } from './panels/InboxPanel'

export function RightPanel({ m }: { m: Model }) {
  const { vInbox, vChat, inbox } = m
  return (
    <div style={rightPanel}>
      {vInbox && inbox.panel ? <InboxPanel panel={inbox.panel} on={inbox.handlers} consult={m.consult} /> : null}
      {vChat ? <ChatPanel m={m} /> : null}
    </div>
  )
}
