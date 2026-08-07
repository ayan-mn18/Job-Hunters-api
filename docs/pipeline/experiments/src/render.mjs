/**
 * ResumeDocument (JSON) -> HTML -> PDF, via headless Chrome.
 *
 *   node src/render.mjs ats     out/resume.ats.pdf
 *   node src/render.mjs pretty  out/resume.pretty.pdf
 *
 * Chrome is used directly here so the experiment has no heavy dependency.
 * In the real service this is Playwright's `page.pdf()`, which drives the same
 * Chromium print pipeline and produces byte-comparable output.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TEMPLATES } from './templates.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    `No Chrome/Chromium found. Set CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`,
  )
}

export function renderPdf(doc, template, outPdf) {
  const render = TEMPLATES[template]
  if (!render) throw new Error(`unknown template: ${template}`)

  const html = render(doc)
  const outHtml = outPdf.replace(/\.pdf$/, '.html')
  mkdirSync(dirname(outPdf), { recursive: true })
  writeFileSync(outHtml, html, 'utf8')

  execFileSync(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=4000',
      `--print-to-pdf=${outPdf}`,
      pathToFileURL(outHtml).href,
    ],
    { stdio: 'ignore' },
  )

  return outPdf
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const template = process.argv[2] ?? 'ats'
  const out = resolve(root, process.argv[3] ?? `out/resume.${template}.pdf`)
  const doc = JSON.parse(
    readFileSync(resolve(root, 'fixtures/resume.sample.json'), 'utf8'),
  )
  renderPdf(doc, template, out)
  console.log(`wrote ${out}`)
}
