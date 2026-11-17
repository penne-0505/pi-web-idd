// PC 全体: タイトルバー（両端でサイドバーを開閉）+ 本体 + 設定シート。
import type { Model } from '../model/model'
import { appFrame, titleRow } from '../styles/containers'
import { ChatView } from './ChatView'
import { InboxView } from './InboxView'
import { RightPanel } from './RightPanel'
import { SettingsSheet } from './SettingsSheet'
import { Sidebar } from './Sidebar'
import { WorkView } from './WorkView'
import { TitleBar } from './shell/TitleBar'
import { mainColumn } from '../styles/containers'

export function AppShell({ m }: { m: Model }) {
  const { leftOpen, showRight, settings, vInbox, vLanes, vChat } = m
  return (
    <div style={appFrame}>
      <TitleBar m={m} />
      <div style={titleRow}>
        {leftOpen ? <Sidebar m={m} /> : null}
        <div style={mainColumn}>
          {vInbox ? <InboxView m={m} /> : null}
          {vLanes ? <WorkView m={m} /> : null}
          {vChat ? <ChatView m={m} /> : null}
        </div>
        {showRight ? <RightPanel m={m} /> : null}
      </div>
      {settings ? <SettingsSheet m={m} /> : null}
    </div>
  )
}
