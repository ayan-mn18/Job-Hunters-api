/**
 * Spike runner. Simulates one 06:00 IST cron sweep.
 *
 *   npm start                 -- last 24h, all adapters
 *   npm start -- --hours 72   -- widen the window
 *   npm start -- --json       -- dump the normalised jobs
 *   npm start -- --portal remoteok
 *
 * In production this file is replaced by a BullMQ worker: same adapters, same
 * context, one repeatable job per portal. See docs/scraping/architecture.md.
 */
import { remoteOkAdapter } from './adapters/remoteok.ts'
import { weWorkRemotelyAdapter } from './adapters/weworkremotely.ts'
import { gulfAtsAdapter } from './adapters/gulf-ats.ts'
import { dedupe } from './normalise.ts'
import { formatIST, windowFor } from './freshness.ts'
import { closeHttp } from './http.ts'
import type { AdapterResult, PortalAdapter, ScrapedJob } from './types.ts'

const ADAPTERS: PortalAdapter[] = [remoteOkAdapter, weWorkRemotelyAdapter, gulfAtsAdapter]

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(`--${name}`)

function bar(n: number, max: number, width = 24): string {
  if (max <= 0) return ''
  return '█'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)))
}

async function main(): Promise<void> {
  const hours = Number(arg('hours') ?? 24)
  const only = arg('portal')
  const { since, now } = windowFor(new Date(), hours)

  const selected = only ? ADAPTERS.filter((a) => a.id === only) : ADAPTERS
  if (selected.length === 0) {
    console.error(`no adapter named "${only}". known: ${ADAPTERS.map((a) => a.id).join(', ')}`)
    process.exitCode = 1
    return
  }

  console.log('┌─ Job Hunters — scrape sweep')
  console.log(`│  run at    ${formatIST(now)} IST  (${now.toISOString()})`)
  console.log(`│  window    last ${hours}h, since ${formatIST(since)} IST`)
  console.log(`│  adapters  ${selected.map((a) => a.id).join(', ')}`)
  console.log('└─')
  console.log()

  const ctx = {
    since,
    now,
    maxItems: 500,
    log: (msg: string) => console.log(`   · ${msg}`),
  }

  // Adapters run in parallel: they hit different hosts, and the per-host lock
  // in http.ts keeps each individual portal politely serialised anyway.
  const results: AdapterResult[] = await Promise.all(
    selected.map((a) =>
      a.fetchRecent(ctx).catch((err): AdapterResult => ({
        portal: a.id,
        seen: 0,
        jobs: [],
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      })),
    ),
  )

  console.log('PER-PORTAL')
  console.log('─'.repeat(78))
  const maxSeen = Math.max(1, ...results.map((r) => r.seen))
  for (const r of results) {
    const a = selected.find((x) => x.id === r.portal)!
    const status = r.error ? 'FAILED' : 'ok'
    console.log(
      `${a.label.padEnd(38)} tier ${a.tier}  ${a.legal.padEnd(19)} ${status}`,
    )
    if (r.error) {
      console.log(`   error: ${r.error}`)
    } else {
      console.log(
        `   saw ${String(r.seen).padStart(4)}  →  ${String(r.jobs.length).padStart(3)} inside ${hours}h  ` +
          `${bar(r.jobs.length, maxSeen)}  ${r.durationMs}ms`,
      )
    }
    for (const w of r.warnings.slice(0, 4)) console.log(`   warn: ${w}`)
    if (r.warnings.length > 4) console.log(`   warn: ...and ${r.warnings.length - 4} more`)
    console.log()
  }

  const all: ScrapedJob[] = results.flatMap((r) => r.jobs)
  const deduped = dedupe(all)
  const collapsed = all.length - deduped.length

  console.log('TOTALS')
  console.log('─'.repeat(78))
  console.log(`  seen across all portals   ${results.reduce((n, r) => n + r.seen, 0)}`)
  console.log(`  inside the ${hours}h window     ${all.length}`)
  console.log(`  after cross-portal dedupe ${deduped.length}  (collapsed ${collapsed})`)

  const byPrecision = new Map<string, number>()
  for (const j of deduped) byPrecision.set(j.postedAtPrecision, (byPrecision.get(j.postedAtPrecision) ?? 0) + 1)
  console.log(
    `  timestamp precision       ${[...byPrecision].map(([k, v]) => `${k}=${v}`).join(' ') || 'n/a'}`,
  )

  const gulf = deduped.filter((j) =>
    j.locations.some((l) => ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'].includes(l.countryCode ?? '')),
  )
  console.log(`  Gulf-located              ${gulf.length}`)
  console.log()

  const dupes = deduped.filter((d) => d.duplicateCount > 1)
  if (dupes.length) {
    console.log('DUPLICATES COLLAPSED')
    console.log('─'.repeat(78))
    for (const d of dupes.slice(0, 8)) {
      const where =
        d.alsoSeenOn.length > 1
          ? `across ${d.alsoSeenOn.join(' + ')}`
          : `${d.duplicateCount}x within ${d.alsoSeenOn[0]}`
      console.log(`  ${d.title} @ ${d.company}  ←  ${where}`)
    }
    console.log()
  }

  console.log(`SAMPLE — newest ${Math.min(8, deduped.length)} of ${deduped.length}`)
  console.log('─'.repeat(78))
  for (const j of deduped.slice(0, 8)) {
    const loc = j.locations.map((l) => l.raw).join(' / ') || '—'
    console.log(`  ${j.postedAt}  [${j.postedAtPrecision}]  ${j.portal}`)
    console.log(`  ${j.title}  @  ${j.company}`)
    console.log(`  ${loc}  ·  ${j.remote}  ·  fp=${j.fingerprint}`)
    console.log(`  ${j.url}`)
    console.log()
  }

  if (deduped.length) {
    console.log('ONE FULL NORMALISED RECORD')
    console.log('─'.repeat(78))
    const s = { ...deduped[0]! } as Record<string, unknown>
    delete s.raw
    if (typeof s.descriptionText === 'string' && s.descriptionText.length > 220) {
      s.descriptionText = `${s.descriptionText.slice(0, 220)}… (${s.descriptionText.length} chars)`
    }
    if (typeof s.descriptionHtml === 'string') {
      s.descriptionHtml = `<${s.descriptionHtml.length} chars of html>`
    }
    console.log(JSON.stringify(s, null, 2))
  }

  if (has('json')) {
    const out = deduped.map((j) => ({ ...j, raw: undefined }))
    console.log('\n--- JSON ---')
    console.log(JSON.stringify(out, null, 2))
  }

  await closeHttp()
}

main().catch(async (err) => {
  console.error(err)
  await closeHttp()
  process.exitCode = 1
})
