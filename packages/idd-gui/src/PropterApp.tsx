// 画面の入口。dc 版の props（startView / inboxCard / keepAsk）をそのまま持つ。
import type { View } from './model/data'
import { usePropterModel } from './model/useModel'
import { AppShell } from './components/AppShell'

export interface PropterAppProps {
  /** 最初に開く画面 */
  startView?: View
  /** Inbox の一番上に置く card の id（CLI が返す URL の `?card=`。lane の IDD-n か、投稿の下書きの OUT-…） */
  inboxCard?: string
  /** 質問 card の答え方: stream = その場で答える / branch = 会話として残す */
  keepAsk?: 'stream' | 'branch'
  /** 開いたときに URL が名指していた lane */
  startLane?: string | null
  /** 開いたときに URL が全体の帯を開いていたか */
  startAll?: boolean
}

export function PropterApp(props: PropterAppProps) {
  const model = usePropterModel(props)
  return <AppShell m={model} />
}
