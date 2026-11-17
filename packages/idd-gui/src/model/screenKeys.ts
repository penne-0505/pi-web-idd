// The one key listener the screen installs, kept out of `useModel`'s effect so what a screen answers can be
// checked without a browser. The screen's effect body is only this call: installing answers nothing by itself, so
// a screen that has just been drawn keeps the state it was drawn with.
import type { ViewName } from '../view'

/** the surface the listener is installed on, in the shape a test's stand-in can take */
export interface KeyWindow {
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void
}

/** what the listener reads, and the three things a key can act on */
export interface ScreenKeys {
  view: ViewName
  /** the settings sheet is over the screen */
  settings: boolean
  /** the Work screen's full band is open */
  wopen: boolean
  /** close the settings sheet (its header shows "Close (Esc)") */
  closeSettings: () => void
  /** close the Work screen's full band */
  closeBand: () => void
  /** the Inbox card's own key handling */
  onInboxKey: (event: KeyboardEvent) => void
  /** the conversation screen's own keys (Esc closes the row's confirm and menu); omitted means no keys there */
  onChatKey?: (event: KeyboardEvent) => void
  /** the find field is over the screen */
  searchOpen?: boolean
  /** the find field's own keys (Esc closes, arrows move, Enter picks); with none given it installs nothing */
  onSearchKey?: (event: KeyboardEvent) => void
}

/**
 * Install the screen's key listener and hand back the way to remove it.
 *
 * The settings sheet, while it is up, takes only Esc: the Inbox's card keys must not move behind it.
 * The find field, while it is up, takes only its own keys: the card keys are not installed at all, so no press
 * (Enter, Esc, a digit or an arrow) can become a decision for a card hidden behind the field.
 * A screen that is not the Inbox answers only the full band's Esc; the card keys are not installed at all, so no
 * key can become a decision for a card that is not in front of the person (the keymap gates this too).
 * The Inbox installs its own card keys. The conversation screen installs only the keys its handler answers (the
 * rows' Esc); with none given it installs nothing, so its own screen never gains a key by accident.
 *
 * Installing changes nothing: no callback runs here. The band a `#work/all` open names stays open until Esc or
 * the band's own control closes it, so a redraw never drops it.
 */
export function installScreenKeys(win: KeyWindow, keys: ScreenKeys): () => void {
  if (keys.settings) {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') keys.closeSettings()
    }
    win.addEventListener('keydown', onKey)
    return () => win.removeEventListener('keydown', onKey)
  }
  if (keys.searchOpen) {
    const onSearchKey = keys.onSearchKey
    if (!onSearchKey) return () => {}
    win.addEventListener('keydown', onSearchKey)
    return () => win.removeEventListener('keydown', onSearchKey)
  }
  if (keys.view === 'chat') {
    const onChatKey = keys.onChatKey
    if (!onChatKey) return () => {}
    win.addEventListener('keydown', onChatKey)
    return () => win.removeEventListener('keydown', onChatKey)
  }
  if (keys.view !== 'inbox') {
    if (!keys.wopen) return () => {}
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') keys.closeBand()
    }
    win.addEventListener('keydown', onKey)
    return () => win.removeEventListener('keydown', onKey)
  }
  win.addEventListener('keydown', keys.onInboxKey)
  return () => win.removeEventListener('keydown', keys.onInboxKey)
}
