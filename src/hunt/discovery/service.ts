import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  huntCandidates,
  huntRunJobs,
  huntRuns,
  huntSpecs,
  jobSources,
  jobs,
  kits,
  personaSlots,
  resumes,
  userPortals,
  type HuntCandidate,
  type Job,
} from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { readParsedResume } from '../../services/resume-parser.js'
import { rankJob, readWeights, type RankableJob } from '../ranking.js'
import { canonicalise } from './canonicalise.js'
import { ensureDreamCompanyBoards } from './board-resolver.js'
import { planQueries } from './planner.js'
import { connectorsForRun } from './registry.js'
import { blendScore, rerank } from './rerank.js'
import { normaliseProfileSkills } from './extract/profile-skills.js'
import { hashText } from './normalise.js'
import type { AdapterResult, ExperienceRange, NormalisedLocation, RawSalary, ScrapedJob } from './types.js'

const DEFAULT_PORTALS = [
  'greenhouse',
  'ashby',
  'lever',
  'smartrecruiters',
  'workable',
  'remoteok',
  'weworkremotely',
  'remotive',
  'jobicy',
  'arbeitnow',
]

export interface CandidateDto {
  id: string
  jobId: string
  title: string
  company: string
  location: string
  remote: string
  sourcePortal: string
  score: number
  reasons: string[]
  url: string
  applyUrl: string | null
  postedAt: string
  descriptionPreview: string
  skills: string[]
  status: string
}

export function serializeCandidate(candidate: HuntCandidate, job: Job): CandidateDto {
  const locations = job.locations as NormalisedLocation[]
  return {
    id: candidate.id,
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: locations.map((location) => location.raw).filter(Boolean).join('; '),
    remote: job.remoteMode,
    sourcePortal: candidate.sourcePortal,
    score: candidate.score,
    reasons: candidate.reasons,
    url: job.canonicalUrl,
    applyUrl: job.applyUrl,
    postedAt: job.postedAt.toISOString(),
    descriptionPreview: (job.descriptionText ?? '').slice(0, 500),
    skills: job.skills,
    status: candidate.status,
  }
}

/** Builds the scoring view of a stored job row. */
export function rankableFromJob(job: Job, tags: string[] = []): RankableJob {
  return {
    title: job.title,
    company: job.company,
    locations: job.locations as NormalisedLocation[],
    remote: job.remoteMode as RankableJob['remote'],
    skills: job.skills,
    experience: {
      min: job.experienceMin,
      max: job.experienceMax,
      text: job.experienceText,
    },
    descriptionText: job.descriptionText ?? undefined,
    tags,
  }
}

function rankableFromScraped(job: ScrapedJob): RankableJob {
  return {
    title: job.title,
    company: job.company,
    locations: job.locations,
    remote: job.remote,
    skills: job.skills,
    experience: job.experience,
    descriptionText: job.descriptionText,
    tags: job.tags,
  }
}

function jobValues(scraped: ScrapedJob) {
  const descriptionText = scraped.descriptionText?.trim() || null
  const salary: RawSalary = scraped.salary
  const experience: ExperienceRange = scraped.experience
  return {
    fingerprint: scraped.fingerprint,
    title: scraped.title,
    company: scraped.company,
    locations: scraped.locations,
    remoteMode: scraped.remote,
    employmentType: scraped.employmentType,
    descriptionText,
    descriptionHtml: scraped.descriptionHtml ?? null,
    descriptionHash: descriptionText ? hashText(descriptionText) : null,
    canonicalUrl: scraped.url,
    applyUrl: scraped.applyUrl ?? null,
    postedAt: new Date(scraped.postedAt),
    postedAtPrecision: scraped.postedAtPrecision,
    skills: scraped.skills,
    experienceMin: experience.min,
    experienceMax: experience.max,
    experienceText: experience.text,
    salaryMin: salary.min === null ? null : String(salary.min),
    salaryMax: salary.max === null ? null : String(salary.max),
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    salaryText: salary.text,
    responsibilities: scraped.responsibilities,
    extractionMeta: scraped.extractionMeta,
  }
}

/** Rows per statement. Large enough to matter, small enough to stay well
 *  inside Postgres' parameter limit given how wide the jobs table is. */
const PERSIST_CHUNK = 150

/**
 * How many postings reach stage B.
 *
 * Everything above this in the stage-A ranking is what a person could
 * plausibly read; below it, a better ordering changes nothing they will ever
 * see, and each one costs a model call.
 */
const RERANK_SHORTLIST = 120

/**
 * Bulk-upserts scraped jobs and their source rows.
 *
 * One statement per chunk rather than one per job: at fifty jobs the
 * difference was invisible, at several thousand it is the difference between
 * twenty seconds and several minutes, because every statement costs a full
 * round trip to a remote database.
 *
 * Callers must pass a list already deduplicated by fingerprint — Postgres
 * rejects an `ON CONFLICT DO UPDATE` that would touch the same row twice in
 * one statement.
 */
async function persistJobs(scrapedJobs: ScrapedJob[]): Promise<Array<{ scraped: ScrapedJob; job: Job }>> {
  const persisted: Array<{ scraped: ScrapedJob; job: Job }> = []

  for (let offset = 0; offset < scrapedJobs.length; offset += PERSIST_CHUNK) {
    const chunk = scrapedJobs.slice(offset, offset + PERSIST_CHUNK)
    const values = chunk.map(jobValues)

    const rows = await db
      .insert(jobs)
      .values(values)
      .onConflictDoUpdate({
        target: jobs.fingerprint,
        set: {
          title: sql`excluded.title`,
          company: sql`excluded.company`,
          locations: sql`excluded.locations`,
          remoteMode: sql`excluded.remote_mode`,
          employmentType: sql`excluded.employment_type`,
          descriptionText: sql`excluded.description_text`,
          descriptionHtml: sql`excluded.description_html`,
          descriptionHash: sql`excluded.description_hash`,
          canonicalUrl: sql`excluded.canonical_url`,
          applyUrl: sql`excluded.apply_url`,
          postedAt: sql`excluded.posted_at`,
          postedAtPrecision: sql`excluded.posted_at_precision`,
          skills: sql`excluded.skills`,
          experienceMin: sql`excluded.experience_min`,
          experienceMax: sql`excluded.experience_max`,
          experienceText: sql`excluded.experience_text`,
          salaryMin: sql`excluded.salary_min`,
          salaryMax: sql`excluded.salary_max`,
          salaryCurrency: sql`excluded.salary_currency`,
          salaryPeriod: sql`excluded.salary_period`,
          salaryText: sql`excluded.salary_text`,
          responsibilities: sql`excluded.responsibilities`,
          extractionMeta: sql`excluded.extraction_meta`,
          updatedAt: new Date(),
        },
      })
      .returning()

    const byFingerprint = new Map(rows.map((row) => [row.fingerprint, row]))
    const sourceValues: Array<typeof jobSources.$inferInsert> = []
    for (const scraped of chunk) {
      const row = byFingerprint.get(scraped.fingerprint)
      if (!row) continue
      persisted.push({ scraped, job: row })
      sourceValues.push({
        jobId: row.id,
        portalId: scraped.portal,
        sourceId: scraped.sourceId,
        sourceUrl: scraped.url,
        applyUrl: scraped.applyUrl ?? null,
        raw: scraped.raw,
        fetchedAt: new Date(scraped.fetchedAt),
      })
    }

    if (sourceValues.length > 0) {
      await db
        .insert(jobSources)
        .values(sourceValues)
        .onConflictDoUpdate({
          target: [jobSources.portalId, jobSources.sourceId],
          set: {
            jobId: sql`excluded.job_id`,
            sourceUrl: sql`excluded.source_url`,
            applyUrl: sql`excluded.apply_url`,
            raw: sql`excluded.raw`,
            fetchedAt: sql`excluded.fetched_at`,
            updatedAt: new Date(),
          },
        })
    }
  }

  return persisted
}

export async function listCandidates(userId: string, runId: string): Promise<CandidateDto[]> {
  const rows = await db
    .select({ candidate: huntCandidates, job: jobs })
    .from(huntCandidates)
    .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
    .where(and(eq(huntCandidates.userId, userId), eq(huntCandidates.runId, runId)))
    .orderBy(asc(huntCandidates.status), asc(jobs.company))
  return rows
    .sort((left, right) => right.candidate.score - left.candidate.score)
    .map(({ candidate, job }) => serializeCandidate(candidate, job))
}

/**
 * How far back a run looks for postings. Wide by default: a 75% match bar
 * rejects most of what is scraped, so a three-day window left almost nothing
 * to show. Freshness is still visible per job on the dashboard.
 */
const DISCOVERY_WINDOW_HOURS = Number(process.env.DISCOVERY_WINDOW_HOURS ?? 24 * 30)

/**
 * Round-robins across portals so a cap of 50 does not become "the first 50
 * Greenhouse jobs" — variety across sources is the point of running ten of
 * them. Within a portal the newest postings win.
 */
export function balancedSelection(
  results: AdapterResult[],
  target: number,
  perPortalCap: number,
): ScrapedJob[] {
  const queues = results
    .filter((result) => result.jobs.length > 0)
    .map((result) =>
      [...result.jobs]
        .sort((left, right) => Date.parse(right.postedAt) - Date.parse(left.postedAt))
        .slice(0, perPortalCap),
    )
  const picked: ScrapedJob[] = []
  // Aggregators republish each other, so the same posting arrives from several
  // portals. Whichever source we reach first wins.
  const seen = new Set<string>()
  for (let round = 0; picked.length < target; round += 1) {
    let placed = false
    for (const queue of queues) {
      const job = queue[round]
      if (!job) continue
      placed = true
      if (seen.has(job.fingerprint)) continue
      seen.add(job.fingerprint)
      picked.push(job)
      if (picked.length === target) break
    }
    if (!placed) break
  }
  return picked
}

export async function discoverForRun(
  userId: string,
  runId: string,
  options: {
    windowHours?: number
    maxItemsPerPortal?: number
    /** Stop after this many jobs, spread across portals. */
    targetTotal?: number
  } = {},
): Promise<{
  candidates: CandidateDto[]
  results: AdapterResult[]
  warnings: string[]
}> {
  const [[run], [spec], [kit], [baseResume], connected] = await Promise.all([
    db.select().from(huntRuns).where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId))).limit(1),
    db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1),
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db.select().from(resumes).where(and(eq(resumes.userId, userId), eq(resumes.isBase, true))).limit(1),
    db.select({ portalId: userPortals.portalId }).from(userPortals)
      .where(and(eq(userPortals.userId, userId), eq(userPortals.connected, true))),
  ])

  if (!run) throw notFound('Hunt run not found')
  if (!spec) throw badRequest('Save a hunt specification first.')

  const parsed = readParsedResume(baseResume?.parsedProfile)
  const profileSkills = normaliseProfileSkills([...(kit?.skills ?? []), ...(parsed?.skills ?? [])])
  // Applying needs a resume; discovering only needs something to match against.
  // Blocking discovery on the resume meant a user with a filled-in kit could
  // not even see what was out there.
  if (profileSkills.length === 0) {
    throw badRequest('Add skills to your kit or upload a base resume before starting discovery.')
  }
  const portalIds = connected.length > 0 ? connected.map((row) => row.portalId) : DEFAULT_PORTALS

  // The query plan is the part that was missing. Until now `spec.roles` and
  // `spec.locations` only ever reached the *scorer* — the network saw a fixed
  // list of company boards and nothing about what this person wanted.
  // How the user wants to work lives on the persona, not the spec. Without it
  // someone who said "on-site only" still gets remote listings appended.
  const [locationMode] = await db
    .select({ value: personaSlots.value })
    .from(personaSlots)
    .where(and(eq(personaSlots.userId, userId), eq(personaSlots.slot, 'location_mode')))
    .limit(1)
  const remotePreference =
    typeof locationMode?.value === 'string'
      ? (locationMode.value as 'remote' | 'hybrid' | 'onsite' | 'any')
      : 'any'

  const plan = planQueries({
    roles: spec.roles,
    locations: spec.locations,
    dreamCompanies: spec.dreamCompanies,
    homeCity: kit?.city ?? null,
    homeCountry: kit?.country ?? null,
    remotePreference,
  })

  // A dream company is only meaningful if we can actually reach its board.
  const dreams = await ensureDreamCompanyBoards(plan.dreamCompanies).catch(() => ({
    resolved: [] as string[],
    unresolved: [] as string[],
  }))

  const { connectors, skipped } = connectorsForRun({ enabledPortalIds: portalIds })
  if (connectors.length === 0) throw badRequest('Enable at least one supported discovery source.')

  const now = new Date()
  const windowHours = options.windowHours ?? DISCOVERY_WINDOW_HOURS
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000)

  await db
    .update(huntRuns)
    .set({ status: 'running', startedAt: run.startedAt ?? now, progress: { stage: 'discover' }, updatedAt: now })
    .where(eq(huntRuns.id, runId))

  const results = await Promise.all(
    connectors.map((connector) =>
      // No small cap by default. The role gate and the match threshold do the
      // narrowing now, so the scrape's job is to see as much as it can.
      connector.adapter.fetchRecent({
        since,
        now,
        maxItems: options.maxItemsPerPortal ?? 5_000,
        // Search connectors act on these; crawl connectors ignore them.
        queries: plan.queries,
        runId,
      }),
    ),
  )
  for (const result of results) {
    logger.info(
      {
        portal: result.portal,
        seen: result.seen,
        fresh: result.jobs.length,
        detailFetched: result.detailFetched,
        detailFailed: result.detailFailed,
        durationMs: result.durationMs,
        error: result.error ?? null,
      },
      'discovery source finished',
    )
  }

  const warnings = results.flatMap((result) => [
    ...result.warnings.map((warning) => `${result.portal}: ${warning}`),
    ...(result.error ? [`${result.portal}: ${result.error}`] : []),
  ])

  const gathered = options.targetTotal
    ? balancedSelection(results, options.targetTotal, options.maxItemsPerPortal ?? 20)
    : results.flatMap((result) => result.jobs)

  // Dedupe across portals before writing: the same posting reaches us from
  // several aggregators, and a bulk upsert cannot touch one row twice.
  const uniqueByFingerprint = new Map<string, ScrapedJob>()
  for (const scraped of gathered) {
    const existing = uniqueByFingerprint.get(scraped.fingerprint)
    if (!existing || (scraped.descriptionText?.length ?? 0) > (existing.descriptionText?.length ?? 0)) {
      uniqueByFingerprint.set(scraped.fingerprint, scraped)
    }
  }
  const discovered = canonicalise([...uniqueByFingerprint.values()])

  const persisted = await persistJobs(discovered)

  const weights = readWeights(spec.scoreWeights)
  const runJobValues: Array<typeof huntRunJobs.$inferInsert> = []
  const candidateValues: Array<typeof huntCandidates.$inferInsert> = []

  for (const entry of persisted) {
    const ranking = rankJob(rankableFromScraped(entry.scraped), {
      roles: spec.roles,
      locations: spec.locations,
      dreamCompanies: spec.dreamCompanies,
      dealBreakers: spec.dealBreakers,
      skills: profileSkills,
      minMatchScore: spec.minMatchScore,
      maxYearsExperience: kit?.maxYearsExperience ?? 5,
      weights,
    })

    runJobValues.push({
      runId,
      userId,
      jobId: entry.job.id,
      sourcePortal: entry.scraped.portal,
      status: ranking.decision,
      score: ranking.score,
      scoreBreakdown: ranking.breakdown,
      reasons: ranking.reasons,
    })
    if (!ranking.accepted) continue
    candidateValues.push({
      runId,
      userId,
      jobId: entry.job.id,
      sourcePortal: entry.scraped.portal,
      score: ranking.score,
      scoreBreakdown: ranking.breakdown,
      reasons: ranking.reasons,
      status: 'discovered',
    })
  }

  // Stage B. Only the shortlist, because reading a job description costs money
  // and the tail was never going to be shown to anyone.
  const byJobId = new Map(persisted.map((entry) => [entry.job.id, entry]))
  const shortlist = [...candidateValues]
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, RERANK_SHORTLIST)

  const verdicts = await rerank(
    userId,
    {
      roles: spec.roles,
      locations: spec.locations,
      skills: profileSkills,
      maxYearsExperience: kit?.maxYearsExperience ?? 5,
      dealBreakers: spec.dealBreakers,
    },
    shortlist.flatMap((candidate) => {
      const entry = byJobId.get(candidate.jobId)
      if (!entry) return []
      return [
        {
          jobId: candidate.jobId,
          title: entry.job.title,
          company: entry.job.company,
          descriptionText: entry.job.descriptionText,
          descriptionHash: entry.job.descriptionHash,
          baseScore: candidate.score ?? 0,
        },
      ]
    }),
  ).catch((error: unknown) => {
    // Discovery with a slightly worse ordering beats a run that died on the
    // way to a nicer one.
    logger.warn({ err: error, runId }, 'rerank failed; keeping stage-A ordering')
    return new Map<string, { jobId: string; fit: number; rationale: string; whyNot: string | null }>()
  })

  for (const candidate of candidateValues) {
    const verdict = verdicts.get(candidate.jobId)
    if (!verdict) continue
    candidate.score = blendScore(candidate.score ?? 0, verdict.fit)
    candidate.reasons = [
      ...(candidate.reasons ?? []),
      verdict.rationale,
      ...(verdict.whyNot ? [`Watch out: ${verdict.whyNot}`] : []),
    ]
  }
  // Keep the two tables agreeing: the run-jobs row is what the audit view
  // reads, and a candidate scoring 82 while its run-job row says 61 is the
  // kind of discrepancy that costs an afternoon.
  const scoreByJobId = new Map(candidateValues.map((candidate) => [candidate.jobId, candidate]))
  for (const runJob of runJobValues) {
    const updated = scoreByJobId.get(runJob.jobId)
    if (!updated) continue
    runJob.score = updated.score
    runJob.reasons = updated.reasons
  }

  // Chunked for the same reason as the jobs above: a single statement with
  // thousands of rows blows past Postgres' bind-parameter limit.
  for (let offset = 0; offset < runJobValues.length; offset += PERSIST_CHUNK) {
    await db
      .insert(huntRunJobs)
      .values(runJobValues.slice(offset, offset + PERSIST_CHUNK))
      .onConflictDoNothing()
  }
  for (let offset = 0; offset < candidateValues.length; offset += PERSIST_CHUNK) {
    await db
      .insert(huntCandidates)
      .values(candidateValues.slice(offset, offset + PERSIST_CHUNK))
      .onConflictDoNothing()
  }

  const candidates = await listCandidates(userId, runId)
  await db
    .update(huntRuns)
    .set({
      status: 'awaiting_approval',
      jobsScraped: discovered.length,
      // Every job is scored now, so "scored" is no longer a subset of
      // "scraped" that quietly excluded everything rejected by a gate.
      jobsScored: runJobValues.length,
      progress: {
        stage: 'approval',
        candidates: candidates.length,
        // What was actually searched for, so the Hunt screen can answer "why
        // didn't I see X" without anyone reading a log.
        plan: {
          queries: plan.queries.length,
          titles: [...new Set(plan.queries.map((query) => query.keywords))],
          markets: [...new Set(plan.queries.map((query) => query.market))],
          notes: plan.notes,
          dreamCompaniesResolved: dreams.resolved,
          dreamCompaniesUnresolved: dreams.unresolved,
        },
        // Sources that could not run, and what would make them work.
        unavailable: skipped,
        sources: results.map((result) => ({
          portal: result.portal,
          seen: result.seen,
          fresh: result.jobs.length,
          detailFetched: result.detailFetched,
          detailFailed: result.detailFailed,
          durationMs: result.durationMs,
          error: result.error ?? null,
        })),
        warnings,
      },
      updatedAt: new Date(),
    })
    .where(eq(huntRuns.id, runId))

  return { candidates, results, warnings }
}
