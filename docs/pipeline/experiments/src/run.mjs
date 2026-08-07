/**
 * Render both templates from the same ResumeDocument and score both.
 *
 *   npm run experiment
 *
 * Exits non-zero if the `ats` template fails any check (it is the one we ship)
 * or if the `pretty` control passes everything (which would mean the test is
 * not discriminating and the numbers below are worthless).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPdf } from './render.mjs'
import { extractPdfText, score } from './check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const doc = JSON.parse(
  readFileSync(resolve(root, 'fixtures/resume.sample.json'), 'utf8'),
)

const results = {}

for (const template of ['ats', 'pretty']) {
  const pdf = resolve(root, `out/resume.${template}.pdf`)
  renderPdf(doc, template, pdf)
  const { text, pages } = await extractPdfText(pdf)
  const result = score(text, doc)
  results[template] = { pages, chars: text.length, ...result }

  console.log(`\n=== ${template} === ${pdf}`)
  console.log(`    ${pages} page(s), ${text.length} chars extracted`)
  for (const f of result.findings) {
    console.log(`    ${f.pass ? 'PASS' : 'FAIL'}  ${f.check.padEnd(13)} ${f.detail}`)
  }
  console.log(`    => ${result.pass ? 'ATS-CLEAN' : 'NOT ATS-CLEAN'}`)
}

console.log('\n--- summary ---')
console.log(
  `ats    : ${results.ats.findings.filter((f) => f.pass).length}/6 checks pass`,
)
console.log(
  `pretty : ${results.pretty.findings.filter((f) => f.pass).length}/6 checks pass`,
)

const ok = results.ats.pass && !results.pretty.pass
console.log(ok ? '\nresult: recommendation holds.' : '\nresult: INCONCLUSIVE.')
process.exitCode = ok ? 0 : 1
