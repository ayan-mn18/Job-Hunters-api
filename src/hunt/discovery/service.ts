import { and, asc, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  huntCandidates,
  huntRunJobs,
  huntRuns,
  huntSpecs,
  jobSources,
  jobs,
  kits,
  resumes,
  userPortals,
  type HuntCandidate,
  type Job,
} from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { readParsedResume } from '../../services/resume-parser.js'
import { rankJob } from '../ranking.js'
import { adaptersFor } from './adapters.js'
import { extractSkills, hashText } from './normalise.js'
import type { AdapterResult, NormalisedLocation, ScrapedJob } from './types.js'

const DEFAULT_PORTALS = [
  'greenhouse',
  'ashby',
  'lever',
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

async function persistJob(scraped: ScrapedJob): Promise<Job> {
  const descriptionText = scraped.descriptionText?.trim() || null
  const values = {
    fingerprint: scraped.fingerprint,
    title: scraped.title,
    company: scraped.company,
    locations: scraped.locations,
    remoteMode: scraped.remote,
    descriptionText,
    descriptionHash: descriptionText ? hashText(descriptionText) : null,
    canonicalUrl: scraped.url,
    applyUrl: scraped.applyUrl ?? null,
    postedAt: new Date(scraped.postedAt),
    postedAtPrecision: scraped.postedAtPrecision,
    skills: extractSkills(`${scraped.title} ${descriptionText ?? ''} ${scraped.tags.join(' ')}`),
  }

  const [row] = await db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.fingerprint,
      set: {
        title: values.title,
        company: values.company,
        locations: values.locations,
        remoteMode: values.remoteMode,
        descriptionText: values.descriptionText,
        descriptionHash: values.descriptionHash,
        canonicalUrl: values.canonicalUrl,
        applyUrl: values.applyUrl,
        postedAt: values.postedAt,
        postedAtPrecision: values.postedAtPrecision,
        skills: values.skills,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error('Could not persist discovered job')

  await db
    .insert(jobSources)
    .values({
      jobId: row.id,
      portalId: scraped.portal,
      sourceId: scraped.sourceId,
      sourceUrl: scraped.url,
      applyUrl: scraped.applyUrl ?? null,
      raw: scraped.raw,
      fetchedAt: new Date(scraped.fetchedAt),
    })
    .onConflictDoUpdate({
      target: [jobSources.portalId, jobSources.sourceId],
      set: {
        jobId: row.id,
        sourceUrl: scraped.url,
        applyUrl: scraped.applyUrl ?? null,
        raw: scraped.raw,
        fetchedAt: new Date(scraped.fetchedAt),
        updatedAt: new Date(),
      },
    })

  return row
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

export async function discoverForRun(userId: string, runId: string): Promise<{
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
  if (!baseResume) throw badRequest('Upload a base resume before starting discovery.')

  const parsed = readParsedResume(baseResume.parsedProfile)
  const profileSkills = [...new Set([...(kit?.skills ?? []), ...(parsed?.skills ?? [])])]
  const portalIds = connected.length > 0 ? connected.map((row) => row.portalId) : DEFAULT_PORTALS
  const adapters = adaptersFor(portalIds)
  if (adapters.length === 0) throw badRequest('Enable at least one supported discovery source.')

  const now = new Date()
  const since = new Date(now.getTime() - 30 * 60 * 60 * 1000)
  const [instahyreWarm] = await db
    .select({ id: jobSources.id })
    .from(jobSources)
    .where(and(eq(jobSources.portalId, 'instahyre'), lt(jobSources.fetchedAt, since)))
    .limit(1)

  await db
    .update(huntRuns)
    .set({ status: 'running', startedAt: run.startedAt ?? now, progress: { stage: 'discover' }, updatedAt: now })
    .where(eq(huntRuns.id, runId))

  const results = await Promise.all(adapters.map((adapter) => adapter.fetchRecent({ since, now, maxItems: 150 })))
  const warnings = results.flatMap((result) => [
    ...result.warnings.map((warning) => `${result.portal}: ${warning}`),
    ...(result.error ? [`${result.portal}: ${result.error}`] : []),
  ])

  let scored = 0
  const discovered = results.flatMap((result) => result.jobs)
  const persisted: Array<{ scraped: ScrapedJob; job: Job }> = []
  for (let offset = 0; offset < discovered.length; offset += 10) {
    const batch = discovered.slice(offset, offset + 10)
    persisted.push(...await Promise.all(batch.map(async (scraped) => ({
      scraped,
      job: await persistJob(scraped),
    }))))
  }

  const seenFingerprints = new Set<string>()
  const runJobValues: Array<typeof huntRunJobs.$inferInsert> = []
  const candidateValues: Array<typeof huntCandidates.$inferInsert> = []
  for (const entry of persisted) {
    if (seenFingerprints.has(entry.job.fingerprint)) continue
    seenFingerprints.add(entry.job.fingerprint)

    if (entry.scraped.postedAtPrecision === 'first-seen' && !instahyreWarm) {
      runJobValues.push({
        runId,
        userId,
        jobId: entry.job.id,
        sourcePortal: entry.scraped.portal,
        status: 'scraped',
        reasons: ['First-seen source warming up; freshness is not trusted yet.'],
      })
      continue
    }

    const ranking = rankJob(entry.scraped, {
      roles: spec.roles,
      locations: spec.locations,
      dreamCompanies: spec.dreamCompanies,
      dealBreakers: spec.dealBreakers,
      skills: profileSkills,
      minMatchScore: spec.minMatchScore,
      maxYearsExperience: kit?.maxYearsExperience ?? 5,
    })
    scored += 1
    const status = ranking.decision
    runJobValues.push({
      runId,
      userId,
      jobId: entry.job.id,
      sourcePortal: entry.scraped.portal,
      status,
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
  if (runJobValues.length > 0) {
    await db.insert(huntRunJobs).values(runJobValues).onConflictDoNothing()
  }
  if (candidateValues.length > 0) {
    await db.insert(huntCandidates).values(candidateValues).onConflictDoNothing()
  }

  const candidates = await listCandidates(userId, runId)
  await db
    .update(huntRuns)
    .set({
      status: 'awaiting_approval',
      jobsScraped: results.reduce((total, result) => total + result.jobs.length, 0),
      jobsScored: scored,
      progress: {
        stage: 'approval',
        candidates: candidates.length,
        sources: results.map((result) => ({
          portal: result.portal,
          seen: result.seen,
          fresh: result.jobs.length,
          error: result.error ?? null,
        })),
        warnings,
      },
      updatedAt: new Date(),
    })
    .where(eq(huntRuns.id, runId))

  return { candidates, results, warnings }
}
