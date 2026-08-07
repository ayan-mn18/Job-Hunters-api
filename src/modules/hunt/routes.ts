import { and, desc, eq, inArray } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { huntRuns, huntSpecs, resumes, userPortals, type HuntRun, type HuntSpec } from '../../db/schema.js'
import { conflict, notFound } from '../../lib/errors.js'
import { asyncHandler, created, ok } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'
import { getHuntQueue } from '../../services/hunt-queue.js'

export const huntRouter: Router = Router()
huntRouter.use(requireAuth)

/**
 * The Hunt screen types these as comma-separated strings in one text input.
 * The API accepts either that string or a proper array, and always returns
 * both — `roles` (array, canonical) and `rolesText` (the string the input
 * needs). That way the UI can migrate its inputs whenever it likes without a
 * coordinated release.
 */
const listInput = z.union([
  z.array(z.string().trim().min(1).max(200)).max(100),
  z.string().max(2000),
])

function toList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

const updateSpecSchema = z.object({
  roles: listInput.optional(),
  dreamCompanies: listInput.optional(),
  locations: listInput.optional(),
  dealBreakers: listInput.optional(),
  minMatchScore: z.coerce.number().int().min(0).max(100).optional(),
  dailyTarget: z.coerce.number().int().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
})

const startSchema = z.object({
  /** Override the spec's daily target for this run only. */
  targetApplications: z.coerce.number().int().min(1).max(500).optional(),
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

interface HuntRunDto {
  id: string
  status: string
  running: boolean
  targetApplications: number
  jobsScraped: number
  jobsScored: number
  applicationsSubmitted: number
  progress: unknown
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  stopRequestedAt: string | null
  createdAt: string
}

const ACTIVE_STATUSES = ['queued', 'running'] as const

function serializeRun(row: HuntRun): HuntRunDto {
  return {
    id: row.id,
    status: row.status,
    running: (ACTIVE_STATUSES as readonly string[]).includes(row.status),
    targetApplications: row.targetApplications,
    jobsScraped: row.jobsScraped,
    jobsScored: row.jobsScored,
    applicationsSubmitted: row.applicationsSubmitted,
    progress: row.progress,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    stopRequestedAt: row.stopRequestedAt?.toISOString() ?? null,
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

/* ------------------------------------------------------------------- spec */

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

/* -------------------------------------------------------------------- runs */

/**
 * Starting a hunt records a `hunt_runs` row and hands the id to the queue.
 *
 * STUBBED: the queue is a no-op until the BullMQ worker lands, so the run will
 * sit at `queued` and no applications will appear. The response says so
 * explicitly (`queueStubbed: true`) rather than pretending work is underway.
 * See src/services/hunt-queue.ts.
 */
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

    if (active.length > 0) {
      throw conflict('A hunt is already running. Stop it before starting another.')
    }

    const spec = await loadSpec(auth.id)
    const target = req.body.targetApplications ?? spec.dailyTarget

    const connected = await db
      .select({ portalId: userPortals.portalId })
      .from(userPortals)
      .where(and(eq(userPortals.userId, auth.id), eq(userPortals.connected, true)))

    const [baseResume] = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(and(eq(resumes.userId, auth.id), eq(resumes.isBase, true)))
      .limit(1)

    const [run] = await db
      .insert(huntRuns)
      .values({ userId: auth.id, status: 'queued', targetApplications: target })
      .returning()

    if (!run) throw new Error('Could not create a hunt run')

    const queue = getHuntQueue()
    const { jobId } = await queue.enqueue({
      runId: run.id,
      userId: auth.id,
      targetApplications: target,
      minMatchScore: spec.minMatchScore,
      roles: spec.roles,
      locations: spec.locations,
      dreamCompanies: spec.dreamCompanies,
      dealBreakers: spec.dealBreakers,
      portalIds: connected.map((row) => row.portalId),
      baseResumeId: baseResume?.id ?? null,
    })

    await recordActivity({
      userId: auth.id,
      kind: 'hunt_started',
      text: `Hunty is out — aiming for ${target} applications.`,
      meta: { runId: run.id },
    })

    created(res, {
      ...serializeRun(run),
      jobId,
      queueStubbed: !queue.isReal,
      warnings: [
        ...(connected.length === 0 ? ['No portals are connected, so nothing will be scraped.'] : []),
        ...(baseResume ? [] : ['No base resume is set, so no variants can be tailored.']),
        ...(queue.isReal ? [] : ['The hunt worker is not wired up yet — this run will not execute.']),
      ],
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

    if (!run) throw notFound('No hunt is running.')

    await getHuntQueue().requestStop(run.id)

    // Marked `stopped` immediately rather than waiting for the worker to
    // acknowledge. The user pressed stop; the UI should reflect that. A worker
    // that is mid-application will finish it and then see the flag.
    const [updated] = await db
      .update(huntRuns)
      .set({
        status: 'stopped',
        stopRequestedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(huntRuns.id, run.id))
      .returning()

    await recordActivity({
      userId: auth.id,
      kind: 'hunt_stopped',
      text: 'Called Hunty back home.',
      meta: { runId: run.id },
    })

    ok(res, serializeRun(updated ?? run))
  }),
)

/** What the Hunt screen's control panel polls. */
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
    const queue = getHuntQueue()

    ok(res, {
      running: latest ? (ACTIVE_STATUSES as readonly string[]).includes(latest.status) : false,
      dailyTarget: spec.dailyTarget,
      currentRun: latest ? serializeRun(latest) : null,
      queueStubbed: !queue.isReal,
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
