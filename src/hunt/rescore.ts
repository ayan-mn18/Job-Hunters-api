import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  huntCandidates,
  huntRunJobs,
  huntRuns,
  huntSpecs,
  jobs,
  kits,
  resumes,
} from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { readParsedResume } from '../services/resume-parser.js'
import type { NormalisedLocation, ScrapedJob } from './discovery/types.js'
import { rankJob } from './ranking.js'

export async function rescoreHuntRun(userId: string, runId: string) {
  const [[run], [spec], [kit], [baseResume], rows] = await Promise.all([
    db.select().from(huntRuns).where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId))).limit(1),
    db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1),
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db.select().from(resumes).where(and(eq(resumes.userId, userId), eq(resumes.isBase, true))).limit(1),
    db
      .select({ runJob: huntRunJobs, job: jobs })
      .from(huntRunJobs)
      .innerJoin(jobs, eq(huntRunJobs.jobId, jobs.id))
      .where(and(eq(huntRunJobs.runId, runId), eq(huntRunJobs.userId, userId))),
  ])
  if (!run) throw notFound('Hunt run not found')
  if (run.status !== 'awaiting_approval') {
    throw badRequest('Only a run awaiting approval can be re-scored safely.')
  }
  if (!spec) throw badRequest('Save a hunt specification first.')
  if (rows.length === 0) throw badRequest('This run has no detailed jobs to re-score.')

  const parsed = readParsedResume(baseResume?.parsedProfile)
  const profileSkills = [...new Set([...(kit?.skills ?? []), ...(parsed?.skills ?? [])])]
  const candidates: Array<typeof huntCandidates.$inferInsert> = []
  const decisions = rows.map(({ runJob, job }) => {
    const scraped: ScrapedJob = {
      sourceId: job.id,
      portal: runJob.sourcePortal,
      url: job.canonicalUrl,
      applyUrl: job.applyUrl ?? undefined,
      title: job.title,
      company: job.company,
      locations: job.locations as NormalisedLocation[],
      remote: job.remoteMode as ScrapedJob['remote'],
      descriptionText: job.descriptionText ?? undefined,
      tags: job.skills,
      postedAt: job.postedAt.toISOString(),
      postedAtPrecision: job.postedAtPrecision as ScrapedJob['postedAtPrecision'],
      fetchedAt: runJob.discoveredAt.toISOString(),
      fingerprint: job.fingerprint,
    }
    const ranking = rankJob(scraped, {
      roles: spec.roles,
      locations: spec.locations,
      dreamCompanies: spec.dreamCompanies,
      dealBreakers: spec.dealBreakers,
      skills: profileSkills,
      maxYearsExperience: kit?.maxYearsExperience ?? 5,
      minMatchScore: spec.minMatchScore,
    })
    if (ranking.accepted) {
      candidates.push({
        runId,
        userId,
        jobId: job.id,
        sourcePortal: runJob.sourcePortal,
        score: ranking.score,
        scoreBreakdown: ranking.breakdown,
        reasons: ranking.reasons,
        status: 'discovered',
      })
    }
    return { runJob, ranking }
  })

  await db.delete(huntCandidates).where(and(
    eq(huntCandidates.runId, runId),
    eq(huntCandidates.userId, userId),
  ))
  for (let offset = 0; offset < decisions.length; offset += 20) {
    await Promise.all(decisions.slice(offset, offset + 20).map(({ runJob, ranking }) =>
      db
        .update(huntRunJobs)
        .set({
          status: ranking.decision,
          score: ranking.score,
          scoreBreakdown: ranking.breakdown,
          reasons: ranking.reasons,
          updatedAt: new Date(),
        })
        .where(eq(huntRunJobs.id, runJob.id)),
    ))
  }
  if (candidates.length > 0) await db.insert(huntCandidates).values(candidates)

  const counts = decisions.reduce<Record<string, number>>((result, { ranking }) => {
    result[ranking.decision] = (result[ranking.decision] ?? 0) + 1
    return result
  }, { all: decisions.length })
  await db
    .update(huntRuns)
    .set({
      jobsScored: decisions.length,
      progress: { stage: 'approval', candidates: candidates.length, counts, rescoredAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(eq(huntRuns.id, runId))

  return { runId, candidates: candidates.length, counts }
}
