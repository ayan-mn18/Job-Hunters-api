import { and, desc, eq } from 'drizzle-orm'
import { hasDatabase } from '../config/env.js'
import { closeDatabase, getDb } from '../db/client.js'
import { huntRunJobs, huntRuns, huntSpecs, jobs, users, type Job } from '../db/schema.js'
import { DISCOVERY_ADAPTERS } from '../hunt/discovery/adapters.js'
import { balancedSelection, discoverForRun } from '../hunt/discovery/service.js'
import type { AdapterResult, ExtractionMeta, NormalisedLocation, ScrapedJob } from '../hunt/discovery/types.js'
import { logger } from '../lib/logger.js'

/**
 * Runs a scrape and reports how complete the result actually is.
 *
 * The point is the fill-rate table: a scraper that returns fifty rows with no
 * salary, no experience and a one-line description is not working, and without
 * this script that failure is invisible until someone opens the dashboard.
 * Numbers below the gate are printed as FAIL rather than quietly rounded up.
 */

interface Options {
  email: string | undefined
  count: number
  windowHours: number
  perPortal: number
  persist: boolean
  portals: string[] | undefined
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index === -1 ? undefined : argv[index + 1]
  }
  return {
    email: get('email'),
    // `--all` keeps everything the sources return, instead of trimming to a
    // balanced sample. That is the mode for a real run; the sample is for
    // measuring extraction quality.
    count: argv.includes('--all') ? 0 : Number(get('count') ?? 50),
    windowHours: Number(get('window') ?? 168),
    perPortal: Number(get('per-portal') ?? 20),
    persist: !argv.includes('--dry'),
    portals: get('portals')?.split(',').map((value) => value.trim()).filter(Boolean),
  }
}

interface Gate {
  label: string
  minimum: number
  test: (job: ReportJob) => boolean
}

/** The shared shape the report reads, from either a live scrape or the DB. */
interface ReportJob {
  portal: string
  title: string
  company: string
  locations: NormalisedLocation[]
  url: string
  postedAt: string
  descriptionText: string
  skills: string[]
  experienceMin: number | null
  experienceMax: number | null
  experienceText: string | null
  responsibilities: string[]
  salaryText: string | null
  salaryMin: number | null
  employmentType: string
  score: number | null
  meta: ExtractionMeta | null
}

const GATES: Gate[] = [
  { label: 'title, company, url, postedAt', minimum: 100, test: (job) => Boolean(job.title && job.company && job.url && job.postedAt) },
  { label: 'description >= 500 chars', minimum: 90, test: (job) => job.descriptionText.length >= 500 },
  { label: 'skills >= 3', minimum: 85, test: (job) => job.skills.length >= 3 },
  { label: 'locations non-empty', minimum: 95, test: (job) => job.locations.some((location) => location.raw.length > 0) },
  { label: 'years of experience', minimum: 60, test: (job) => job.experienceMin !== null || job.experienceMax !== null },
  { label: 'responsibilities >= 3', minimum: 70, test: (job) => job.responsibilities.length >= 3 },
  { label: 'salary present', minimum: 30, test: (job) => job.salaryText !== null || job.salaryMin !== null },
  { label: 'score present', minimum: 100, test: (job) => job.score !== null },
]

function fromScraped(job: ScrapedJob): ReportJob {
  return {
    portal: job.portal,
    title: job.title,
    company: job.company,
    locations: job.locations,
    url: job.url,
    postedAt: job.postedAt,
    descriptionText: job.descriptionText ?? '',
    skills: job.skills,
    experienceMin: job.experience.min,
    experienceMax: job.experience.max,
    experienceText: job.experience.text,
    responsibilities: job.responsibilities,
    salaryText: job.salary.text,
    salaryMin: job.salary.min,
    employmentType: job.employmentType,
    // A dry run does no scoring; the gate is reported as not applicable.
    score: null,
    meta: job.extractionMeta,
  }
}

function fromRow(job: Job, portal: string, score: number | null): ReportJob {
  return {
    portal,
    title: job.title,
    company: job.company,
    locations: job.locations as NormalisedLocation[],
    url: job.canonicalUrl,
    postedAt: job.postedAt.toISOString(),
    descriptionText: job.descriptionText ?? '',
    skills: job.skills,
    experienceMin: job.experienceMin,
    experienceMax: job.experienceMax,
    experienceText: job.experienceText,
    responsibilities: job.responsibilities,
    salaryText: job.salaryText,
    salaryMin: job.salaryMin === null ? null : Number(job.salaryMin),
    employmentType: job.employmentType,
    score,
    meta: job.extractionMeta as ExtractionMeta | null,
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

function printSources(results: AdapterResult[]): void {
  console.log('\nSources')
  console.log(`  ${pad('portal', 18)}${pad('seen', 8)}${pad('fresh', 8)}${pad('detail ok', 11)}${pad('detail err', 12)}${pad('ms', 8)}error`)
  for (const result of [...results].sort((left, right) => right.jobs.length - left.jobs.length)) {
    console.log(
      `  ${pad(result.portal, 18)}${pad(String(result.seen), 8)}${pad(String(result.jobs.length), 8)}` +
        `${pad(String(result.detailFetched), 11)}${pad(String(result.detailFailed), 12)}` +
        `${pad(String(result.durationMs), 8)}${result.error ?? ''}`,
    )
  }
}

function printReport(sample: ReportJob[], scored: boolean): boolean {
  const total = sample.length
  console.log(`\nField completeness over ${total} jobs`)
  console.log(`  ${pad('field', 32)}${pad('filled', 10)}${pad('rate', 9)}${pad('gate', 8)}result`)

  let allPassed = true
  for (const gate of GATES) {
    if (gate.label === 'score present' && !scored) {
      console.log(`  ${pad(gate.label, 32)}${pad('-', 10)}${pad('-', 9)}${pad(`${gate.minimum}%`, 8)}SKIPPED (dry run)`)
      continue
    }
    const filled = sample.filter(gate.test).length
    const rate = total === 0 ? 0 : Math.round((filled / total) * 100)
    const passed = rate >= gate.minimum
    if (!passed) allPassed = false
    console.log(
      `  ${pad(gate.label, 32)}${pad(`${filled}/${total}`, 10)}${pad(`${rate}%`, 9)}${pad(`${gate.minimum}%`, 8)}${passed ? 'PASS' : 'FAIL'}`,
    )
  }

  const portals = new Map<string, number>()
  for (const job of sample) portals.set(job.portal, (portals.get(job.portal) ?? 0) + 1)
  console.log(`\nPortal spread (${portals.size} portals)`)
  for (const [portal, count] of [...portals].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${pad(portal, 18)}${count}`)
  }
  if (portals.size < 4) {
    console.log('  FAIL: fewer than 4 portals contributed')
    allPassed = false
  }

  console.log('\nSamples')
  for (const job of sample.slice(0, 3)) {
    console.log(`\n  ${job.title} — ${job.company} (${job.portal})`)
    console.log(`    location      ${job.locations.map((location) => location.raw).filter(Boolean).join('; ') || '—'}`)
    console.log(`    employment    ${job.employmentType}`)
    console.log(`    experience    ${job.experienceMin ?? '—'}–${job.experienceMax ?? '—'} years  ${job.experienceText ? `("${job.experienceText}")` : ''}`)
    console.log(`    salary        ${job.salaryText ?? '—'}`)
    console.log(`    score         ${job.score ?? '—'}`)
    console.log(`    skills        ${job.skills.slice(0, 10).join(', ') || '—'}`)
    console.log(`    description   ${job.descriptionText.length} chars`)
    console.log(`    responsibilities:`)
    for (const line of job.responsibilities) console.log(`      • ${line}`)
  }

  return allPassed
}

async function dryRun(options: Options): Promise<boolean> {
  const now = new Date()
  const since = new Date(now.getTime() - options.windowHours * 60 * 60 * 1000)
  const adapters = options.portals
    ? DISCOVERY_ADAPTERS.filter((adapter) => options.portals?.includes(adapter.id))
    : DISCOVERY_ADAPTERS
  const results = await Promise.all(
    adapters.map((adapter) => adapter.fetchRecent({ since, now, maxItems: options.perPortal })),
  )
  printSources(results)
  const sample = (
    options.count > 0
      ? balancedSelection(results, options.count, options.perPortal)
      : results.flatMap((result) => result.jobs)
  ).map(fromScraped)
  return printReport(sample, false)
}

async function persistRun(options: Options): Promise<boolean> {
  const db = getDb()
  const [user] = options.email
    ? await db.select().from(users).where(eq(users.email, options.email)).limit(1)
    : await db.select().from(users).orderBy(desc(users.createdAt)).limit(1)
  if (!user) throw new Error(options.email ? `No user with email ${options.email}` : 'No users in the database')

  const [spec] = await db.select().from(huntSpecs).where(eq(huntSpecs.userId, user.id)).limit(1)
  if (!spec) {
    await db.insert(huntSpecs).values({ userId: user.id })
  }

  const [run] = await db
    .insert(huntRuns)
    .values({ userId: user.id, status: 'queued', targetApplications: options.count })
    .returning()
  if (!run) throw new Error('Could not create a hunt run')
  logger.info({ user: user.email, runId: run.id }, 'verification scrape started')

  const started = Date.now()
  const discovery = await discoverForRun(user.id, run.id, {
    windowHours: options.windowHours,
    ...(options.count > 0
      ? { maxItemsPerPortal: options.perPortal, targetTotal: options.count }
      : {}),
  })
  const elapsed = Date.now() - started
  printSources(discovery.results)
  if (discovery.warnings.length > 0) {
    console.log('\nWarnings')
    for (const warning of discovery.warnings) console.log(`  ${warning}`)
  }

  const rows = await db
    .select({ job: jobs, runJob: huntRunJobs })
    .from(huntRunJobs)
    .innerJoin(jobs, eq(huntRunJobs.jobId, jobs.id))
    .where(and(eq(huntRunJobs.runId, run.id), eq(huntRunJobs.userId, user.id)))
  const sample = rows.map(({ job, runJob }) => fromRow(job, runJob.sourcePortal, runJob.score))

  const passed = printReport(sample, true)

  // What the user actually opens the dashboard for: how many strong matches
  // came out of the funnel, by band.
  const bands: Array<[string, (score: number) => boolean]> = [
    ['100%', (score) => score === 100],
    ['90-99%', (score) => score >= 90 && score < 100],
    ['80-89%', (score) => score >= 80 && score < 90],
    ['75-79%', (score) => score >= 75 && score < 80],
    ['under 75%', (score) => score < 75],
  ]
  const scored = sample.map((job) => job.score).filter((score): score is number => score !== null)
  console.log('\nMatch bands')
  for (const [label, test] of bands) {
    const count = scored.filter(test).length
    console.log(`  ${pad(label, 12)}${count}`)
  }
  console.log(`\nStored ${sample.length} jobs on run ${run.id} for ${user.email}`)
  console.log(`Candidates above the ${spec?.minMatchScore ?? 70}% bar: ${discovery.candidates.length}`)
  console.log(`Elapsed: ${(elapsed / 1000).toFixed(1)}s (budget 90s) ${elapsed <= 90_000 ? 'PASS' : 'FAIL'}`)
  return passed && elapsed <= 90_000
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.persist && !hasDatabase) {
    logger.error('DATABASE_URL is not set; re-run with --dry to scrape without storing.')
    process.exit(1)
  }
  const passed = options.persist ? await persistRun(options) : await dryRun(options)
  console.log(`\n${passed ? 'All gates passed.' : 'Some gates failed — see FAIL rows above.'}`)
  if (!passed) process.exitCode = 2
}

main()
  .then(async () => {
    if (hasDatabase) await closeDatabase()
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'verification scrape failed')
    if (hasDatabase) await closeDatabase()
    process.exit(1)
  })
