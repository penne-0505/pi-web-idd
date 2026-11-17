// Lane stages & roles: the engine reads lanes.toml and roles.yaml, and this screen has no door for either, so
// the section keeps its place and says it cannot be handled yet — including the button that used to offer to
// open lanes.toml (C-171-1).
import type { Model } from '../../model/model'
import { SettingsUnsupported } from './SettingsUnsupported'

export function SettingsLaneStages({ m }: { m: Model }) {
  const { secLanes } = m
  return <>{secLanes ? <SettingsUnsupported /> : null}</>
}
