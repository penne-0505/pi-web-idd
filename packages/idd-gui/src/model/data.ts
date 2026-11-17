// The prototype's own token tables, kept verbatim from the `Component` class in
// `propter 収束版.dc.html` (source lines 707–760). The lane, DEC and finding sample rows that used to live
// beside them are gone: the Work screen draws the engine's values now (`src/work/viewmodel.ts`), and a sample
// row left here would be a row the screen never asked the engine for (DEC-103-1).

/** Role colours (トークン.md): attention = 判断が要る, sign = 署名が要る. */
export const ATT = 'var(--attention)'
export const SIGN = 'var(--sign)'

/** A bar on a lane strip, as the prototype's style table names the states. */
export type BarKind = 'past' | 'fut' | 'q' | 'stP' | 'stF' | 'usual' | 'sign' | 'fail' | 'unk'

export type Severity = 'must' | 'should' | 'nit'

/** Bar styles per state: [fill, border]. */
export const STY: Record<BarKind, [string, string]> = {
  past: ['var(--ink-3)', 'none'],
  fut: ['var(--line)', 'none'],
  q: ['transparent', '1.5px dashed var(--mute-1)'],
  stP: ['var(--attention)', 'none'],
  stF: ['transparent', '1.5px dashed var(--attention)'],
  usual: ['var(--ink-3)', 'none'],
  sign: ['var(--sign)', 'none'],
  fail: ['var(--attention)', 'none'],
  unk: ['linear-gradient(90deg,var(--line-strong),transparent)', 'none'],
}

/** Finding severity: [strong, tint, text]. */
export const SEV: Record<Severity, [string, string, string]> = {
  must: ['var(--attention)', 'var(--attention-bg)', 'var(--attention-text)'],
  should: ['var(--ink)', 'var(--line-soft)', 'var(--ink)'],
  nit: ['var(--mute-1)', 'var(--bg-sidebar)', 'var(--ink-2)'],
}

export const INBOX_KINDS = ['go', 'q', 'sub', 'post', 'pr', 'stuck', 'dup', 're'] as const
export type CardKind = (typeof INBOX_KINDS)[number]

/** The screens the shell shows. One name for one screen: the URL, the rail and the query all say `work`. */
export type { ViewName as View } from '../view'
