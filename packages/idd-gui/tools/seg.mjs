// Prints every node whose start line falls in [a,b]. Usage: node tools/seg.mjs 233-330
import { load } from './outline.mjs'
const { root, lineOf } = load()
const [a, b] = process.argv[2].split('-').map(Number)
const visit = (n, depth, path) => {
  if (n.tag !== '#text') {
    const l0 = lineOf(n.start)
    if (l0 >= a - 1 && l0 <= b) {
      const label =
        n.tag === 'sc-if'
          ? `sc-if ${n.attrs.value}`
          : n.tag === 'sc-for'
            ? `sc-for ${n.attrs.list} as ${n.attrs.as}`
            : `<${n.tag}>`
      console.log(`${'  '.repeat(depth)}L${l0}–${lineOf(n.end - 1)} [${path.join(',')}] ${label}`)
    }
  }
  ;(n.kids || []).forEach((c, i) => visit(c, depth + 1, [...path, i]))
}
visit(root, 0, [])
