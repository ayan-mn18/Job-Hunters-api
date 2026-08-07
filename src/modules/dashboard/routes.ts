import { and, count, desc, eq, gte, lte, or, sql } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import {
  activityEvents,
  applications,
  huntSpecs,
  huntCandidates,
  huntRunJobs,
  huntRuns,
  jobSources,
  jobs,
  referrals,
  userPortals,
} from '../../db/schema.js'
import { asyncHandler, ok } from '../../lib/http.js'
import { localDate, localDateKey, todayLocal } from '../../lib/sql.js'
import { computeStreak, toRelativeLabel } from '../../lib/time.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate, validatedQuery } from '../../middleware/validate.js'

export const dashboardRouter: Router = Router()
dashboardRouter.use(requireAuth)

const querySchema = z.object({
  activityLimit: z.coerce.number().int().min(1).max(50).default(8),
  recentApplications: z.coerce.number().int().min(1).max(20).default(4),
})

const jobsQuerySchema = z.object({
  runId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

/**
 * Everything the Den screen shows, in one round trip.
 *
 * It is one endpoint rather than six because the screen renders all of it at
 * once — six requests would just mean six chances to render half a dashboard.
 * The queries fan out in parallel below.
 */
dashboardRouter.get(
  '/',
  validate({ query: querySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof querySchema>>(req)

    // "Today" means today in APP_TIMEZONE, not UTC — otherwise the counter
    // resets at 05:30 IST and the user watches their progress vanish.
    const appliedLocalDate = localDate(applications.appliedAt)
    const today = todayLocal()
    const appliedDayKey = localDateKey(applications.appliedAt)

    const [
      [appliedTodayRow],
      statusCounts,
      [portalRow],
      [pendingReferralRow],
      [referralsTodayRow],
      activeDays,
      recentApplications,
      activity,
      [specRow],
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(applications)
        .where(and(eq(applications.userId, auth.id), sql`${appliedLocalDate} = ${today}`)),

      db
        .select({ status: applications.status, value: count() })
        .from(applications)
        .where(eq(applications.userId, auth.id))
        .groupBy(applications.status),

      db
        .select({
          jobsFound: sql<number>`coalesce(sum(${userPortals.jobsFound}), 0)::int`,
          connected: sql<number>`count(*)::int`,
        })
        .from(userPortals)
        .where(and(eq(userPortals.userId, auth.id), eq(userPortals.connected, true))),

      db
        .select({ value: count() })
        .from(referrals)
        .where(and(eq(referrals.userId, auth.id), eq(referrals.handled, false))),

      db
        .select({ value: count() })
        .from(referrals)
        .where(
          and(
            eq(referrals.userId, auth.id),
            sql`${localDate(referrals.receivedAt)} = ${today}`,
          ),
        ),

      // Distinct days with at least one application — the streak input.
      db
        .selectDistinct({
          day: appliedDayKey,
        })
        .from(applications)
        .where(and(eq(applications.userId, auth.id), sql`${applications.appliedAt} is not null`))
        .orderBy(desc(appliedDayKey))
        .limit(400),

      db
        .select()
        .from(applications)
        .where(eq(applications.userId, auth.id))
        .orderBy(desc(sql`coalesce(${applications.appliedAt}, ${applications.queuedAt})`))
        .limit(query.recentApplications),

      db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.userId, auth.id))
        .orderBy(desc(activityEvents.createdAt))
        .limit(query.activityLimit),

      db.select().from(huntSpecs).where(eq(huntSpecs.userId, auth.id)).limit(1),
    ])

    const counts: Record<string, number> = {
      queued: 0,
      applied: 0,
      viewed: 0,
      interview: 0,
      rejected: 0,
    }
    for (const row of statusCounts) counts[row.status] = row.value

    const totalApplications = Object.values(counts).reduce((a, b) => a + b, 0)
    const appliedToday = appliedTodayRow?.value ?? 0
    const dailyTarget = specRow?.dailyTarget ?? 50

    const now = new Date()

    ok(res, {
      hunter: {
        name: auth.name,
        avatar: auth.avatar,
        // The user's own headline lives on the kit; the Den only needs a name.
        streakDays: computeStreak(
          activeDays.map((row) => row.day),
          now,
        ),
        dailyTarget,
        appliedToday,
        remainingToday: Math.max(0, dailyTarget - appliedToday),
      },
      stats: {
        appliedToday,
        totalApplications,
        jobsScraped: portalRow?.jobsFound ?? 0,
        portalsConnected: portalRow?.connected ?? 0,
        interviews: counts.interview ?? 0,
        viewed: counts.viewed ?? 0,
        queued: counts.queued ?? 0,
        rejected: counts.rejected ?? 0,
        referralsWaiting: pendingReferralRow?.value ?? 0,
        referralsToday: referralsTodayRow?.value ?? 0,
      },
      recentApplications: recentApplications.map((row) => ({
        id: row.id,
        role: row.role,
        company: row.company,
        logo: row.logo,
        location: row.location ?? '',
        matchScore: row.matchScore ?? 0,
        status: row.status,
        appliedAt:
          row.status === 'queued'
            ? 'in queue'
            : toRelativeLabel(row.appliedAt ?? row.createdAt, now),
      })),
      // "Hunty's trail" — matches the `activity` export in the UI's mock data.
      activity: activity.map((row) => ({
        id: row.id,
        emoji: row.emoji,
        text: row.text,
        time: toRelativeLabel(row.createdAt, now),
        at: row.createdAt.toISOString(),
        kind: row.kind,
        meta: row.meta,
      })),
    })
  }),
)

/** The feed on its own, for a "load more" on the Den screen. */
dashboardRouter.get(
  '/activity',
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { limit, offset } = validatedQuery<{ limit: number; offset: number }>(req)

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.userId, auth.id))
        .orderBy(desc(activityEvents.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(activityEvents).where(eq(activityEvents.userId, auth.id)),
    ])

    const now = new Date()
    ok(
      res,
      rows.map((row) => ({
        id: row.id,
        emoji: row.emoji,
        text: row.text,
        time: toRelativeLabel(row.createdAt, now),
        at: row.createdAt.toISOString(),
        kind: row.kind,
        meta: row.meta,
      })),
      { total: totalRow?.value ?? 0, limit, offset },
    )
  }),
)

dashboardRouter.get(
  '/jobs',
  validate({ query: jobsQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof jobsQuerySchema>>(req)
    const runWhere = query.runId
      ? and(eq(huntRuns.id, query.runId), eq(huntRuns.userId, auth.id))
      : eq(huntRuns.userId, auth.id)
    const [run] = await db
      .select()
      .from(huntRuns)
      .where(runWhere)
      .orderBy(desc(huntRuns.createdAt))
      .limit(1)

    if (!run) {
      ok(res, { run: null, counts: { all: 0 }, portals: {}, items: [], historical: false })
      return
    }

    const detailed = await db
      .select({ runJob: huntRunJobs, job: jobs, candidateStatus: huntCandidates.status })
      .from(huntRunJobs)
      .innerJoin(jobs, eq(huntRunJobs.jobId, jobs.id))
      .leftJoin(
        huntCandidates,
        and(eq(huntCandidates.runId, huntRunJobs.runId), eq(huntCandidates.jobId, huntRunJobs.jobId)),
      )
      .where(and(eq(huntRunJobs.runId, run.id), eq(huntRunJobs.userId, auth.id)))
      .orderBy(desc(huntRunJobs.score), desc(jobs.postedAt))
      .limit(query.limit)

    let historical = false
    let items = detailed.map(({ runJob, job, candidateStatus }) => ({
      id: runJob.id,
      jobId: job.id,
      title: job.title,
      company: job.company,
      locations: job.locations,
      remote: job.remoteMode,
      sourcePortal: runJob.sourcePortal,
      status: runJob.status,
      candidateStatus,
      score: runJob.score,
      reasons: runJob.reasons,
      skills: job.skills,
      descriptionPreview: (job.descriptionText ?? '').slice(0, 600),
      jobUrl: job.canonicalUrl,
      applyUrl: job.applyUrl,
      postedAt: job.postedAt.toISOString(),
      discoveredAt: runJob.discoveredAt.toISOString(),
    }))

    if (items.length === 0) {
      historical = true
      const windowStart = run.startedAt ?? run.createdAt
      const windowEnd = run.finishedAt ?? new Date()
      const fallback = await db
        .select({ job: jobs, source: jobSources })
        .from(jobSources)
        .innerJoin(jobs, eq(jobSources.jobId, jobs.id))
        .where(or(
          and(gte(jobSources.fetchedAt, windowStart), lte(jobSources.fetchedAt, windowEnd)),
          and(gte(jobs.createdAt, windowStart), lte(jobs.createdAt, windowEnd)),
        ))
        .orderBy(desc(jobs.postedAt))
        .limit(query.limit * 2)
      const unique = new Map<string, (typeof fallback)[number]>()
      for (const row of fallback) if (!unique.has(row.job.id)) unique.set(row.job.id, row)
      items = [...unique.values()].slice(0, query.limit).map(({ job, source }) => ({
        id: `historical:${run.id}:${job.id}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        locations: job.locations,
        remote: job.remoteMode,
        sourcePortal: source.portalId,
        status: 'scraped' as const,
        candidateStatus: null,
        score: null,
        reasons: ['Historical run predates detailed status tracking.'],
        skills: job.skills,
        descriptionPreview: (job.descriptionText ?? '').slice(0, 600),
        jobUrl: job.canonicalUrl,
        applyUrl: job.applyUrl,
        postedAt: job.postedAt.toISOString(),
        discoveredAt: source.fetchedAt.toISOString(),
      }))
    }

    const counts: Record<string, number> = { all: items.length }
    const portals: Record<string, number> = {}
    for (const item of items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1
      portals[item.sourcePortal] = (portals[item.sourcePortal] ?? 0) + 1
    }

    ok(res, {
      run: {
        id: run.id,
        status: run.status,
        jobsScraped: run.jobsScraped,
        jobsScored: run.jobsScored,
        applicationsSubmitted: run.applicationsSubmitted,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      counts,
      portals,
      items,
      historical,
    })
  }),
)
