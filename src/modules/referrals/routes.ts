import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { referrals, referralSourceEnum, type Referral } from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { createSignedUrl, storageConfigured } from '../../lib/storage.js'
import { localDate, localDateKey } from '../../lib/sql.js'
import { toDayLabel, toLocalDateKey, toLocalTimeLabel, toRelativeLabel } from '../../lib/time.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { generationLimiter } from '../../middleware/rateLimit.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'
import { getReferralDraftGenerator } from '../../services/referral-draft.js'
import {
  beginLinkedInReferralConnection,
  disconnectLinkedInReferrals,
  getLinkedInReferralStatus,
  syncLinkedInReferrals,
} from '../../services/linkedin-referrals.js'

export const referralsRouter: Router = Router()
referralsRouter.use(requireAuth)

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const linkedinConnectSchema = z.object({
  profileUrl: z.string().trim().min(1).max(600),
})
const linkedinSyncSchema = z.object({
  days: z.coerce.number().int().min(1).max(7).default(7),
})

function normalizeLinkedInProfileUrl(value: string): string {
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
    const url = new URL(withProtocol)
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.startsWith('/in/')) {
      throw new Error('wrong host or path')
    }
    return url.toString()
  } catch {
    throw badRequest('Use your LinkedIn profile URL, for example linkedin.com/in/your-name.')
  }
}

const daysQuerySchema = z.object({
  /** How many days back the picker shows. */
  limit: z.coerce.number().int().min(1).max(90).default(14),
})

const listQuerySchema = z.object({
  date: dateSchema.optional(),
  handled: z.enum(['true', 'false', 'all']).default('all'),
  source: z.enum(['linkedin', 'email', 'all']).default('all'),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

const idParamSchema = z.object({ id: z.string().uuid() })

const patchSchema = z.object({
  handled: z.boolean().optional(),
  draft: z.string().max(20_000).optional(),
  matchScore: z.coerce.number().int().min(0).max(100).optional(),
})

const regenerateSchema = z.object({
  /** Optional steer for the generator, e.g. "keep it to three sentences". */
  instructions: z.string().trim().max(1000).optional(),
})

const createSchema = z.object({
  requesterName: z.string().trim().min(1).max(160),
  requesterHeadline: z.string().trim().max(300).optional(),
  requesterAvatar: z.string().trim().max(16).optional(),
  requesterEmail: z.string().trim().email().max(254).optional(),
  requesterProfileUrl: z.string().trim().max(600).optional(),
  source: z.enum(referralSourceEnum.enumValues),
  externalMessageId: z.string().trim().max(300).optional(),
  receivedAt: z.coerce.date().optional(),
  targetRole: z.string().trim().max(200).optional(),
  jobRequisitionId: z.string().trim().max(120).optional(),
  jobDescription: z.string().max(50_000).optional(),
  resumeName: z.string().trim().max(200).optional(),
  resumeUrl: z.string().trim().max(2000).optional(),
  note: z.string().max(20_000).optional(),
  matchScore: z.coerce.number().int().min(0).max(100).optional(),
})

/** Mirrors the `Referral` type in the UI's mock data. */
interface ReferralDto {
  id: string
  name: string
  headline: string
  avatar: string
  source: string
  /** "09:12" in the app timezone — what the card shows. */
  receivedAt: string
  targetRole: string
  jobId: string
  resumeName: string
  note: string
  matchScore: number
  handled: boolean
  draft: string
  receivedAtIso: string
  receivedAtRelative: string
  dateKey: string
  hasResumeFile: boolean
  draftGeneratedAt: string | null
  draftStubbed: boolean
}

function serializeReferral(row: Referral): ReferralDto {
  return {
    id: row.id,
    name: row.requesterName,
    headline: row.requesterHeadline ?? '',
    avatar: row.requesterAvatar,
    source: row.source,
    receivedAt: toLocalTimeLabel(row.receivedAt),
    targetRole: row.targetRole ?? '',
    jobId: row.jobRequisitionId ?? '',
    resumeName: row.resumeName ?? '',
    note: row.note ?? '',
    matchScore: row.matchScore ?? 0,
    handled: row.handled,
    draft: row.draft ?? '',
    receivedAtIso: row.receivedAt.toISOString(),
    receivedAtRelative: toRelativeLabel(row.receivedAt),
    // Which day bucket this row belongs to, matching `/referrals/days`.
    dateKey: toLocalDateKey(row.receivedAt),
    hasResumeFile: Boolean(row.resumeStoragePath),
    draftGeneratedAt: row.draftGeneratedAt?.toISOString() ?? null,
    draftStubbed: row.draftModel === 'stub',
  }
}

referralsRouter.get(
  '/linkedin/status',
  asyncHandler(async (req, res) => {
    ok(res, await getLinkedInReferralStatus(currentUser(req).id))
  }),
)

referralsRouter.post(
  '/linkedin/connect',
  validate({ body: linkedinConnectSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const profileUrl = normalizeLinkedInProfileUrl(String(req.body.profileUrl))
    ok(
      res,
      await beginLinkedInReferralConnection({
        userId: auth.id,
        email: auth.email,
        profileUrl,
      }),
    )
  }),
)

referralsRouter.post(
  '/linkedin/sync',
  validate({ body: linkedinSyncSchema }),
  asyncHandler(async (req, res) => {
    const result = await syncLinkedInReferrals(currentUser(req).id, Number(req.body.days))
    ok(res, result)
  }),
)

referralsRouter.delete(
  '/linkedin/connection',
  asyncHandler(async (req, res) => {
    await disconnectLinkedInReferrals(currentUser(req).id)
    noContent(res)
  }),
)

/**
 * Day buckets for the picker: `{ date, label, linkedin, email }`.
 *
 * Grouped in SQL rather than in JS so the whole history does not have to come
 * over the wire, and converted to APP_TIMEZONE inside the query so a referral
 * that arrived at 00:30 IST lands on the right day rather than the UTC one.
 */
referralsRouter.get(
  '/days',
  validate({ query: daysQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { limit } = validatedQuery<z.infer<typeof daysQuerySchema>>(req)

    const dayExpression = localDateKey(referrals.receivedAt)

    const rows = await db
      .select({
        date: dayExpression,
        linkedin: sql<number>`count(*) filter (where ${referrals.source} = 'linkedin')::int`,
        email: sql<number>`count(*) filter (where ${referrals.source} = 'email')::int`,
        pending: sql<number>`count(*) filter (where ${referrals.handled} = false)::int`,
      })
      .from(referrals)
      .where(eq(referrals.userId, auth.id))
      .groupBy(dayExpression)
      .orderBy(desc(dayExpression))
      .limit(limit)

    const now = new Date()
    ok(
      res,
      rows.map((row) => ({
        date: row.date,
        label: toDayLabel(row.date, now),
        linkedin: row.linkedin,
        email: row.email,
        total: row.linkedin + row.email,
        pending: row.pending,
      })),
    )
  }),
)

referralsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = validatedQuery<z.infer<typeof listQuerySchema>>(req)

    const filters: SQL[] = [eq(referrals.userId, auth.id)]

    if (query.date) {
      filters.push(
        sql`${localDate(referrals.receivedAt)} = ${query.date}::date`,
      )
    }
    if (query.handled !== 'all') {
      filters.push(eq(referrals.handled, query.handled === 'true'))
    }
    if (query.source !== 'all') {
      filters.push(eq(referrals.source, query.source))
    }
    if (query.q) {
      const needle = `%${query.q}%`
      const search = or(
        ilike(referrals.requesterName, needle),
        ilike(referrals.targetRole, needle),
        ilike(referrals.jobRequisitionId, needle),
      )
      if (search) filters.push(search)
    }

    const where = and(...filters)

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(referrals)
        .where(where)
        .orderBy(desc(referrals.receivedAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ value: count() }).from(referrals).where(where),
    ])

    const serialized = rows.map(serializeReferral)

    ok(res, serialized, {
      total: totalRow?.value ?? 0,
      limit: query.limit,
      offset: query.offset,
      pending: serialized.filter((row) => !row.handled).length,
      handled: serialized.filter((row) => row.handled).length,
    })
  }),
)

referralsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const [row] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.id, pathParam(req, 'id')), eq(referrals.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Referral request not found')

    ok(res, {
      ...serializeReferral(row),
      requesterEmail: row.requesterEmail,
      requesterProfileUrl: row.requesterProfileUrl,
      jobDescription: row.jobDescription,
      resumeUrl: row.resumeUrl,
      handledAt: row.handledAt?.toISOString() ?? null,
    })
  }),
)

/** Signed link to the resume the requester attached. */
referralsRouter.get(
  '/:id/resume',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const [row] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.id, pathParam(req, 'id')), eq(referrals.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Referral request not found')

    // Some requests arrive as a link rather than a file. Hand that back as-is.
    if (!row.resumeStoragePath) {
      if (row.resumeUrl) return ok(res, { url: row.resumeUrl, fileName: row.resumeName, external: true })
      throw notFound('No resume was attached to this request.')
    }
    if (!storageConfigured()) throw notFound('Storage is not configured.')

    ok(res, {
      url: await createSignedUrl(row.resumeStoragePath),
      fileName: row.resumeName,
      external: false,
    })
  }),
)

/** Mark handled / un-handled, or save an edited draft. */
referralsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: patchSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof patchSchema>

    const [existing] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.id, pathParam(req, 'id')), eq(referrals.userId, auth.id)))
      .limit(1)

    if (!existing) throw notFound('Referral request not found')

    const patch: Partial<Referral> = { updatedAt: new Date() }
    if (body.handled !== undefined) {
      patch.handled = body.handled
      patch.handledAt = body.handled ? new Date() : null
    }
    if (body.draft !== undefined) {
      patch.draft = body.draft
      // An edited draft is the user's words now, not the model's.
      patch.draftModel = 'user'
      patch.draftGeneratedAt = new Date()
    }
    if (body.matchScore !== undefined) patch.matchScore = body.matchScore

    const [row] = await db
      .update(referrals)
      .set(patch)
      .where(eq(referrals.id, existing.id))
      .returning()

    if (!row) throw notFound('Referral request not found')

    if (body.handled === true && !existing.handled) {
      await recordActivity({
        userId: auth.id,
        kind: 'referral_handled',
        text: `Referred ${row.requesterName}`,
        meta: { referralId: row.id },
      })
    }

    ok(res, serializeReferral(row))
  }),
)

/**
 * Regenerate the recommendation.
 *
 * STUBBED: the generator assembles a template from the facts on the row. It
 * will not read the attached resume or the job description until the real one
 * is registered — see src/services/referral-draft.ts. The response flags this
 * with `stubbed: true` so the UI can badge it rather than pass it off as
 * finished writing.
 */
referralsRouter.post(
  '/:id/draft',
  generationLimiter,
  validate({ params: idParamSchema, body: regenerateSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { instructions } = req.body as z.infer<typeof regenerateSchema>

    const [row] = await db
      .select()
      .from(referrals)
      .where(and(eq(referrals.id, pathParam(req, 'id')), eq(referrals.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Referral request not found')

    const generator = getReferralDraftGenerator()
    const draft = await generator.generate({
      referralId: row.id,
      requesterName: row.requesterName,
      requesterHeadline: row.requesterHeadline,
      targetRole: row.targetRole,
      jobRequisitionId: row.jobRequisitionId,
      jobDescription: row.jobDescription,
      note: row.note,
      resumeName: row.resumeName,
      // TODO(parser-workstream): pass the extracted text of the attached
      // resume here once the parser can be pointed at an arbitrary object.
      resumeText: null,
      referrerName: auth.name,
      instructions: instructions ?? null,
    })

    const [updated] = await db
      .update(referrals)
      .set({
        draft: draft.text,
        draftModel: draft.model,
        draftGeneratedAt: draft.generatedAt,
        updatedAt: new Date(),
      })
      .where(eq(referrals.id, row.id))
      .returning()

    ok(res, {
      ...serializeReferral(updated ?? row),
      stubbed: !generator.isReal,
    })
  }),
)

/**
 * Create a referral request.
 *
 * The inbox sweep (Gmail + LinkedIn DMs) is another workstream; this is the
 * endpoint it will post into, and what the seed script uses.
 * TODO(inbox-workstream): needs a service credential rather than a user JWT,
 * and the `externalMessageId` unique index is what makes the sweep idempotent.
 */
referralsRouter.post(
  '/',
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof createSchema>

    const [row] = await db
      .insert(referrals)
      .values({
        userId: auth.id,
        requesterName: body.requesterName,
        requesterHeadline: body.requesterHeadline ?? null,
        requesterAvatar: body.requesterAvatar ?? '🙂',
        requesterEmail: body.requesterEmail ?? null,
        requesterProfileUrl: body.requesterProfileUrl ?? null,
        source: body.source,
        externalMessageId: body.externalMessageId ?? null,
        receivedAt: body.receivedAt ?? new Date(),
        targetRole: body.targetRole ?? null,
        jobRequisitionId: body.jobRequisitionId ?? null,
        jobDescription: body.jobDescription ?? null,
        resumeName: body.resumeName ?? null,
        resumeUrl: body.resumeUrl ?? null,
        note: body.note ?? null,
        matchScore: body.matchScore ?? null,
      })
      .returning()

    if (!row) throw new Error('Referral insert returned no row')

    await recordActivity({
      userId: auth.id,
      kind: 'referral_received',
      text: `${row.requesterName} asked for a referral`,
      meta: { referralId: row.id },
    })

    created(res, serializeReferral(row))
  }),
)
