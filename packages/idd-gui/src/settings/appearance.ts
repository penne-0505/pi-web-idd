/**
 * The appearance three rows: the type size, the motion, and whether the Inbox's arrow keys send a card's
 * judgement (C-171-6). They are the screen's own values: nothing here is sent to the engine, and the same
 * browser keeps them (C-171-5). The rows that have no decided meaning (the dark theme, Density, Sidebar sort)
 * are not here, because a value this file invented would read as the engine's.
 *
 * The value is one small record in `localStorage`. What it does on screen is one attribute and one variable on
 * the document element, so a row takes effect the moment it is pressed and the effect survives a reload.
 */

/** the type sizes the slider steps through, and the one the ported components' own px are drawn at */
export const FONT_PX = [12, 13, 14, 15, 16] as const
export const FONT_DEFAULT_PX = 13

export interface Appearance {
  /** the screen's type size in px */
  fontPx: number
  /** whether the template's transforms and transitions are held still */
  reduceMotion: boolean
  /** whether ← → ↓ send a card's judgement in the Inbox */
  arrowKeys: boolean
}

export const DEFAULT_APPEARANCE: Appearance = { fontPx: FONT_DEFAULT_PX, reduceMotion: false, arrowKeys: true }

/** the key one browser keeps the three rows under (C-171-5) */
export const APPEARANCE_KEY = 'propter.appearance'

/** the scale the whole frame is drawn at, against the px the ported components were written in */
export function zoomOf(fontPx: number): number {
  return clampFontPx(fontPx) / FONT_DEFAULT_PX
}

export function clampFontPx(fontPx: number): number {
  if (!Number.isFinite(fontPx)) return FONT_DEFAULT_PX
  const rounded = Math.round(fontPx)
  const first = FONT_PX[0]
  const last = FONT_PX[FONT_PX.length - 1]
  return rounded < first ? first : rounded > last ? last : rounded
}

/** the stored record, or the defaults for a value that is absent, unreadable, or of the wrong shape */
export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return { ...DEFAULT_APPEARANCE }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_APPEARANCE }
  const o = parsed as Record<string, unknown>
  return {
    fontPx: typeof o.fontPx === 'number' ? clampFontPx(o.fontPx) : DEFAULT_APPEARANCE.fontPx,
    reduceMotion: typeof o.reduceMotion === 'boolean' ? o.reduceMotion : DEFAULT_APPEARANCE.reduceMotion,
    arrowKeys: typeof o.arrowKeys === 'boolean' ? o.arrowKeys : DEFAULT_APPEARANCE.arrowKeys,
  }
}

export interface AppearanceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** the browser's own record; a browser that refuses storage (private mode) answers the defaults */
export function readAppearance(storage: AppearanceStorage | null | undefined): Appearance {
  try {
    return parseAppearance(storage?.getItem(APPEARANCE_KEY))
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function saveAppearance(storage: AppearanceStorage | null | undefined, value: Appearance): void {
  try {
    storage?.setItem(APPEARANCE_KEY, JSON.stringify(value))
  } catch {
    /* a browser that refuses storage still keeps the value for this page's life */
  }
}

export function setAppearance(current: Appearance, patch: Partial<Appearance>): Appearance {
  return {
    fontPx: patch.fontPx === undefined ? current.fontPx : clampFontPx(patch.fontPx),
    reduceMotion: patch.reduceMotion ?? current.reduceMotion,
    arrowKeys: patch.arrowKeys ?? current.arrowKeys,
  }
}

/** the element the effect is written on; kept structural so a test needs no DOM */
export interface AppearanceTarget {
  style: { setProperty(name: string, value: string): void }
  dataset: Record<string, string | undefined>
}

/**
 * Put the value on the element the sheet's frame is drawn in: the type size as the frame's zoom (with the box
 * divided by the same scale so the frame still fills the window), the motion as one attribute global.css reads.
 * A row that is off is written as absent, so a stale value never keeps the effect on.
 */
export function applyAppearance(target: AppearanceTarget, value: Appearance): void {
  const scale = zoomOf(value.fontPx)
  target.style.setProperty('zoom', String(scale))
  target.style.setProperty('width', `calc(100% / ${scale})`)
  target.style.setProperty('height', `calc(100% / ${scale})`)
  if (value.reduceMotion) target.dataset.reduceMotion = '1'
  else delete target.dataset.reduceMotion
}

/** the keys the Inbox's card judgement is written on */
const ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'] as const

/**
 * Whether this keydown may become a card's judgement. With Arrow keys off, the four arrow keys answer no, so a
 * press the person switched off never reaches the engine's irreversible decision (C-171-6).
 */
export function arrowKeysAllowed(value: Appearance, key: string): boolean {
  if (value.arrowKeys) return true
  return !(ARROW_KEYS as readonly string[]).includes(key)
}
