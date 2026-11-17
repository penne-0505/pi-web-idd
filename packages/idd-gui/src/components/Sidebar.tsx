// 骨格: 左のレール（アイコンのみ）+ 画面ごとの中身 + 最下部の設定。
// dc 版は `leftOpen` の `sc-if` の中に 3 つの `sc-if` を並べていた。
import type { Model } from '../model/model'
import { sidebar } from '../styles/containers'
import { ChatSidebar } from './shell/ChatSidebar'
import { InboxSidebar } from './shell/InboxSidebar'
import { Rail } from './shell/Rail'
import { SettingsButton } from './shell/SettingsButton'
import { WorkSidebar } from './shell/WorkSidebar'

export function Sidebar({ m }: { m: Model }) {
  const { vInbox, vLanes, vChat } = m
  return (
    <div style={sidebar}>
      <Rail m={m} />
      {vInbox ? <InboxSidebar m={m} /> : null}
      {vLanes ? <WorkSidebar m={m} /> : null}
      {vChat ? <ChatSidebar m={m} /> : null}
      <SettingsButton m={m} />
    </div>
  )
}
