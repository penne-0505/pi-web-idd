// Voice input: the prototype has no recording entrance and the settings alone have nowhere to act, so the
// section keeps its place and says it cannot be handled yet. No sample key, language or microphone is drawn
// (C-171-1).
import type { Model } from '../../model/model'
import { SettingsUnsupported } from './SettingsUnsupported'

export function SettingsVoice({ m }: { m: Model }) {
  const { secVoice } = m
  return <>{secVoice ? <SettingsUnsupported /> : null}</>
}
