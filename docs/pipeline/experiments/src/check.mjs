/**
 * Parse a rendered resume PDF back to text and score it the way an ATS would.
 *
 *   node src/check.mjs out/resume.ats.pdf
 *
 * Text extraction uses unpdf (a serverless build of Mozilla's pdf.js). pdf.js
 * emits glyph runs in the PDF's own content-stream order, which is exactly the
 * order a naive ATS parser sees — so it is the right lens for this test, not a
 * layout-reconstructing extractor that would paper over the problem.
 *
 * Five checks, each mapping to a real failure mode:
 *
 *   contact      email / phone survive as contiguous strings
 *   headings     section headings match the canonical ATS synonym set
 *   readingOrder document-order anchors appear in that order in the text
 *   attribution  every bullet lands between its own employer and the next one
 *   keywords     share of target skill keywords recoverable from the text
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractText } from 'unpdf'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Heading strings ATS parsers key on, plus common aliases. */
const CANONICAL_HEADINGS = {
  summary: ['summary', 'professional summary', 'profile', 'objective'],
  skills: ['skills', 'core skills', 'technical skills', 'technologies'],
  experience: [
    'experience',
    'work experience',
    'professional experience',
    'employment history',
  ],
  education: ['education', 'academic background'],
}

const norm = (s) =>
  s
    .replace(/ /g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

export async function extractPdfText(pdfPath) {
  const buf = new Uint8Array(readFileSync(pdfPath))
  const { text, totalPages } = await extractText(buf, { mergePages: true })
  return { text: norm(text), pages: totalPages }
}

function indexOfAll(haystack, needle) {
  const out = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

export function score(text, doc) {
  const lower = text.toLowerCase()
  const findings = []

  /* 1. contact ---------------------------------------------------------- */
  const contactBits = [
    ['email', doc.basics.email],
    ['phone', doc.basics.phone],
    ...doc.basics.links.map((l) => [l.label, l.url.replace(/^https?:\/\//, '')]),
  ]
  const contactMisses = contactBits.filter(
    ([, v]) => !lower.includes(v.toLowerCase()),
  )
  findings.push({
    check: 'contact',
    pass: contactMisses.length === 0,
    detail:
      contactMisses.length === 0
        ? `${contactBits.length}/${contactBits.length} contact fields intact`
        : `broken: ${contactMisses.map(([k]) => k).join(', ')}`,
  })

  /* 2. headings --------------------------------------------------------- */
  const headingHits = Object.entries(CANONICAL_HEADINGS).map(([key, aliases]) => {
    const hit = aliases.find((a) => new RegExp(`\\b${a}\\b`, 'i').test(lower))
    return { key, hit: hit ?? null }
  })
  const missingHeadings = headingHits.filter((h) => !h.hit)
  findings.push({
    check: 'headings',
    pass: missingHeadings.length === 0,
    detail:
      missingHeadings.length === 0
        ? headingHits.map((h) => `${h.key}="${h.hit}"`).join(', ')
        : `missing: ${missingHeadings.map((h) => h.key).join(', ')}`,
  })

  /* 3. reading order ---------------------------------------------------- */
  const anchors = [
    ['name', doc.basics.fullName],
    ['summary', doc.summary.text.slice(0, 40)],
    ['job1', doc.experience[0].company],
    ['job1.bullet1', doc.experience[0].bullets[0].text.slice(0, 40)],
    ['job2', doc.experience[1].company],
    ['job2.bullet1', doc.experience[1].bullets[0].text.slice(0, 40)],
    ['education', doc.education[0].institution],
  ]
  const positions = anchors.map(([label, needle]) => ({
    label,
    at: lower.indexOf(needle.toLowerCase()),
  }))
  const notFound = positions.filter((p) => p.at === -1)
  let ordered = true
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].at !== -1 && positions[i].at < positions[i - 1].at) {
      ordered = false
    }
  }
  const asRead = [...positions]
    .filter((p) => p.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((p) => p.label)
  findings.push({
    check: 'readingOrder',
    pass: notFound.length === 0 && ordered,
    detail:
      notFound.length > 0
        ? `not found: ${notFound.map((p) => p.label).join(', ')}`
        : ordered
          ? `${positions.length} anchors in document order`
          : `text order is ${asRead.join(' > ')}, document order is ${anchors.map(([l]) => l).join(' > ')}`,
  })

  /* 4. bullet attribution ------------------------------------------------ */
  const employerAt = doc.experience.map((job) => {
    const hits = indexOfAll(lower, job.company.toLowerCase())
    return { company: job.company, at: hits.length ? hits[hits.length - 1] : -1 }
  })
  const misattributed = []
  doc.experience.forEach((job, i) => {
    const start = employerAt[i].at
    const end = i + 1 < employerAt.length ? employerAt[i + 1].at : lower.length
    for (const bullet of job.bullets) {
      const at = lower.indexOf(bullet.text.slice(0, 45).toLowerCase())
      if (at === -1) misattributed.push(`${job.company}: bullet missing`)
      else if (start === -1 || at < start || at > end)
        misattributed.push(`${job.company}: bullet outside employer block`)
    }
  })
  const totalBullets = doc.experience.reduce((n, j) => n + j.bullets.length, 0)
  findings.push({
    check: 'attribution',
    pass: misattributed.length === 0,
    detail:
      misattributed.length === 0
        ? `${totalBullets}/${totalBullets} bullets inside the right employer block`
        : `${misattributed.length}/${totalBullets} misattributed — ${[...new Set(misattributed)].join('; ')}`,
  })

  /* 5. keyword recovery -------------------------------------------------- */
  const keywords = doc.skills.map((s) => s.name)
  const recovered = keywords.filter((k) => lower.includes(k.toLowerCase()))
  findings.push({
    check: 'keywords',
    pass: recovered.length === keywords.length,
    detail: `${recovered.length}/${keywords.length} recovered${
      recovered.length === keywords.length
        ? ''
        : ` — lost: ${keywords.filter((k) => !recovered.includes(k)).join(', ')}`
    }`,
  })

  /* 6. page artifacts ---------------------------------------------------- */
  // A fixed page header/footer is re-emitted into the content stream on every
  // page, so the parser sees the contact block several times and treats the
  // repeat as body text.
  const nameHits = indexOfAll(lower, doc.basics.fullName.toLowerCase()).length
  const emailHits = indexOfAll(lower, doc.basics.email.toLowerCase()).length
  findings.push({
    check: 'pageArtifacts',
    pass: nameHits === 1 && emailHits === 1,
    detail:
      nameHits === 1 && emailHits === 1
        ? 'no repeated header/footer text'
        : `contact block repeated: name x${nameHits}, email x${emailHits} (running header/footer bleeding into body text)`,
  })

  return {
    pass: findings.every((f) => f.pass),
    findings,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pdfPath = resolve(root, process.argv[2] ?? 'out/resume.ats.pdf')
  const doc = JSON.parse(
    readFileSync(resolve(root, 'fixtures/resume.sample.json'), 'utf8'),
  )
  const { text, pages } = await extractPdfText(pdfPath)
  const result = score(text, doc)

  console.log(`\n${pdfPath}  (${pages} page(s), ${text.length} chars extracted)`)
  for (const f of result.findings) {
    console.log(`  ${f.pass ? 'PASS' : 'FAIL'}  ${f.check.padEnd(13)} ${f.detail}`)
  }
  console.log(`  => ${result.pass ? 'ATS-CLEAN' : 'NOT ATS-CLEAN'}\n`)
  if (process.env.DUMP_TEXT) console.log(text)
  process.exitCode = result.pass ? 0 : 1
}
