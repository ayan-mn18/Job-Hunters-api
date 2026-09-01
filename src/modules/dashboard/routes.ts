import { and, count, countDistinct, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
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
import { notFound } from '../../lib/errors.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
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

const SCRAPED_JOB_STATUSES = [
  'scraped',
  'eligible',
  'below_threshold',
  'deal_breaker',
  'role_mismatch',
  'experience_mismatch',
  'seniority_mismatch',
  'insufficient_skills',
  'location_mismatch',
  'approved',
  'rejected',
  'queued',
  'tailored',
  'applying',
  'applied',
  'needs_review',
  'failed',
  'closed',
] as const

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const jobsQuerySchema = z
  .object({
    runId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().refine((value) => value === 20 || value === 50, {
      message: 'pageSize must be 20 or 50',
    }).default(20),
    status: z.enum(SCRAPED_JOB_STATUSES).optional(),
    portal: z.string().trim().min(1).max(80).optional(),
    query: z.string().trim().max(120).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxScore: z.coerce.number().int().min(0).max(100).optional(),
    remote: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
    /**
     * "Asks for at most N years." Postings that never state a figure are
     * excluded rather than assumed to qualify — the filter means what it says.
     */
    maxExperience: z.coerce.number().int().min(0).max(50).optional(),
    foundOn: isoDay.optional(),
    postedOn: isoDay.optional(),
  })
  .refine(
    (value) => value.minScore === undefined || value.maxScore === undefined || value.minScore <= value.maxScore,
    { message: 'minScore cannot exceed maxScore', path: ['minScore'] },
  )
const jobDetailQuerySchema = z.object({ runId: z.string().uuid() })
const jobParamSchema = z.object({ jobId: z.string().uuid() })

/**
 * Salary and experience are parsed once, at scrape time, and stored. This used
 * to run a regex over every description on every request — the same answer,
 * recomputed per page view, and unfilterable because it existed only in the
 * response.
 */
function salaryOf(job: {
  salaryText: string | null
  salaryMin: string | null
  salaryMax: string | null
  salaryCurrency: string | null
  salaryPeriod: string | null
}): string | null {
  if (job.salaryText) return job.salaryText
  const min = job.salaryMin === null ? null : Number(job.salaryMin)
  const max = job.salaryMax === null ? null : Number(job.salaryMax)
  if (min === null && max === null) return null
  const format = (value: number): string => Math.round(value).toLocaleString('en-US')
  const body = min !== null && max !== null && min !== max
    ? `${format(min)}–${format(max)}`
    : format((min ?? max) as number)
  return `${job.salaryCurrency ? `${job.salaryCurrency} ` : ''}${body}${job.salaryPeriod ? ` per ${job.salaryPeriod}` : ''}`
}

function experienceOf(job: { experienceMin: number | null; experienceMax: number | null }): string | null {
  const { experienceMin: min, experienceMax: max } = job
  if (min === null && max === null) return null
  const unit = (value: number): string => (value === 1 ? 'year' : 'years')
  if (min !== null && max !== null && min !== max) return `${min}–${max} ${unit(max)}`
  if (min === 0 && max === null) return 'No experience required'
  if (min !== null && max === null) return `${min}+ ${unit(min)}`
  const only = (max ?? min) as number
  return `${only} ${unit(only)}`
}


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

    const emptyPagination = {
      page: query.page,
      pageSize: query.pageSize,
      total: 0,
      totalPages: 0,
    }
    if (!run) {
      ok(res, {
        run: null,
        counts: { all: 0 },
        portals: {},
        items: [],
        historical: false,
        pagination: emptyPagination,
      })
      return
    }

    const search = query.query ? `%${query.query}%` : undefined
    const commonDetailedConditions = [
      eq(huntRunJobs.runId, run.id),
      eq(huntRunJobs.userId, auth.id),
      search
        ? or(
            ilike(jobs.title, search),
            ilike(jobs.company, search),
            sql`${jobs.skills}::text ilike ${search}`,
          )
        : undefined,
      query.minScore !== undefined ? gte(huntRunJobs.score, query.minScore) : undefined,
      query.maxScore !== undefined ? lte(huntRunJobs.score, query.maxScore) : undefined,
      query.remote ? eq(jobs.remoteMode, query.remote) : undefined,
      query.maxExperience !== undefined ? lte(jobs.experienceMin, query.maxExperience) : undefined,
      query.foundOn
        ? sql`${localDate(huntRunJobs.discoveredAt)} = ${query.foundOn}::date`
        : undefined,
      query.postedOn ? sql`${localDate(jobs.postedAt)} = ${query.postedOn}::date` : undefined,
    ]
    const detailedWhere = and(
      ...commonDetailedConditions,
      query.status ? eq(huntRunJobs.status, query.status) : undefined,
      query.portal ? eq(huntRunJobs.sourcePortal, query.portal) : undefined,
    )
    const baseDetailedWhere = and(
      eq(huntRunJobs.runId, run.id),
      eq(huntRunJobs.userId, auth.id),
    )
    const offset = (query.page - 1) * query.pageSize

    let counts: Record<string, number> = { all: 0 }
    let portals: Record<string, number> = {}
    let items: Array<Record<string, unknown>> = []
    let total = 0

    // The status counts double as the "is this run detailed?" check: their sum
    // is the run's row count, so the extra count query this used to run first —
    // serially, before anything else could start — is gone.
    const statusRows = await db
      .select({ status: huntRunJobs.status, value: count() })
      .from(huntRunJobs)
      .where(baseDetailedWhere)
      .groupBy(huntRunJobs.status)
    const detailedRunTotal = statusRows.reduce((sum, row) => sum + Number(row.value), 0)
    const historical = detailedRunTotal === 0

    if (!historical) {
      const [totalRow, portalRows, detailed] = await Promise.all([
        db
          .select({ value: count() })
          .from(huntRunJobs)
          .innerJoin(jobs, eq(huntRunJobs.jobId, jobs.id))
          .where(detailedWhere),
        db
          .select({ portal: huntRunJobs.sourcePortal, value: count() })
          .from(huntRunJobs)
          .where(baseDetailedWhere)
          .groupBy(huntRunJobs.sourcePortal),
        db
          .select({
            runJob: huntRunJobs,
            job: jobs,
            candidateId: huntCandidates.id,
            candidateStatus: huntCandidates.status,
          })
          .from(huntRunJobs)
          .innerJoin(jobs, eq(huntRunJobs.jobId, jobs.id))
          .leftJoin(
            huntCandidates,
            and(
              eq(huntCandidates.runId, huntRunJobs.runId),
              eq(huntCandidates.jobId, huntRunJobs.jobId),
            ),
          )
          .where(detailedWhere)
          .orderBy(desc(huntRunJobs.score), desc(huntRunJobs.discoveredAt))
          .limit(query.pageSize)
          .offset(offset),
      ])
      total = Number(totalRow[0]?.value ?? 0)
      counts = { all: detailedRunTotal }
      for (const row of statusRows) counts[row.status] = Number(row.value)
      portals = Object.fromEntries(portalRows.map((row) => [row.portal, Number(row.value)]))
      items = detailed.map(({ runJob, job, candidateId, candidateStatus }) => ({
        id: runJob.id,
        jobId: job.id,
        candidateId,
        title: job.title,
        company: job.company,
        locations: job.locations,
        remote: job.remoteMode,
        employmentType: job.employmentType,
        sourcePortal: runJob.sourcePortal,
        status: runJob.status,
        candidateStatus,
        score: runJob.score,
        skills: job.skills,
        salary: salaryOf(job),
        experience: experienceOf(job),
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        responsibilities: job.responsibilities,
        jobUrl: job.canonicalUrl,
        postedAt: job.postedAt.toISOString(),
        discoveredAt: runJob.discoveredAt.toISOString(),
      }))
    } else {
      const windowStart = run.startedAt ?? run.createdAt
      const windowEnd = run.finishedAt ?? new Date()
      const windowCondition = or(
        and(gte(jobSources.fetchedAt, windowStart), lte(jobSources.fetchedAt, windowEnd)),
        and(gte(jobs.createdAt, windowStart), lte(jobs.createdAt, windowEnd)),
      )
      const fallbackWhere = and(
        windowCondition,
        search
          ? or(
              ilike(jobs.title, search),
              ilike(jobs.company, search),
              sql`${jobs.skills}::text ilike ${search}`,
            )
          : undefined,
        query.remote ? eq(jobs.remoteMode, query.remote) : undefined,
        query.maxExperience !== undefined ? lte(jobs.experienceMin, query.maxExperience) : undefined,
        query.foundOn ? sql`${localDate(jobSources.fetchedAt)} = ${query.foundOn}::date` : undefined,
        query.postedOn ? sql`${localDate(jobs.postedAt)} = ${query.postedOn}::date` : undefined,
        query.portal ? eq(jobSources.portalId, query.portal) : undefined,
        query.status && query.status !== 'scraped' ? sql`false` : undefined,
        query.minScore !== undefined || query.maxScore !== undefined ? sql`false` : undefined,
      )
      const [totalRows, portalRows, fallback] = await Promise.all([
        db
          .select({ value: countDistinct(jobs.id) })
          .from(jobSources)
          .innerJoin(jobs, eq(jobSources.jobId, jobs.id))
          .where(fallbackWhere),
        db
          .select({ portal: jobSources.portalId, value: countDistinct(jobs.id) })
          .from(jobSources)
          .innerJoin(jobs, eq(jobSources.jobId, jobs.id))
          .where(windowCondition)
          .groupBy(jobSources.portalId),
        db
          .select({
            job: jobs,
            sourcePortal: sql<string>`min(${jobSources.portalId})`,
            discoveredAt: sql<string>`min(${jobSources.fetchedAt})`,
          })
          .from(jobSources)
          .innerJoin(jobs, eq(jobSources.jobId, jobs.id))
          .where(fallbackWhere)
          .groupBy(jobs.id)
          .orderBy(desc(jobs.postedAt))
          .limit(query.pageSize)
          .offset(offset),
      ])
      total = Number(totalRows[0]?.value ?? 0)
      counts = { all: total, scraped: total }
      portals = Object.fromEntries(portalRows.map((row) => [row.portal, Number(row.value)]))
      items = fallback.map(({ job, sourcePortal, discoveredAt }) => ({
        id: `historical:${run.id}:${job.id}`,
        jobId: job.id,
        candidateId: null,
        title: job.title,
        company: job.company,
        locations: job.locations,
        remote: job.remoteMode,
        employmentType: job.employmentType,
        sourcePortal,
        status: 'scraped',
        candidateStatus: null,
        score: null,
        skills: job.skills,
        salary: salaryOf(job),
        experience: experienceOf(job),
        experienceMin: job.experienceMin,
        experienceMax: job.experienceMax,
        responsibilities: job.responsibilities,
        jobUrl: job.canonicalUrl,
        postedAt: job.postedAt.toISOString(),
        discoveredAt: new Date(discoveredAt).toISOString(),
      }))
    }

    ok(res, {
      run: {
        id: run.id,
        status: run.status,
        jobsScraped: run.jobsScraped,
        jobsScored: run.jobsScored,
        applicationsSubmitted: run.applicationsSubmitted,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      counts,
      portals,
      items,
      historical,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      },
    })
  }),
)

dashboardRouter.get(
  '/jobs/:jobId',
  validate({ params: jobParamSchema, query: jobDetailQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof jobDetailQuerySchema>>(req)
    const jobId = pathParam(req, 'jobId')

    // One round trip instead of five. The run, the job, this user's row for it,
    // the candidate and the source it came from are all reachable by join, and
    // the old sequential version paid full network latency for each.
    const [row] = await db
      .select({
        run: huntRuns,
        job: jobs,
        runJob: huntRunJobs,
        candidate: huntCandidates,
        source: jobSources,
      })
      .from(huntRuns)
      .innerJoin(jobs, eq(jobs.id, jobId))
      .leftJoin(
        huntRunJobs,
        and(
          eq(huntRunJobs.runId, huntRuns.id),
          eq(huntRunJobs.jobId, jobs.id),
          eq(huntRunJobs.userId, auth.id),
        ),
      )
      .leftJoin(
        huntCandidates,
        and(eq(huntCandidates.runId, huntRuns.id), eq(huntCandidates.jobId, jobs.id)),
      )
      .leftJoin(jobSources, eq(jobSources.jobId, jobs.id))
      .where(and(eq(huntRuns.id, query.runId), eq(huntRuns.userId, auth.id)))
      // Prefer the source row for the portal this run used, then the newest.
      .orderBy(
        desc(sql`(${jobSources.portalId} is not distinct from ${huntRunJobs.sourcePortal})`),
        desc(jobSources.fetchedAt),
      )
      .limit(1)

    if (!row) throw notFound('Hunt run not found')
    const { run, job, runJob, candidate, source } = row
    if (!runJob && !source) throw notFound('Job was not found in this hunt run')

    ok(res, {
      id: runJob?.id ?? `historical:${run.id}:${job.id}`,
      jobId: job.id,
      candidateId: candidate?.id ?? null,
      title: job.title,
      company: job.company,
      locations: job.locations,
      remote: job.remoteMode,
      employmentType: job.employmentType,
      sourcePortal: runJob?.sourcePortal ?? source?.portalId ?? '',
      status: runJob?.status ?? 'scraped',
      candidateStatus: candidate?.status ?? null,
      score: runJob?.score ?? candidate?.score ?? null,
      scoreBreakdown: runJob?.scoreBreakdown ?? candidate?.scoreBreakdown ?? null,
      reasons: runJob?.reasons ?? candidate?.reasons ?? [],
      skills: job.skills,
      salary: salaryOf(job),
      experience: experienceOf(job),
      experienceMin: job.experienceMin,
      experienceMax: job.experienceMax,
      experienceText: job.experienceText,
      responsibilities: job.responsibilities,
      description: job.descriptionText ?? '',
      descriptionHtml: job.descriptionHtml,
      jobUrl: job.canonicalUrl,
      applyUrl: job.applyUrl ?? source?.applyUrl ?? null,
      postedAt: job.postedAt.toISOString(),
      postedAtPrecision: job.postedAtPrecision,
      discoveredAt: (runJob?.discoveredAt ?? source?.fetchedAt ?? job.createdAt).toISOString(),
    })
  }),
)
