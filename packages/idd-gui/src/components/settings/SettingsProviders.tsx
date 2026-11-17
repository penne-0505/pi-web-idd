// Providers & Models: the engine has no door for the provider list or models.json (the file holds the keys), so
// the section keeps its place and says it cannot be handled yet. No sample provider, model or price is drawn
// (C-171-1).
import type { Model } from '../../model/model'
import { SettingsUnsupported } from './SettingsUnsupported'

export function SettingsProviders({ m }: { m: Model }) {
  const { secProv } = m
  return <>{secProv ? <SettingsUnsupported /> : null}</>
}
