/**
 * Is the render reproducible? Storage design question 3 hangs on this: if the
 * same ResumeDocument + template + renderer always produces the same PDF, we
 * can throw the PDF away and regenerate it on demand instead of storing it.
 *
 *   node src/determinism.mjs
 *
 * Renders the same document twice, a second apart, and compares:
 *   - raw sha256 of the two files
 *   - sha256 after normalising the one field Chrome stamps with wall-clock time
 *   - the extracted text
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPdf } from './render.mjs'
import { extractPdfText } from './check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** Blank out /CreationDate and /ModDate so the hash is content-only. */
export function normalisePdf(buf) {
  const s = buf.toString('latin1')
  const out = s
    .replace(/\/CreationDate \(D:\d{14}[^)]*\)/g, (m) =>
      '/CreationDate (D:00000000000000+00\'00\')'.padEnd(m.length, ' '),
    )
    .replace(/\/ModDate \(D:\d{14}[^)]*\)/g, (m) =>
      '/ModDate (D:00000000000000+00\'00\')'.padEnd(m.length, ' '),
    )
  return Buffer.from(out, 'latin1')
}

const doc = JSON.parse(
  readFileSync(resolve(root, 'fixtures/resume.sample.json'), 'utf8'),
)

const a = resolve(root, 'out/det-a.pdf')
const b = resolve(root, 'out/det-b.pdf')

renderPdf(doc, 'ats', a)
await new Promise((r) => setTimeout(r, 1100)) // guarantee a different second
renderPdf(doc, 'ats', b)

const bufA = readFileSync(a)
const bufB = readFileSync(b)

let differing = 0
for (let i = 0; i < Math.min(bufA.length, bufB.length); i++) {
  if (bufA[i] !== bufB[i]) differing++
}

const textA = (await extractPdfText(a)).text
const textB = (await extractPdfText(b)).text

console.log(`\nbytes            : ${bufA.length} vs ${bufB.length}`)
console.log(`raw sha256       : ${sha(bufA)} vs ${sha(bufB)}  ${sha(bufA) === sha(bufB) ? 'MATCH' : 'DIFFER'}`)
console.log(`differing bytes  : ${differing}`)
console.log(
  `normalised sha256: ${sha(normalisePdf(bufA))} vs ${sha(normalisePdf(bufB))}  ${
    sha(normalisePdf(bufA)) === sha(normalisePdf(bufB)) ? 'MATCH' : 'DIFFER'
  }`,
)
console.log(`extracted text   : ${textA === textB ? 'IDENTICAL' : 'DIFFERENT'}\n`)
