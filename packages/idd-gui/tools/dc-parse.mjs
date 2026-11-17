// Parser for the Design-Component (dc) template subset used by
// `propter 収束版.dc.html`. Produces a small element tree that the JSX
// emitter in gen.mjs turns into React components.
//
// Supported: elements, double-quoted attributes, text nodes with {{ }}
// interpolation, sc-if / sc-for control flow, <br> void elements.

const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link'])

export function parse(html) {
  const root = { tag: '#root', attrs: {}, kids: [] }
  const stack = [root]
  let i = 0
  const top = () => stack[stack.length - 1]

  // Mirrors the dc runtime: a text node that is only whitespace is dropped
  // unless it contains a space, because that space can still be rendered.
  const addText = (raw, start) => {
    if (!raw) return
    if (!raw.includes('{{') && !raw.trim() && !raw.includes(' ')) return
    // whitespace-only nodes are marked so the generator can decide per parent
    // whether they are renderable (they are inside flex/grid, they are not)
    const tag = raw.trim() ? '#text' : '#ws'
    top().kids.push({ tag, text: raw, start, end: start + raw.length })
  }

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      addText(html.slice(i), i)
      break
    }
    if (lt > i) addText(html.slice(i, lt), i)
    // find the end of the tag, skipping quoted attribute values
    let j = lt + 1
    let quote = null
    while (j < html.length) {
      const c = html[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') break
      j++
    }
    const raw = html.slice(lt + 1, j)
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase()
      // pop to the matching element
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack[k].end = j + 1
          stack.length = k
          break
        }
      }
    } else {
      const selfClosing = raw.endsWith('/')
      const body = selfClosing ? raw.slice(0, -1) : raw
      const m = /^([A-Za-z][\w-]*)/.exec(body)
      const tag = (m ? m[1] : '').toLowerCase()
      const attrs = {}
      const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g
      let am
      while ((am = attrRe.exec(body))) attrs[am[1]] = am[2]
      const node = { tag, attrs, kids: [], start: lt, end: j + 1 }
      top().kids.push(node)
      if (!selfClosing && !VOID.has(tag)) stack.push(node)
      else if (VOID.has(tag)) node.void = true
    }
    i = j + 1
  }
  return root
}

/** Depth-first walk. cb(node, depth, parent) */
export function walk(node, cb, depth = 0, parent = null) {
  cb(node, depth, parent)
  for (const k of node.kids || []) walk(k, cb, depth + 1, node)
}

export function findAll(root, pred) {
  const out = []
  walk(root, (n) => {
    if (pred(n)) out.push(n)
  })
  return out
}
