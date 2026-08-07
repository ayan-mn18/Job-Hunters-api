import { and, desc, eq, inArray } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { huntRunJobs, huntRuns, huntSpecs, type HuntRun, type HuntSpec } from '../../db/schema.js'
import { approveDailyBatch } from '../../hunt/approval.js'
import { discoverForRun, listCandidates } from '../../hunt/discovery/service.js'
import { conflict, notFound } from '../../lib/errors.js'
import { asyncHandler, created, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'

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
    running: ['queued', 'running', 'applying'].includes(row.status),
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

    try {
      const discovery = await discoverForRun(auth.id, run.id)
      const [updated] = await db.select().from(huntRuns).where(eq(huntRuns.id, run.id)).limit(1)
      await recordActivity({
        userId: auth.id,
        kind: 'jobs_scraped',
        text: `Found ${discovery.candidates.length} jobs ready for review.`,
        meta: { runId: run.id, candidates: discovery.candidates.length },
      })
      created(res, {
        ...serializeRun(updated ?? run),
        candidates: discovery.candidates,
        warnings: discovery.warnings,
        sources: discovery.results.map((result) => ({
          portal: result.portal,
          seen: result.seen,
          fresh: result.jobs.length,
          error: result.error ?? null,
        })),
      })
    } catch (error) {
      await db
        .update(huntRuns)
        .set({ status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(huntRuns.id, run.id))
      throw error
    }
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
  '/runs/:id/approve',
  validate({ params: runParamSchema, body: approvalSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof approvalSchema>
    ok(res, await approveDailyBatch(auth.id, pathParam(req, 'id'), body.candidateIds))
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
    const [latest] = await db
      .select()
      .from(huntRuns)
      .where(eq(huntRuns.userId, auth.id))
      .orderBy(desc(huntRuns.createdAt))
      .limit(1)
    const spec = await loadSpec(auth.id)
    const candidates = latest?.status === 'awaiting_approval'
      ? await listCandidates(auth.id, latest.id)
      : []
    ok(res, {
      running: latest ? ['queued', 'running', 'applying'].includes(latest.status) : false,
      awaitingApproval: latest?.status === 'awaiting_approval',
      dailyTarget: spec.dailyTarget,
      currentRun: latest ? serializeRun(latest) : null,
      candidates,
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
