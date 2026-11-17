// Work（旧 Lanes）: 左 = リポジトリ、中央 = lane の列、右 = 詳細。
// lane の列の上に全体の縮図、押すと全体の帯（WorkTimeline）が重なる。
import type { Model } from '../model/model'
import { workGrid } from '../styles/containers'
import { WorkDetail } from './work/WorkDetail'
import { WorkSidebarColumn } from './work/WorkSidebarColumn'
import { WorkTimeline } from './work/WorkTimeline'

export function WorkView({ m }: { m: Model }) {
  return (
    <div style={workGrid}>
      <WorkSidebarColumn m={m} />
      <WorkDetail m={m} />
      <WorkTimeline m={m} />
    </div>
  )
}
