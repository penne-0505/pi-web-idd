// Rewrites style literals in a source file into `var(--token)` references, using
// the same map the component generator uses. Idempotent — run it after adding a
// colour to a hand-written file so no value is hard-coded outside tokens.css.
//
//   node tools/tokenize.mjs src/model/model.ts src/model/data.ts
import fs from 'node:fs'

const gen = fs.readFileSync(new URL('./gen.mjs', import.meta.url), 'utf8')
const TOKENS = []
for (const m of gen.matchAll(/\['((?:[^'\\]|\\.)*)', '([a-z0-9-]+)'\]/g)) {
  TOKENS.push([m[1].replace(/\\'/g, "'"), m[2]])
}
TOKENS.sort((a, b) => b[0].length - a[0].length)
const RE = new RegExp('(' + TOKENS.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g')
const LOOKUP = new Map(TOKENS)

let changed = 0
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8')
  const out = src.replace(RE, (hit) => `var(--${LOOKUP.get(hit)})`)
  if (out !== src) {
    fs.writeFileSync(file, out)
    const n = (src.match(RE) || []).length
    console.log(`${file}: ${n} literal(s) → var()`)
    changed++
  } else {
    console.log(`${file}: unchanged`)
  }
}
console.log(`tokenized ${changed} file(s)`)
