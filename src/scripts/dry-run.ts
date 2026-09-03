import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { jobs, users } from '../db/schema.js'
import { launchAutomationBrowser } from '../hunt/browser.js'
import { loadPortalProfile } from '../hunt/portal-profile.js'
import { fillForm, submitForm } from '../hunt/apply/fill.js'
import { downloadObject } from '../lib/storage.js'

/**
 * Fills real application forms and submits nothing.
 *
 * The recipes were written against these platforms' documented markup and had
 * never met a live page. This is the harness that finds out — one posting per
 * ATS, a screenshot each, and a report of which fields were filled, which were
 * left unresolved, and why.
 *
 *   npx tsx src/scripts/dry-run.ts <email> [count]
 *
 * Submits nothing: `submitForm` takes `dryRun: true`, and the guard sits
 * immediately before the click rather than at the caller.
 */

const email = process.argv[2] ?? 'demo@jobhunters.test'
const perAts = Number(process.argv[3] ?? 1)

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) {
  console.error(`no user ${email}`)
  process.exit(1)
}

const profile = await loadPortalProfile(user.id)
console.log(`profile: ${profile.fullName} · ${profile.email} · ${profile.phone}`)
console.log(`resume:  ${profile.baseResume.fileName}\n`)

const PLATFORMS = [
  { name: 'greenhouse', pattern: 'greenhouse\\.' },
  { name: 'lever', pattern: 'lever\\.co' },
  { name: 'ashby', pattern: 'ashbyhq\\.' },
]

const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-dryrun-'))
const resumePath = path.join(scratch, profile.baseResume.fileName)
await writeFile(resumePath, await downloadObject(profile.baseResume.storagePath))

const browser = await launchAutomationBrowser()
const report: Array<{
  ats: string
  company: string
  url: string
  recipe: string
  filled: number
  unresolved: number
  detail: string[]
  submitted: boolean
  heldBack: string | undefined
  error?: string
}> = []

try {
  for (const platform of PLATFORMS) {
    const rows = await db
      .select({ company: jobs.company, title: jobs.title, applyUrl: jobs.applyUrl })
      .from(jobs)
      .where(sql`${jobs.applyUrl} ~ ${platform.pattern}`)
      .limit(perAts)

    if (rows.length === 0) {
      console.log(`${platform.name}: no stored job with an apply URL — skipped`)
      continue
    }

    for (const row of rows) {
      const url = row.applyUrl
      if (!url) continue
      const page = await browser.newPage()
      const started = Date.now()
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        const result = await fillForm({
          page,
          url,
          userId: user.id,
          attemptId: `dryrun-${Date.now()}`,
          profile,
          resumePath,
        })
        const submit = await submitForm({ page, url, dryRun: true })

        const shot = path.join(scratch, `${platform.name}-${row.company.replace(/\W+/g, '')}.png`)
        await page.screenshot({ path: shot, fullPage: true })

        // `fields` logs every field seen, including ones deliberately skipped.
        // Counting its length as "filled" would report EEO questions as
        // answered when the whole point is that they are not.
        const actuallyFilled = result.fields.filter((f) => f.filled)
        const skipped = result.fields.filter((f) => !f.filled)

        report.push({
          ats: platform.name,
          company: row.company,
          url,
          recipe: result.recipe,
          filled: actuallyFilled.length,
          unresolved: result.unresolved.length,
          detail: result.unresolved.map((u) => `${u.label} (${u.why})`),
          submitted: submit.submitted,
          heldBack: submit.heldBack,
        })
        console.log(
          `${platform.name.padEnd(11)} ${row.company.padEnd(12)} recipe=${result.recipe.padEnd(10)} ` +
            `filled=${String(actuallyFilled.length).padStart(2)} skipped=${String(skipped.length).padStart(2)} unresolved=${String(result.unresolved.length).padStart(2)} ` +
            `submitted=${submit.submitted} held=${submit.heldBack ?? '-'} ${Date.now() - started}ms`,
        )
        if (actuallyFilled.length > 0) {
          console.log(`             filled: ${actuallyFilled.map((f) => f.label.slice(0, 40)).join(' | ')}`)
        }
        if (skipped.length > 0) {
          console.log(`             skipped: ${skipped.map((f) => f.label.slice(0, 40)).join(' | ')}`)
        }
        for (const u of result.unresolved) console.log(`             unresolved: ${u.label} (${u.why})`)

        // "no submit control" on its own is not actionable. List what buttons
        // the page actually has, so the recipe can be fixed from the report
        // rather than from a second debugging session.
        if (submit.heldBack === 'no_submit_control') {
          const buttons = await page
            .locator('button, input[type="submit"]')
            .evaluateAll((nodes) =>
              nodes
                .slice(0, 12)
                .map((node) => {
                  const el = node as HTMLElement
                  const text = (el.innerText || (el as HTMLInputElement).value || '').trim()
                  return `${text.slice(0, 30) || '(no text)'}${el.offsetParent ? '' : ' [hidden]'}`
                }),
            )
            .catch(() => [] as string[])
          console.log(`             buttons on page: ${buttons.join(' | ') || '(none)'}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report.push({
          ats: platform.name,
          company: row.company,
          url,
          recipe: '-',
          filled: 0,
          unresolved: 0,
          detail: [],
          submitted: false,
          heldBack: undefined,
          error: message,
        })
        console.log(`${platform.name.padEnd(11)} ${row.company.padEnd(12)} ERROR ${message.slice(0, 100)}`)
      } finally {
        await page.close().catch(() => undefined)
      }
    }
  }
} finally {
  await browser.close().catch(() => undefined)
}

const submitted = report.filter((r) => r.submitted).length
console.log('\n=== summary ===')
console.log(`attempts:            ${report.length}`)
console.log(`errored:             ${report.filter((r) => r.error).length}`)
console.log(`fields filled total: ${report.reduce((sum, r) => sum + r.filled, 0)}`)
console.log(`blocked by a field:  ${report.filter((r) => r.unresolved > 0).length}`)
console.log(`ACTUALLY SUBMITTED:  ${submitted}  ${submitted === 0 ? '(correct — dry run)' : '!!! BUG'}`)
console.log(`screenshots in:      ${scratch}`)

// Deliberately leaves the screenshots behind: they are the point.
await closeDatabase()
process.exit(submitted === 0 ? 0 : 1)
