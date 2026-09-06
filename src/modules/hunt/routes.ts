import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import {
  applyAttempts,
  huntCandidates,
  huntRunJobs,
  huntRuns,
  huntSpecs,
  searchQueries,
  type HuntRun,
  type HuntSpec,
} from '../../db/schema.js'
import { approveDailyBatch } from '../../hunt/approval.js'
import { listCandidates } from '../../hunt/discovery/service.js'
import { rescoreHuntRun } from '../../hunt/rescore.js'
import { conflict, notFound } from '../../lib/errors.js'
import { asyncHandler, created, ok, pathParam } from '../../lib/http.js'
import { logger } from '../../lib/logger.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'
import { getHuntQueue } from '../../services/hunt-queue.js'

export const huntRouter: Router = Router()
huntRouter.use(requireAuth)

const listInput = z.union([
  z.array(z.string().trim().min(1).max(200)).max(100),
  z.string().max(2000),
])

function toList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value).split(',').map((part) => part.trim()).filter(Boolean)
}

const updateSpecSchema = z.object({
  roles: listInput.optional(),
  dreamCompanies: listInput.optional(),
  locations: listInput.optional(),
  dealBreakers: listInput.optional(),
  minMatchScore: z.coerce.number().int().min(0).max(100).optional(),
  dailyTarget: z.coerce.number().int().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
})

const startSchema = z.object({
  targetApplications: z.coerce.number().int().min(1).max(100).optional(),
})
const runParamSchema = z.object({ id: z.string().uuid() })
const approvalSchema = z.object({
  candidateIds: z.array(z.string().uuid()).min(1).max(100),
})

interface HuntSpecDto {
  roles: string[]
  rolesText: string
  dreamCompanies: string[]
  dreamCompaniesText: string
  locations: string[]
  locationsText: string
  dealBreakers: string[]
  dealBreakersText: string
  minMatchScore: number
  dailyTarget: number
  isActive: boolean
  updatedAt: string
}

function serializeSpec(row: HuntSpec): HuntSpecDto {
  return {
    roles: row.roles,
    rolesText: row.roles.join(', '),
    dreamCompanies: row.dreamCompanies,
    dreamCompaniesText: row.dreamCompanies.join(', '),
    locations: row.locations,
    locationsText: row.locations.join(', '),
    dealBreakers: row.dealBreakers,
    dealBreakersText: row.dealBreakers.join(', '),
    minMatchScore: row.minMatchScore,
    dailyTarget: row.dailyTarget,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  }
}

const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'applying', 'paused'] as const

function serializeRun(row: HuntRun) {
  return {
    id: row.id,
    status: row.status,
    running: ['queued', 'running'].includes(row.status),
    applying: row.status === 'applying',
    awaitingApproval: row.status === 'awaiting_approval',
    targetApplications: row.targetApplications,
    jobsScraped: row.jobsScraped,
    jobsScored: row.jobsScored,
    candidatesApproved: row.candidatesApproved,
    applicationsSubmitted: row.applicationsSubmitted,
    applicationsNeedsReview: row.applicationsNeedsReview,
    progress: row.progress,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    stopRequestedAt: row.stopRequestedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function loadSpec(userId: string): Promise<HuntSpec> {
  const [row] = await db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1)
  if (row) return row
  const [inserted] = await db.insert(huntSpecs).values({ userId }).returning()
  if (!inserted) throw new Error('Could not create a hunt spec')
  return inserted
}

huntRouter.get(
  '/spec',
  asyncHandler(async (req, res) => {
    ok(res, serializeSpec(await loadSpec(currentUser(req).id)))
  }),
)

huntRouter.put(
  '/spec',
  validate({ body: updateSpecSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await loadSpec(auth.id)
    const body = req.body as z.infer<typeof updateSpecSchema>
    const patch: Partial<HuntSpec> = {}
    const roles = toList(body.roles)
    if (roles) patch.roles = roles
    const companies = toList(body.dreamCompanies)
    if (companies) patch.dreamCompanies = companies
    const locations = toList(body.locations)
    if (locations) patch.locations = locations
    const dealBreakers = toList(body.dealBreakers)
    if (dealBreakers) patch.dealBreakers = dealBreakers
    if (body.minMatchScore !== undefined) patch.minMatchScore = body.minMatchScore
    if (body.dailyTarget !== undefined) patch.dailyTarget = body.dailyTarget
    if (body.isActive !== undefined) patch.isActive = body.isActive

    const [row] = await db
      .update(huntSpecs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(huntSpecs.userId, auth.id))
      .returning()
    if (!row) throw notFound('Hunt spec not found')
    ok(res, serializeSpec(row))
  }),
)

huntRouter.post(
  '/start',
  validate({ body: startSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const active = await db
      .select({ id: huntRuns.id })
      .from(huntRuns)
      .where(and(eq(huntRuns.userId, auth.id), inArray(huntRuns.status, [...ACTIVE_STATUSES])))
      .limit(1)
    if (active.length > 0) throw conflict('A hunt is already active. Stop it before starting another.')

    const spec = await loadSpec(auth.id)
    const target = req.body.targetApplications ?? spec.dailyTarget
    const [run] = await db
      .insert(huntRuns)
      .values({ userId: auth.id, status: 'queued', targetApplications: Math.min(target, 100) })
      .returning()
    if (!run) throw new Error('Could not create a hunt run')

    // Discovery talks to a dozen sources and takes twenty seconds or more, so
    // it does not run here. It used to run as an unheld promise in this
    // handler, which meant a deploy mid-scrape left the run stuck in `running`
    // with nothing to finish it. The run row is created synchronously — so the
    // client immediately has something to poll — and the work is queued.
    const { jobId } = await getHuntQueue().enqueue({
      runId: run.id,
      userId: auth.id,
      targetApplications: run.targetApplications,
      minMatchScore: spec.minMatchScore,
    })
    logger.info({ runId: run.id, jobId }, 'discovery queued')

    created(res, { ...serializeRun(run), candidates: [], warnings: [], sources: [] })
  }),
)

huntRouter.get(
  '/runs/:id/candidates',
  validate({ params: runParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    ok(res, await listCandidates(auth.id, pathParam(req, 'id')))
  }),
)

huntRouter.post(
  '/runs/:id/rescore',
  validate({ params: runParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    ok(res, await rescoreHuntRun(auth.id, pathParam(req, 'id')))
  }),
)

huntRouter.post(
  '/runs/:id/approve',
  validate({ params: runParamSchema, body: approvalSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof approvalSchema>
    ok(res, await approveDailyBatch(auth.id, pathParam(req, 'id'), body.candidateIds))
  }),
)

/**
 * What this run actually searched for.
 *
 * The answer to "why didn't I see the job at X" used to be unavailable to
 * anyone without database access. It is one of three things — the search was
 * never issued, it was issued and returned nothing, or it returned the job and
 * the scorer rejected it — and they need different fixes.
 */
huntRouter.get(
  '/runs/:id/queries',
  validate({ params: runParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const runId = pathParam(req, 'id')

    const [run] = await db
      .select({ id: huntRuns.id, progress: huntRuns.progress })
      .from(huntRuns)
      .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, auth.id)))
      .limit(1)
    if (!run) throw notFound('Hunt run not found')

    const rows = await db
      .select()
      .from(searchQueries)
      .where(eq(searchQueries.runId, runId))
      .orderBy(desc(searchQueries.resultCount))

    const progress = (run.progress ?? {}) as {
      plan?: unknown
      unavailable?: unknown
    }

    ok(res, {
      plan: progress.plan ?? null,
      unavailable: progress.unavailable ?? [],
      queries: rows.map((row) => ({
        connector: row.connectorId,
        query: row.query,
        market: row.market,
        results: row.resultCount,
        durationMs: row.durationMs,
        error: row.error,
      })),
      // Crawl sources issue no queries, so an empty list here is not the same
      // as "nothing was searched".
      note:
        rows.length === 0
          ? 'No keyword searches were issued — only crawl sources ran. Configure a tier-1 search API to search by role and location.'
          : null,
    })
  }),
)

huntRouter.post(
  '/stop',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [run] = await db
      .select()
      .from(huntRuns)
      .where(and(eq(huntRuns.userId, auth.id), inArray(huntRuns.status, [...ACTIVE_STATUSES])))
      .orderBy(desc(huntRuns.createdAt))
      .limit(1)
    if (!run) throw notFound('No hunt is active.')

    // Tell the queue first. A run still waiting is removed outright; one
    // already executing sees the stop flag at its next checkpoint.
    await getHuntQueue().requestStop(run.id)

    const [updated] = await db
      .update(huntRuns)
      .set({ status: 'stopped', stopRequestedAt: new Date(), finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(huntRuns.id, run.id))
      .returning()
    await db
      .update(huntRunJobs)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(and(
        eq(huntRunJobs.runId, run.id),
        inArray(huntRunJobs.status, ['approved', 'queued', 'tailored', 'applying']),
      ))
    await recordActivity({ userId: auth.id, kind: 'hunt_stopped', text: 'Called Hunty back home.', meta: { runId: run.id } })
    ok(res, serializeRun(updated ?? run))
  }),
)

huntRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    // This endpoint is polled while a hunt runs. It used to join and serialise
    // every candidate on each poll, which grew with the run and did the same
    // work repeatedly; the count is what the screen actually shows, and the
    // rows themselves are one request away on /hunt/runs/:id/candidates.
    const [[latest], spec] = await Promise.all([
      db
        .select()
        .from(huntRuns)
        .where(eq(huntRuns.userId, auth.id))
        .orderBy(desc(huntRuns.createdAt))
        .limit(1),
      loadSpec(auth.id),
    ])
    const awaitingApproval = latest?.status === 'awaiting_approval'
    const [candidateCount] = awaitingApproval && latest
      ? await db
          .select({ value: count() })
          .from(huntCandidates)
          .where(and(eq(huntCandidates.runId, latest.id), eq(huntCandidates.userId, auth.id)))
      : [{ value: 0 }]

    // The one attempt actually in front of a browser right now, if any — the
    // live view has nothing to show for a queued or already-finished one.
    const [liveAttempt] = latest?.status === 'applying'
      ? await db
          .select({ id: applyAttempts.id, liveUrl: applyAttempts.liveUrl })
          .from(applyAttempts)
          .innerJoin(huntCandidates, eq(huntCandidates.id, applyAttempts.candidateId))
          .where(and(
            eq(huntCandidates.runId, latest.id),
            eq(applyAttempts.userId, auth.id),
            inArray(applyAttempts.status, ['pending', 'submitting']),
          ))
          .orderBy(desc(applyAttempts.startedAt))
          .limit(1)
      : []

    ok(res, {
      running: latest ? ['queued', 'running'].includes(latest.status) : false,
      applying: latest?.status === 'applying',
      awaitingApproval,
      dailyTarget: spec.dailyTarget,
      currentRun: latest ? serializeRun(latest) : null,
      candidateCount: Number(candidateCount?.value ?? 0),
      liveAttemptId: liveAttempt?.id ?? null,
      // A hosted browser publishes a URL the user can open and click in. When
      // it is null the live view falls back to streamed frames, which is what
      // a locally launched browser can offer.
      liveUrl: liveAttempt?.liveUrl ?? null,
      queueStubbed: false,
    })
  }),
)

huntRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const rows = await db
      .select()
      .from(huntRuns)
      .where(eq(huntRuns.userId, auth.id))
      .orderBy(desc(huntRuns.createdAt))
      .limit(50)
    ok(res, rows.map(serializeRun))
  }),
)
