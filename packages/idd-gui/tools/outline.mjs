// Prints an outline of the dc template tree (with source line numbers and the
// child-index path from the root) so component boundaries can be chosen.
// Usage: node tools/outline.mjs [text-filter]
import fs from 'node:fs'
import { parse, walk } from './dc-parse.mjs'

export function load() {
  const SRC = new URL('../../../_meta/gui-prototype/2026-10-07/propter 収束版.dc.html', import.meta.url)
  const raw = fs.readFileSync(SRC, 'utf8')
  const dcStart = raw.indexOf('<x-dc>') + 6
  const body = raw.slice(dcStart, raw.lastIndexOf('</x-dc>'))
  const htmlStart = body.indexOf('</helmet>') + '</helmet>'.length
  const html = body.slice(htmlStart)
  const root = parse(html)
  const lineOf = (offset) => raw.slice(0, dcStart + htmlStart + offset).split('\n').length
  return { raw, root, lineOf }
}

const isMain = process.argv[1] && process.argv[1].endsWith('outline.mjs')
if (isMain) {
  const { root, lineOf } = load()
  const filter = process.argv[2]
  const indent = (d) => '  '.repeat(d)
  const visit = (n, depth, path) => {
    if (n.tag === '#text') {
      const t = n.text.replace(/\s+/g, ' ').trim()
      if (!filter || t.includes(filter)) {
        console.log(`${indent(depth)}L${lineOf(n.start)} # ${JSON.stringify(t.length > 80 ? t.slice(0, 80) + '…' : t)}`)
      }
      return
    }
    const isCtrl = n.tag === 'sc-if' || n.tag === 'sc-for'
    const label =
      n.tag === 'sc-if'
        ? `sc-if ${n.attrs.value}`
        : n.tag === 'sc-for'
          ? `sc-for ${n.attrs.list} as ${n.attrs.as}`
          : n.tag === '#root'
            ? '#root'
            : `<${n.tag}>`
    const show = !filter || isCtrl || label.includes(filter)
    if (show && (isCtrl || depth <= 2)) {
      console.log(
        `${indent(depth)}L${lineOf(n.start)}–${lineOf(n.end - 1)} ${label} [kids=${n.kids?.length ?? 0}] path=[${path.join(',')}]`,
      )
    }
    ;(n.kids || []).forEach((k, i) => visit(k, depth + 1, [...path, i]))
  }
  visit(root, 0, [])
}
