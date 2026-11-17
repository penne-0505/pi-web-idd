// Generates the React components that make up the pc 収束版 screen.
//
// The design source is the repo's own prototype. `..` walks tools → idd-gui → packages →
// the repo root, so a regenerated part can always be traced back to one file under `_meta/`.
//
// The dc template is a small HTML dialect:
//   {{ expr }}                            → interpolation
//   <sc-if value="{{ expr }}">…</sc-if>   → conditional
//   <sc-for list="{{ expr }}" as="x">…</sc-for> → list
//   style="a:b;c:{{ x }}px"               → inline style object
//   style-hover="background:#fff"         → generated :hover class (!important,
//                                           matching the dc runtime, which wins
//                                           over the inline style)
//
// Each spec becomes one component file. `subs` swaps a subtree (or a child
// slice) for another component, which is how the boundaries from
// `コンポーネント一覧.md` are expressed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from './dc-parse.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = path.resolve(HERE, '..')
const SRC = path.resolve(HERE, '../../../_meta/gui-prototype/2026-10-07/propter 収束版.dc.html')

// ---------------------------------------------------------------- load tree
const raw = fs.readFileSync(SRC, 'utf8')
const dcStart = raw.indexOf('<x-dc>') + 6
const body = raw.slice(dcStart, raw.lastIndexOf('</x-dc>'))
const htmlStart = body.indexOf('</helmet>') + '</helmet>'.length
const root = parse(body.slice(htmlStart))
const lineOf = (offset) => raw.slice(0, dcStart + htmlStart + offset).split('\n').length

/** Children that take part in the spec paths (whitespace-only nodes do not). */
const kidsOf = (n) => (n.kids || []).filter((k) => k.tag !== '#ws')

const at = (p) => {
  let n = root
  for (const i of p) {
    const k = n.kids && kidsOf(n)[i]
    if (!k) throw new Error(`bad path [${p}] at ${i}`)
    n = k
  }
  return n
}
const byTag = (tag, attr, value, pick = 0) => {
  const hits = []
  const visit = (n) => {
    if (n.tag === tag && n.attrs[attr] === value) hits.push(n)
    ;(n.kids || []).forEach(visit)
  }
  visit(root)
  if (!hits[pick]) throw new Error(`${tag} ${attr}=${value}: no match #${pick} (${hits.length})`)
  return hits[pick]
}

// ------------------------------------------------------------- jsx emission
const hoverNames = new Map() // css text -> class name
const hoverBodies = new Map() // class name -> css text

function hoverClass(css) {
  const key = css.trim()
  if (!hoverNames.has(key)) {
    const name = 'hv' + (hoverNames.size + 1)
    hoverNames.set(key, name)
    hoverBodies.set(
      name,
      toTokenRefs(key)
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d + ' !important')
        .join(';'),
    )
  }
  return hoverNames.get(key)
}

// Design tokens (トークン.md). The placeholder colours and fonts are declared
// once in src/styles/tokens.css; every literal that matches a token is swapped
// for a var() reference so the theme can be replaced in one place.
// Design tokens (トークン.md). Every literal the template uses is declared once
// in src/styles/tokens.css; the generator swaps it for a var() reference so the
// theme can be replaced in one place and no component hard-codes a value.
//
// トークン.md lists one value per role. The 収束版 file also contains a few
// second values for the attention / sign / ok roles; they are kept as separate
// `*-alt` tokens (so the default look is exactly the file's) and documented in
// tokens.css.
const TOKENS = [
  // 墨と地
  ['#fff', 'surface'],
  ['#faf9f6', 'bg-page'],
  ['#f7f6f2', 'surface-sunk'],
  ['#f5f4f0', 'bg-inbox'],
  ['#f2f1ec', 'bg-sidebar'],
  ['#efeee9', 'bg-panel'],
  ['#efede8', 'bg-panel-alt'],
  ['#ecebe6', 'line-soft'],
  ['#e6e5e0', 'bg-canvas'],
  ['#e6e4de', 'bg-hover'],
  ['#e3e1db', 'line'],
  ['#d6d3cc', 'line-strong'],
  ['#c9c6be', 'mute-2'],
  ['#b9b6ae', 'mute-1'],
  ['#8a877f', 'ink-3'],
  ['#57554f', 'ink-2'],
  ['#1c1b19', 'ink'],
  ['#ebe8e0', 'surface-warm-line'],
  ['oklch(0.975 0.006 85)', 'surface-warm'],
  // 役割の色（トークン.md）+ ファイル側にもう 1 つあった値
  ['oklch(0.96 0.025 40)', 'attention-bg'],
  ['oklch(0.95 0.03 40)', 'attention-bg-alt'],
  ['oklch(0.985 0.008 40)', 'attention-bg-soft'],
  ['oklch(0.6 0.15 40)', 'attention'],
  ['oklch(0.55 0.15 40)', 'attention-alt'],
  ['oklch(0.5 0.14 40)', 'attention-text'],
  ['oklch(0.45 0.13 40)', 'attention-text-alt'],
  ['oklch(0.75 0.1 40)', 'attention-border'],
  ['oklch(0.96 0.02 265)', 'sign-bg'],
  ['oklch(0.95 0.03 265)', 'sign-bg-alt'],
  ['oklch(0.985 0.008 265)', 'sign-bg-soft'],
  ['oklch(0.55 0.15 265)', 'sign'],
  ['oklch(0.42 0.14 265)', 'sign-text'],
  ['oklch(0.45 0.14 265)', 'sign-text-alt'],
  ['oklch(0.5 0.15 265)', 'sign-text-badge'],
  ['oklch(0.9 0.05 265)', 'sign-gate'],
  ['oklch(0.45 0.14 300)', 'external'],
  ['oklch(0.95 0.035 300)', 'external-bg'],
  ['oklch(0.62 0.15 150)', 'ok'],
  ['oklch(0.45 0.13 150)', 'ok-text'],
  ['oklch(0.96 0.03 150)', 'ok-bg'],
  ['oklch(0.94 0.04 150)', 'ok-bg-alt'],
  ['oklch(0.95 0.04 150)', 'ok-bg-chip'],
  ['oklch(0.42 0.12 150)', 'ok-text-alt'],
  ['oklch(0.45 0.12 80)', 'inbound'],
  // コード片（構文の色）と影
  ['#1f1e1c', 'code-bg'],
  ['#e8e6e1', 'code-ink'],
  ['#a09d96', 'code-head-ink'],
  ['oklch(0.78 0.11 40)', 'code-keyword'],
  ['oklch(0.5 0.13 40)', 'code-keyword-alt'],
  ['oklch(0.8 0.1 150)', 'code-string'],
  ['#3a3935', 'send-hover'],
  ['0 10px 30px rgba(28,27,25,.14)', 'shadow-pop'],
  ['0 24px 60px rgba(28,27,25,.25)', 'shadow-sheet'],
  ['-12px 0 32px rgba(28,27,25,.12)', 'shadow-panel'],
  ['0 12px 40px rgba(28,27,25,.12)', 'shadow-window'],
  ['0 1px 3px rgba(0,0,0,.15)', 'dial-shadow'],
  ['rgba(28,27,25,.22)', 'scrim'],
  ['rgba(0,0,0,.12)', 'window-line'],
  ['rgba(255,255,255,.4)', 'key-line-on-dark'],
  // 能力の印（地 oklch(0.95 0.04 H) / 線 oklch(0.45 0.13 H)）
  ['oklch(0.95 0.04 250)', 'cap-vision-bg'],
  ['oklch(0.45 0.13 250)', 'cap-vision-line'],
  ['oklch(0.95 0.04 320)', 'cap-video-bg'],
  ['oklch(0.45 0.13 320)', 'cap-video-line'],
  ['oklch(0.95 0.04 155)', 'cap-audio-bg'],
  ['oklch(0.45 0.13 155)', 'cap-audio-line'],
  ['oklch(0.95 0.04 70)', 'cap-tool-bg'],
  ['oklch(0.45 0.13 70)', 'cap-tool-line'],
  // 動き（雛形の transition に直書きされている曲線）
  ['cubic-bezier(.25,1,.5,1)', 'ease-out'],
  ['cubic-bezier(.4,0,.9,.6)', 'ease-in'],
  ['cubic-bezier(.2,0,.2,1)', 'ease-pop'],
  // 書体
  // single-quoted and escaped so tools/tokenize.mjs can read this table back out of the source
  ['\'IBM Plex Sans JP\'', 'font-sans'],
  ['\'IBM Plex Mono\'', 'font-mono'],
]
const TOKEN_RE = new RegExp(
  '(' + [...TOKENS].sort((a, b) => b[0].length - a[0].length).map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
  'g',
)
const TOKEN_LOOKUP = new Map(TOKENS)
// Reads as a verb, not a hook: the name `useTokens` made the lint rule for hooks reject it. It only rewrites a
// template value to `var(--token)` references, so no state and no hook is involved.
const toTokenRefs = (v) => v.replace(TOKEN_RE, (hit) => `var(--${TOKEN_LOOKUP.get(hit)})`)

const cssProp = (p) =>
  p.startsWith('--')
    ? p
    : p.replace(/^-([a-z])/, (_, c) => c.toUpperCase()).replace(/-([a-z])/g, (_, c) => c.toUpperCase())

const TPL = /\{\{([\s\S]+?)\}\}/g
const isWholeInterp = (v) => /^\s*\{\{[\s\S]+?\}\}\s*$/.test(v)
const exprOf = (v) => v.trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim()

function valueLiteral(v) {
  if (isWholeInterp(v)) return exprOf(v)
  if (v.includes('{{')) {
    const parts = v.split(TPL)
    return '`' + parts.map((p, i) => (i % 2 ? '${' + p.trim() + '}' : p.replace(/`/g, '\\`'))).join('') + '`'
  }
  return JSON.stringify(v)
}

function styleToObject(css) {
  // a later declaration wins, like CSS — the template does repeat properties
  const entries = new Map()
  for (const decl of css.split(';')) {
    const d = decl.trim()
    if (!d) continue
    const i = d.indexOf(':')
    if (i < 0) throw new Error('bad style declaration: ' + JSON.stringify(d))
    const prop = cssProp(d.slice(0, i).trim())
    if (!entries.has(prop)) entries.set(prop, null)
    entries.set(prop, `${prop}: ${valueLiteral(toTokenRefs(d.slice(i + 1).trim()))}`)
  }
  return `{ ${[...entries.values()].join(', ')} }`
}

/** True when the element lays its children out as flex/grid items, where a
 *  whitespace-only text node is not rendered at all (so it can be dropped). */
const isItemLayout = (node) => /display\s*:\s*(inline-)?(flex|grid)/.test(node.attrs?.style ?? '')

/** HTML collapses runs of whitespace; JSX would additionally trim text at the
 *  edges of every line, so whitespace edges go through a string expression. */
function textJsx(t, pre) {
  const norm = pre ? t : t.replace(/\s+/g, ' ')
  if (!norm) return ''
  return norm
    .split(TPL)
    .map((p, i) => {
      if (i % 2) return `{${p.trim()}}`
      if (!p) return ''
      if (norm === ' ') return "{' '}"
      if (p === ' ') return "{' '}"
      if (pre || /^\s|\s$|[\n{}<>'"]/.test(p)) return `{${JSON.stringify(p)}}`
      return p
    })
    .join('')
}

const camelAttr = (k) => (k === 'class' ? 'className' : k === 'for' ? 'htmlFor' : k)

/** `white-space: pre` keeps the source text verbatim. */
const isPre = (node) => !!node && /white-space\s*:\s*pre/.test(node.attrs?.style ?? '')

const indent = (code, pad) =>
  code
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n')

/** Emits the children of `node`. `subs` replaces child indices / slices. */
function emitKids(node, ctx, subs = {}) {
  const out = []
  const item = isItemLayout(node)
  let visible = -1
  let skip = 0
  const kids = node.kids || []
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i]
    if (kid.tag === '#ws') {
      // between flex/grid items white space is not rendered at all
      if (!item) out.push("{' '}")
      continue
    }
    visible++
    if (skip > 0) {
      skip--
      continue
    }
    const sliceKey = Object.keys(subs).find((k) => k.includes('-') && Number(k.split('-')[0]) === visible)
    if (sliceKey) {
      const [from, to] = sliceKey.split('-').map(Number)
      out.push(`<${subs[sliceKey].comp} m={m} />`)
      skip = to - from - 1
      continue
    }
    if (subs[visible]) {
      out.push(`<${subs[visible].comp} m={m} />`)
      continue
    }
    out.push(emitNode(kid, ctx, [], {}, node))
  }
  return out.filter((s) => s !== '').join('\n')
}

function emitNode(node, ctx, extraProps = [], subs = {}, preOwner) {
  if (node.tag === '#ws') return "{' '}"
  if (node.tag === '#text') return textJsx(node.text, isPre(preOwner))
  if (node.tag === 'sc-if') {
    const cond = exprOf(node.attrs.value)
    const sole = node.kids.length === 1 ? node.kids[0] : null
    const inner =
      sole && !['#text', 'sc-if', 'sc-for'].includes(sole.tag)
        ? emitNode(sole, ctx)
        : `<>\n${emitKids(node, ctx)}\n</>`
    return `{${cond} ? (\n${indent(inner, '  ')}\n) : null}`
  }
  if (node.tag === 'sc-for') {
    const list = exprOf(node.attrs.list)
    const as = node.attrs.as
    const sole = node.kids.length === 1 ? node.kids[0] : null
    if (sole && !['#text', 'sc-if', 'sc-for'].includes(sole.tag)) {
      return `{${list}.map((${as}, $i) => ${emitNode(sole, ctx, [`key={$i}`])})}`
    }
    ctx.usesFragment = true
    return `{${list}.map((${as}, $i) => (\n<Fragment key={$i}>\n${indent(emitKids(node, ctx), '  ')}\n</Fragment>\n))}`
  }
  const attrs = []
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.startsWith('hint-') || k === 'data-dc-tpl') continue
    if (k === 'style') attrs.push(`style={${styleToObject(v)}}`)
    else if (k.startsWith('style-')) {
      const cls = hoverClass(v)
      ctx.hoverClasses.push(cls)
      attrs.push(`className="${cls}"`)
    } else attrs.push(`${camelAttr(k)}=${isWholeInterp(v) ? `{${exprOf(v)}}` : valueLiteral(v)}`)
  }
  const attrStr = [...extraProps, ...attrs].length ? ' ' + [...extraProps, ...attrs].join(' ') : ''
  if (node.void || !node.kids || !node.kids.length) return `<${node.tag}${attrStr} />`
  const inner = emitKids(node, ctx, subs)
  if (!inner.trim()) return `<${node.tag}${attrStr} />`
  return `<${node.tag}${attrStr}>\n${indent(inner, '  ')}\n</${node.tag}>`
}

// -------------------------------------------------------- identifier header
function collectIdents(nodes) {
  const loopVars = new Set()
  const idents = new Set()
  const add = (expr) => {
    const first = expr.trim().split(/[.()[\]\s]/)[0]
    if (!/^[A-Za-z_$][\w$]*$/.test(first)) return
    if (['true', 'false', 'null', 'undefined'].includes(first)) return
    if (loopVars.has(first)) return
    idents.add(first)
  }
  const visit = (n) => {
    if (n.tag === 'sc-for') {
      for (const m of (n.attrs.list || '').matchAll(TPL)) add(m[1])
      loopVars.add(n.attrs.as)
      ;(n.kids || []).forEach(visit)
      return
    }
    if (n.tag === '#text') {
      for (const m of n.text.matchAll(TPL)) add(m[1])
      return
    }
    if (n.tag === '#ws') return
    for (const [k, v] of Object.entries(n.attrs || {})) {
      if (k.startsWith('hint-')) continue
      for (const m of (v || '').matchAll(TPL)) add(m[1])
    }
    ;(n.kids || []).forEach(visit)
  }
  nodes.forEach(visit)
  return [...idents].sort()
}

// ------------------------------------------------------------------- spec
const n = (p) => ({ kind: 'node', path: p })
const k = (p, from, to) => ({ kind: 'kids', path: p, from, to })
const ifv = (v, pick = 0) => ({ kind: 'if', value: v, pick })
const forv = (v, pick = 0) => ({ kind: 'for', value: v, pick })

function resolveSel(sel) {
  if (sel.kind === 'node') return [at(sel.path)]
  if (sel.kind === 'kids') return kidsOf(at(sel.path)).slice(sel.from, sel.to)
  if (sel.kind === 'if') return [byTag('sc-if', 'value', sel.value, sel.pick ?? 0)]
  if (sel.kind === 'for') return [byTag('sc-for', 'list', sel.value, sel.pick ?? 0)]
  throw new Error('unknown sel')
}

const PARTS = [
  // ------------------------------------------------------------- app shell
  { file: 'shell/TitleBar.tsx', name: 'TitleBar', sel: n([0, 1, 0]) },
  { file: 'shell/Rail.tsx', name: 'Rail', sel: n([0, 1, 1, 0, 0, 0]) },
  { file: 'shell/InboxSidebar.tsx', name: 'InboxSidebar', sel: n([0, 1, 1, 0, 0, 1, 0]) },
  { file: 'shell/WorkSidebar.tsx', name: 'WorkSidebar', sel: n([0, 1, 1, 0, 0, 2, 0]) },
  { file: 'shell/ChatSidebar.tsx', name: 'ChatSidebar', sel: n([0, 1, 1, 0, 0, 3, 0]) },
  { file: 'shell/SettingsButton.tsx', name: 'SettingsButton', sel: n([0, 1, 1, 0, 0, 4]) },

  // ---------------------------------------------------------------- inbox
  { file: 'inbox/InboxProgress.tsx', name: 'InboxProgress', sel: n([0, 1, 1, 1, 0, 0, 0]) },
  { file: 'inbox/cards/CardGo.tsx', name: 'CardGo', sel: n([0, 1, 1, 1, 0, 0, 2, 0, 0]) },
  { file: 'inbox/cards/CardQuestion.tsx', name: 'CardQuestion', sel: n([0, 1, 1, 1, 0, 0, 3, 0, 0]) },
  { file: 'inbox/cards/CardSubmit.tsx', name: 'CardSubmit', sel: n([0, 1, 1, 1, 0, 0, 4, 0, 0]) },
  { file: 'inbox/cards/CardPost.tsx', name: 'CardPost', sel: n([0, 1, 1, 1, 0, 0, 5, 0, 0]) },
  { file: 'inbox/cards/CardReview.tsx', name: 'CardReview', sel: n([0, 1, 1, 1, 0, 0, 6, 0, 0]) },
  { file: 'inbox/cards/CardStuck.tsx', name: 'CardStuck', sel: n([0, 1, 1, 1, 0, 0, 7, 0, 0]) },
  { file: 'inbox/cards/CardDuplicate.tsx', name: 'CardDuplicate', sel: n([0, 1, 1, 1, 0, 0, 8, 0, 0]) },
  { file: 'inbox/cards/CardReimport.tsx', name: 'CardReimport', sel: n([0, 1, 1, 1, 0, 0, 9, 0, 0]) },
  { file: 'inbox/CardActions.tsx', name: 'CardActions', sel: n([0, 1, 1, 1, 0, 0, 10]) },

  // ----------------------------------------------------------------- work
  { file: 'work/WorkMiniMap.tsx', name: 'WorkMiniMap', sel: n([0, 1, 1, 1, 1, 0, 0, 0]) },
  {
    file: 'work/WorkSidebarColumn.tsx',
    name: 'WorkSidebarColumn',
    sel: n([0, 1, 1, 1, 1, 0, 0]),
    subs: { 0: { comp: 'WorkMiniMap' }, '1-5': { comp: 'WorkLaneList' } },
  },
  { file: 'work/WorkLaneList.tsx', name: 'WorkLaneList', sel: k([0, 1, 1, 1, 1, 0, 0], 1, 5) },
  {
    file: 'work/WorkDetail.tsx',
    name: 'WorkDetail',
    sel: n([0, 1, 1, 1, 1, 0, 1]),
    subs: { 0: { comp: 'ProjectSummary' }, 1: { comp: 'WorkDetailSelected' }, 2: { comp: 'WorkAskInput' } },
  },
  { file: 'work/ProjectSummary.tsx', name: 'ProjectSummary', sel: ifv('{{ W.noSel }}') },
  { file: 'work/WorkAskInput.tsx', name: 'WorkAskInput', sel: n([0, 1, 1, 1, 1, 0, 1, 2]) },
  {
    file: 'work/WorkDetailSelected.tsx',
    name: 'WorkDetailSelected',
    sel: ifv('{{ W.hasSel }}'),
    subs: {
      1: { comp: 'LaneContextStrip' },
      2: { comp: 'WorkTabs' },
      3: { comp: 'WorkStageTable' },
      4: { comp: 'WorkDecList' },
      5: { comp: 'WorkFindings' },
    },
  },
  { file: 'work/LaneContextStrip.tsx', name: 'LaneContextStrip', sel: ifv('{{ W.d.live }}') },
  { file: 'work/WorkTabs.tsx', name: 'WorkTabs', sel: n([0, 1, 1, 1, 1, 0, 1, 1, 0, 2]) },
  { file: 'work/WorkStageTable.tsx', name: 'WorkStageTable', sel: ifv('{{ W.tSt }}') },
  { file: 'work/WorkDecList.tsx', name: 'WorkDecList', sel: ifv('{{ W.tDec }}') },
  { file: 'work/WorkFindings.tsx', name: 'WorkFindings', sel: ifv('{{ W.tFd }}') },
  { file: 'work/WorkTimeline.tsx', name: 'WorkTimeline', sel: ifv('{{ W.ovOpen }}') },

  // ----------------------------------------------------------------- chat
  { file: 'chat/ChatHeader.tsx', name: 'ChatHeader', sel: n([0, 1, 1, 1, 2, 0]) },
  { file: 'chat/IdeaConversation.tsx', name: 'IdeaConversation', sel: n([0, 1, 1, 1, 2, 1, 0]) },
  { file: 'chat/ChatConversation.tsx', name: 'ChatConversation', sel: n([0, 1, 1, 1, 2, 1, 1]) },
  { file: 'chat/Composer.tsx', name: 'Composer', sel: n([0, 1, 1, 1, 2, 1, 3]) },
  { file: 'chat/QueueChip.tsx', name: 'QueueChip', sel: n([0, 1, 1, 1, 2, 1, 3, 0]) },
  { file: 'chat/ModelPicker.tsx', name: 'ModelPicker', sel: ifv('{{ popModel }}') },
  { file: 'chat/EffortSlider.tsx', name: 'EffortSlider', sel: ifv('{{ popEffort }}') },
  { file: 'chat/ContextPopover.tsx', name: 'ContextPopover', sel: ifv('{{ popCtx }}') },

  // ---------------------------------------------------------- right panel
  { file: 'panels/KindPanelGo.tsx', name: 'KindPanelGo', sel: ifv('{{ rp_go }}') },
  { file: 'panels/KindPanelQuestion.tsx', name: 'KindPanelQuestion', sel: ifv('{{ rp_q }}') },
  { file: 'panels/KindPanelSubmit.tsx', name: 'KindPanelSubmit', sel: ifv('{{ rp_sub }}') },
  { file: 'panels/KindPanelPost.tsx', name: 'KindPanelPost', sel: ifv('{{ rp_post }}') },
  { file: 'panels/KindPanelReview.tsx', name: 'KindPanelReview', sel: ifv('{{ rp_pr }}') },
  { file: 'panels/KindPanelStuck.tsx', name: 'KindPanelStuck', sel: ifv('{{ rp_stuck }}') },
  { file: 'panels/KindPanelDuplicate.tsx', name: 'KindPanelDuplicate', sel: ifv('{{ rp_dup }}') },
  { file: 'panels/KindPanelReimport.tsx', name: 'KindPanelReimport', sel: ifv('{{ rp_re }}') },
  { file: 'panels/IdeaDocPanel.tsx', name: 'IdeaDocPanel', sel: ifv('{{ vChatIdea }}') },
  { file: 'panels/ChatPanel.tsx', name: 'ChatPanel', sel: ifv('{{ vChatChat }}') },

  // ------------------------------------------------------------- settings
  { file: 'settings/SettingsNav.tsx', name: 'SettingsNav', sel: n([0, 1, 2, 1, 0]) },
  {
    file: 'settings/SettingsBody.tsx',
    name: 'SettingsBody',
    sel: n([0, 1, 2, 1, 1]),
    subs: {
      0: { comp: 'SettingsHeader' },
      1: { comp: 'SettingsLaneStages' },
      2: { comp: 'SettingsProviders' },
      3: { comp: 'SettingsSkills' },
      4: { comp: 'SettingsProjects' },
      5: { comp: 'SettingsStorage' },
      6: { comp: 'SettingsPasskeys' },
      7: { comp: 'SettingsAppearance' },
      8: { comp: 'SettingsVoice' },
    },
  },
  { file: 'settings/SettingsHeader.tsx', name: 'SettingsHeader', sel: k([0, 1, 2, 1, 1], 0, 1) },
  { file: 'settings/SettingsLaneStages.tsx', name: 'SettingsLaneStages', sel: ifv('{{ secLanes }}', 1) },
  { file: 'settings/SettingsProviders.tsx', name: 'SettingsProviders', sel: ifv('{{ secProv }}') },
  { file: 'settings/SettingsSkills.tsx', name: 'SettingsSkills', sel: ifv('{{ secSkills }}') },
  { file: 'settings/SettingsProjects.tsx', name: 'SettingsProjects', sel: ifv('{{ secProj }}') },
  { file: 'settings/SettingsStorage.tsx', name: 'SettingsStorage', sel: ifv('{{ secConv }}') },
  { file: 'settings/SettingsPasskeys.tsx', name: 'SettingsPasskeys', sel: ifv('{{ secKey }}') },
  { file: 'settings/SettingsAppearance.tsx', name: 'SettingsAppearance', sel: ifv('{{ secView }}') },
  { file: 'settings/SettingsVoice.tsx', name: 'SettingsVoice', sel: ifv('{{ secVoice }}') },
]

const registry = new Map(PARTS.map((p) => [p.name, p.file]))

let written = 0
for (const spec of PARTS) {
  const nodes = resolveSel(spec.sel)
  const ctx = { hoverClasses: [], usesFragment: false }
  const jsx =
    spec.sel.kind === 'for'
      ? emitNode(nodes[0], ctx)
      : nodes.map((nd) => emitNode(nd, ctx, [], spec.subs ?? {})).filter(Boolean).join('\n')

  const idents = collectIdents(nodes)
  const depth = spec.file.split('/').length - 1
  const modelPath = '../'.repeat(depth + 1) + 'model/model'
  const imports = [`import type { Model } from '${modelPath}'`]
  if (ctx.usesFragment) imports.push(`import { Fragment } from 'react'`)
  const subFiles = new Set(Object.values(spec.subs ?? {}).map((s) => s.comp))
  for (const comp of subFiles) {
    const file = registry.get(comp)
    if (!file) throw new Error(`sub component ${comp} is not generated by any spec`)
    const from = file.split('/').slice(0, -1).join('/')
    const to = spec.file.split('/').slice(0, -1).join('/')
    imports.push(`import { ${comp} } from '${from === to ? './' : '../' + from + '/'}${comp}'`)
  }
  const lines = [
    '// Ported from `propter 収束版.dc.html` — generated by tools/gen.mjs.',
    `// source lines: ${lineOf(nodes[0].start)}–${lineOf(nodes[nodes.length - 1].end - 1)}`,
    ...imports,
    '',
    `export function ${spec.name}({ m }: { m: Model }) {`,
    ...(idents.length ? [`  const { ${idents.join(', ')} } = m`] : []),
    '  return (',
    '    <>',
    indent(jsx, '      '),
    '    </>',
    '  )',
    '}',
    '',
  ]
  const outFile = path.join(OUT_ROOT, 'src/components', spec.file)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, lines.join('\n'))
  written++
}

// ------------------------------------------------------------- container styles
// Layout boxes that the hand-written wrappers (AppShell and friends) render are
// pulled straight out of the template so their values cannot drift.
const CONTAINERS = [
  ['appFrame', [0, 1]],
  ['titleRow', [0, 1, 1]],
  ['sidebar', [0, 1, 1, 0, 0]],
  ['mainColumn', [0, 1, 1, 1]],
  ['inboxView', [0, 1, 1, 1, 0, 0]],
  ['workGrid', [0, 1, 1, 1, 1, 0]],
  ['rightPanel', [0, 1, 1, 2, 0]],
  ['chatColumn', [0, 1, 1, 1, 2, 1]],
]
const containerLines = [
  '// Generated by tools/gen.mjs from the template containers — do not edit.',
  "import type { CSSProperties } from 'react'",
  '',
]
for (const [name, p] of CONTAINERS) {
  const node = at(p)
  const css = node.attrs.style
  if (/\{\{/.test(css)) {
    throw new Error(`container ${name} has interpolations; keep it hand-written`)
  }
  // The template drew the app as a fixed 1440×900 card centred on a canvas. The window the screen is opened in has
  // no fixed size, so the frame fills it instead; the values inside (the sidebar, the right panel, the work grid,
  // the conversation column) stay exactly as the template wrote them, and the free space is absorbed around them.
  const fitted =
    name === 'appFrame'
      ? `${css.replace('width:1440px', 'width:100%').replace('height:900px', 'height:100%')};box-sizing:border-box`
      : css
  containerLines.push(`export const ${name}: CSSProperties = ${styleToObject(fitted)}`)
  containerLines.push('')
}
fs.mkdirSync(path.join(OUT_ROOT, 'src/styles'), { recursive: true })
fs.writeFileSync(path.join(OUT_ROOT, 'src/styles/containers.ts'), containerLines.join('\n'))

// ----------------------------------------------------------------- hover sheet
const rules = [...hoverBodies].map(([name, css]) => `.${name}:hover { ${css} }`)
const header = '/* generated by tools/gen.mjs — the dc `style-hover` rules. */\n'
fs.mkdirSync(path.join(OUT_ROOT, 'src/styles'), { recursive: true })
fs.writeFileSync(path.join(OUT_ROOT, 'src/styles/hover.css'), header + rules.join('\n') + '\n')

console.log(`generated ${written} components, ${rules.length} hover rules`)
